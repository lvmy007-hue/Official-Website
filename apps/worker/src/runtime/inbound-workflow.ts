import { INBOUND_SWITCH_OF_OP, type InboundOp } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError, WORKFLOW_KINDS, type WorkflowDefinition, type WriteRunIntent } from '@nova/workflow'
import { Prisma, type FbaInboundPlan, type InboundOperation } from '@prisma/client'
import { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { InboundApi } from '../connectors/inbound-api'
import type { WriteWorkflowDeps } from './workflows'

// 入仓计划写操作的流程（P2a-12，12.3）：先记录意图 → 调用亚马逊（得到异步操作编号）→ 回写操作编号；崩溃或超时后先向亚马逊对账，查到就沿用，查不到才重新调用。
// 亚马逊的操作是异步的：这里只负责“提交并拿到操作编号”，之后由任务的轮询阶段（connectors/inbound-dispatch.ts）等结果。
// 对账能力：
//   - CREATE_PLAN：按“名称 + 本次请求发出之后创建”在计划列表里找；
//   - CONFIRM_PACKING / CONFIRM_PLACEMENT / CANCEL_PLAN：重新读计划，目标方案已是“已接受”或计划已作废就算已生效；
//   - 其余（生成方案、提交箱内物品、确认运输与时间窗、回填追踪号）：亚马逊侧同样的请求重复提交结果相同或会被明确拒绝，不做对账。

type Intent = WriteRunIntent
const CLOCK_SKEW_MS = 60_000
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const isoDate = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : undefined)

/** 每个操作等待提交的内容：放在 InboundOperation.paramsJson，运输联系人（姓名、电话、邮箱）仅在操作进行期间保留，操作结束后由 scrubContacts 清除。 */
type Params = Record<string, unknown>
const paramsOf = (op: InboundOperation): Params => record(op.paramsJson)

export interface BoxRow {
  boxId: string
  packingGroupId: string | null
  quantity: number
  weightLb: Prisma.Decimal | number
  lengthIn: Prisma.Decimal | number
  widthIn: Prisma.Decimal | number
  heightIn: Prisma.Decimal | number
  contentJson: unknown
}
/** 提交箱内物品信息的请求体：按装箱组分组；只有一个装箱组时箱子不用单独指明。预处理方与贴标方固定为卖家。 */
export function toPackageGroupings(boxes: BoxRow[], groupIds: string[], expiry: Map<string, string | undefined>): unknown[] {
  const grouped = new Map<string, unknown[]>()
  for (const box of boxes) {
    const groupId = box.packingGroupId ?? (groupIds.length === 1 ? groupIds[0] : null)
    if (!groupId) throw new NonRetryableError('INB_BOX_GROUP_MISSING', `箱 ${box.boxId} 没有指定装箱组，无法提交`)
    const items = (Array.isArray(box.contentJson) ? box.contentJson : []).map(item => {
      const row = record(item)
      const sku = String(row.sku)
      return { msku: sku, quantity: Number(row.quantity), labelOwner: 'SELLER', prepOwner: 'SELLER', ...(expiry.get(sku) ? { expiration: expiry.get(sku) } : {}) }
    })
    grouped.set(groupId, [
      ...(grouped.get(groupId) ?? []),
      {
        contentInformationSource: 'BOX_CONTENT_PROVIDED',
        dimensions: { length: Number(box.lengthIn), width: Number(box.widthIn), height: Number(box.heightIn), unitOfMeasurement: 'IN' },
        weight: { value: Number(box.weightLb), unit: 'LB' },
        quantity: box.quantity,
        items,
      },
    ])
  }
  return [...grouped.entries()].map(([packingGroupId, groupBoxes]) => ({ packingGroupId, boxes: groupBoxes }))
}

export function createInboundWorkflow(deps: WriteWorkflowDeps): WorkflowDefinition<Intent> {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const load = async (tenantId: string, id: string | undefined): Promise<{ op: InboundOperation; plan: FbaInboundPlan }> => {
    const op = id ? await inTenant(tenantId, () => deps.prisma.inboundOperation.findFirst({ where: { id } })) : null
    if (!op) throw new NonRetryableError('INB_OPERATION_NOT_FOUND', '入仓操作记录不存在')
    const plan = await inTenant(tenantId, () => deps.prisma.fbaInboundPlan.findFirst({ where: { id: op.planId } }))
    if (!plan) throw new NonRetryableError('INB_PLAN_NOT_FOUND', '入仓计划不存在')
    return { op, plan }
  }
  const apiFor = (intent: Intent) =>
    inTenant(intent.tenantId, async () => {
      const connection = await deps.prisma.platformConnection.findFirst({ where: { id: intent.connectionId } })
      if (!connection) throw new NonRetryableError('CONNECTION_NOT_FOUND', '店铺授权不存在，无法调用亚马逊')
      return new InboundApi(new AmazonSpApiClient(connection, deps.secrets, deps.guardFor(intent.tenantId, intent.connectionId)))
    })
  /** 调用亚马逊前再确认一次写入开关（接口受理之后开关可能已被关闭或自动关闭）；生成类操作不受开关控制。 */
  const assertSwitchOn = async (tenantId: string, operation: InboundOp) => {
    const key = INBOUND_SWITCH_OF_OP[operation]
    if (!key) return
    const on = await inTenant(tenantId, () => deps.prisma.integrationSwitch.findFirst({ where: { tenantId, switchKey: key, sellerAccountId: null, enabled: true }, select: { id: true } }))
    if (!on) throw new NonRetryableError('SWITCH_DISABLED', '这类入仓写入的开关已关闭，未向亚马逊发出请求')
  }
  const needExternal = (plan: FbaInboundPlan) => {
    if (!plan.externalPlanId) throw new NonRetryableError('INB_PLAN_NOT_SUBMITTED', '计划还没有提交到亚马逊')
    return plan.externalPlanId
  }

  async function call(intent: Intent, op: InboundOperation, plan: FbaInboundPlan): Promise<{ operationId: string | null; inboundPlanId?: string }> {
    const operation = op.operation as InboundOp
    await assertSwitchOn(intent.tenantId, operation)
    const api = await apiFor(intent)
    const params = paramsOf(op)
    if (operation === 'CREATE_PLAN') {
      if (plan.externalPlanId) return { operationId: null, inboundPlanId: plan.externalPlanId } // 已经创建过：沿用
      const items = await inTenant(intent.tenantId, () => deps.prisma.inboundPlanItem.findMany({ where: { planId: plan.id }, orderBy: { sku: 'asc' }, take: 500 }))
      if (items.length === 0) throw new NonRetryableError('INB_PLAN_EMPTY', '计划没有商品')
      let address: Record<string, unknown>
      try {
        address = record(JSON.parse(plan.sourceAddress))
      } catch {
        throw new NonRetryableError('INB_ADDRESS_INVALID', '发货地址格式不正确')
      }
      const created = await api.createPlan({
        name: plan.name,
        sourceAddress: address,
        marketplaceIds: [plan.marketplaceId],
        items: items.map(item => ({ msku: item.sku, quantity: item.quantity, expiration: isoDate(item.expiry) })),
      })
      return { operationId: created.operationId, inboundPlanId: created.inboundPlanId }
    }
    const externalId = needExternal(plan)
    const text = (key: string) => {
      const value = params[key]
      if (typeof value !== 'string' || !value) throw new NonRetryableError('INB_PARAM_MISSING', `缺少参数 ${key}`)
      return value
    }
    switch (operation) {
      case 'GENERATE_PACKING':
        return api.generatePacking(externalId)
      case 'CONFIRM_PACKING':
        return api.confirmPacking(externalId, text('optionId'))
      case 'SUBMIT_PACKING_INFO': {
        const boxes = await inTenant(intent.tenantId, () => deps.prisma.inboundBox.findMany({ where: { planId: plan.id }, orderBy: { boxId: 'asc' }, take: 1000 }))
        if (boxes.length === 0) throw new NonRetryableError('INB_BOXES_EMPTY', '还没有箱内物品信息')
        const groups = await inTenant(intent.tenantId, () =>
          deps.prisma.packingGroup.findMany({ where: { planId: plan.id, packingOptionId: plan.selectedPackingOptionId ?? '' }, select: { packingGroupId: true }, take: 200 }),
        )
        const items = await inTenant(intent.tenantId, () => deps.prisma.inboundPlanItem.findMany({ where: { planId: plan.id }, select: { sku: true, expiry: true }, take: 500 }))
        return api.setPackingInformation(
          externalId,
          toPackageGroupings(
            boxes,
            groups.map(group => group.packingGroupId),
            new Map(items.map(item => [item.sku, isoDate(item.expiry)])),
          ),
        )
      }
      case 'GENERATE_PLACEMENT':
        return api.generatePlacement(externalId)
      case 'CONFIRM_PLACEMENT':
        return api.confirmPlacement(externalId, text('optionId'))
      case 'GENERATE_TRANSPORT': {
        const shipments = (Array.isArray(params.shipments) ? params.shipments : []).map(record)
        return api.generateTransport(externalId, {
          placementOptionId: plan.selectedPlacementOptionId ?? text('placementOptionId'),
          shipmentTransportationConfigurations: shipments.map(shipment => ({
            shipmentId: shipment.shipmentId,
            readyToShipWindow: { start: shipment.readyToShipAt },
            contactInformation: shipment.contact,
          })),
        })
      }
      case 'CONFIRM_TRANSPORT': {
        const selections = (Array.isArray(params.selections) ? params.selections : []).map(record)
        return api.confirmTransport(
          externalId,
          selections.map(item => ({ shipmentId: item.shipmentId, transportationOptionId: item.transportOptionId, contactInformation: item.contact })),
        )
      }
      case 'GENERATE_WINDOWS':
        return api.generateWindows(externalId, text('shipmentId'))
      case 'CONFIRM_WINDOW':
        return api.confirmWindow(externalId, text('shipmentId'), text('optionId'))
      case 'UPDATE_TRACKING': {
        const items = (Array.isArray(params.items) ? params.items : []).map(record)
        const detail =
          items.length > 0
            ? { spdTrackingDetail: { spdTrackingItems: items.map(item => ({ boxId: item.boxId, trackingId: item.trackingId })) } }
            : { ltlTrackingDetail: { billOfLadingNumber: text('billOfLadingNumber'), ...(typeof params.freightBillNumber === 'string' ? { freightBillNumber: [params.freightBillNumber] } : {}) } }
        return api.updateTracking(externalId, text('shipmentId'), detail)
      }
      case 'CANCEL_PLAN':
        return api.cancelPlan(externalId)
      default:
        throw new NonRetryableError('INB_OP_UNKNOWN', '不认识的入仓操作')
    }
  }

  return {
    kind: WORKFLOW_KINDS.INBOUND_PLAN_OP,
    steps: [
      {
        name: '向亚马逊提交入仓操作',
        // 意图只记编号与操作类型，不含地址与商品明细
        buildRequest: async ctx => {
          const { op, plan } = await load(ctx.tenantId, ctx.intent.inboundOpId)
          return { inboundOpId: op.id, operation: op.operation, planName: plan.name, requestedAt: new Date().toISOString() }
        },
        run: async ctx => {
          const { op, plan } = await load(ctx.tenantId, ctx.intent.inboundOpId)
          return call(ctx.intent, op, plan)
        },
        reconcile: async ctx => {
          const { op, plan } = await load(ctx.tenantId, ctx.intent.inboundOpId)
          const operation = op.operation as InboundOp
          const api = await apiFor(ctx.intent)
          if (operation === 'CREATE_PLAN') {
            if (plan.externalPlanId) return { found: true, response: { operationId: null, inboundPlanId: plan.externalPlanId } }
            const listed = record(await api.listPlans())
            const plans = (Array.isArray(listed.inboundPlans) ? listed.inboundPlans : []).map(record)
            const since = Date.parse(String(record(ctx.request).requestedAt)) - CLOCK_SKEW_MS
            const hit = plans.find(item => item.name === plan.name && Date.parse(String(item.createdAt)) >= since && typeof item.inboundPlanId === 'string')
            return hit ? { found: true, response: { operationId: null, inboundPlanId: hit.inboundPlanId } } : { found: false }
          }
          if (!plan.externalPlanId) return { found: false }
          if (operation === 'CANCEL_PLAN')
            return String(record(await api.getPlan(plan.externalPlanId)).status).toUpperCase() === 'VOIDED' ? { found: true, response: { operationId: null } } : { found: false }
          if (operation === 'CONFIRM_PACKING' || operation === 'CONFIRM_PLACEMENT') {
            const body = record(await (operation === 'CONFIRM_PACKING' ? api.listPackingOptions(plan.externalPlanId) : api.listPlacementOptions(plan.externalPlanId)))
            const rows = (Array.isArray(body.packingOptions) ? body.packingOptions : Array.isArray(body.placementOptions) ? body.placementOptions : []).map(record)
            const id = paramsOf(op).optionId
            const accepted = rows.some(row => (row.packingOptionId === id || row.placementOptionId === id) && String(row.status).toUpperCase() === 'ACCEPTED')
            return accepted ? { found: true, response: { operationId: null } } : { found: false }
          }
          return { found: false }
        },
      },
      {
        name: '回写入仓操作编号',
        run: async ctx => {
          const result = record(ctx.responseOf(0)) as { operationId: string | null; inboundPlanId?: string }
          const { op, plan } = await load(ctx.tenantId, ctx.intent.inboundOpId)
          await inTenant(ctx.tenantId, () =>
            deps.prisma.$transaction([
              deps.prisma.inboundOperation.update({ where: { id: op.id }, data: { operationId: result.operationId, status: 'IN_PROGRESS', writeRunId: ctx.runId } }),
              ...(result.inboundPlanId && !plan.externalPlanId
                ? [deps.prisma.fbaInboundPlan.update({ where: { id: plan.id }, data: { externalPlanId: result.inboundPlanId, status: 'ACTIVE', sourceUpdatedAt: new Date() } })]
                : []),
            ]),
          )
          return { operationId: result.operationId }
        },
      },
    ],
  }
}
