import { AWD_SWITCH_KEY, AwdAddressSchema, AwdPackageSchema, awdPackagesMissingDimensions, type AwdAddress, type AwdPackageInput } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError, WORKFLOW_KINDS, type WorkflowDefinition, type WriteRunIntent } from '@nova/workflow'
import { Prisma, type AwdInboundOrder } from '@prisma/client'
import { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { AwdApi } from '../connectors/awd-api'
import { toAmazonAddress, toAmazonPackages } from '../importers/awd/packages'
import type { WriteWorkflowDeps } from './workflows'

// 上游仓储入库订单的写操作流程（P2a-08，12.3）：先记录意图 → 调用亚马逊 → 回写结果；崩溃或超时后先向亚马逊对账，查到就沿用，查不到才重新调用。
// 五种动作（CREATE 创建、UPDATE 更新、CONFIRM 确认、CANCEL 取消、TRANSPORT 更新运输信息）共用一个流程，动作写在流程意图里。
// 对账能力不同：
//   - CONFIRM / CANCEL：重新读订单，状态已经是目标状态就算已生效；
//   - UPDATE / TRANSPORT：亚马逊的更新是整体覆盖（PUT），重复调用结果相同，不需要对账；
//   - CREATE：亚马逊没有“列出入库订单”的操作，崩溃发生在“已创建、未回写订单编号”之间时无法找回，重试会再创建一个草稿（草稿超时未确认会自动过期，官方状态 EXPIRED）。已在 CR-031 披露。

export const AWD_ORDER_WRITE = WORKFLOW_KINDS.AWD_ORDER_WRITE
type Intent = WriteRunIntent
type Row = AwdInboundOrder

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const unwrap = (payload: unknown) => record(record(payload).payload ?? payload)
const json = (value: unknown) => (value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue))

/** 订单在亚马逊侧确认后的状态：确认后进入 CONFIRMED（官方文档：as soon as the order is confirmed）；随后的同步会校正为亚马逊实际状态。 */
const CONFIRMED_STATES = ['CONFIRMED', 'VALIDATING', 'CLOSED']

/** draftJson 里等待提交亚马逊的编辑内容在 pending 下（地址、包装、区域、运输信息）；其余是草稿来源信息（补货批次等），写入成功后保留。 */
const pendingOf = (row: Row) => record(record(row.draftJson).pending)
const withoutPending = (row: Row) => {
  const { pending: _pending, ...rest } = record(row.draftJson)
  return Object.keys(rest).length ? json(rest) : Prisma.DbNull
}

/** 订单要提交给亚马逊的内容：编辑中的改动（draftJson）优先，没有则用订单现有字段。缺任何必填项直接判不可重试。 */
export function resolveOrderPayload(row: Row): { address: AwdAddress; packages: AwdPackageInput[]; region: string | null } {
  const draft = pendingOf(row)
  const address = AwdAddressSchema.safeParse(draft.originAddress ?? row.originAddressJson)
  const packages = AwdPackageSchema.array()
    .min(1)
    .safeParse(draft.packages ?? row.packagesJson)
  if (!address.success || !packages.success) throw new NonRetryableError('AWD_ORDER_INCOMPLETE', '订单缺少完整的发货地址或包装，无法提交亚马逊')
  if (awdPackagesMissingDimensions(packages.data) > 0) throw new NonRetryableError('AWD_PACKAGE_DIMENSIONS_MISSING', '提交亚马逊前每个包装都要填写长宽高')
  const region = typeof draft.preferredRegion === 'string' ? draft.preferredRegion : row.preferredRegion
  return { address: address.data, packages: packages.data, region }
}

export function createAwdWorkflow(deps: WriteWorkflowDeps): WorkflowDefinition<Intent> {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const loadOrder = async (tenantId: string, id: string | undefined) => {
    const row = id ? await inTenant(tenantId, () => deps.prisma.awdInboundOrder.findFirst({ where: { id } })) : null
    if (!row) throw new NonRetryableError('AWD_ORDER_NOT_FOUND', '入库订单不存在')
    return row
  }
  const apiFor = async (intent: Intent) =>
    inTenant(intent.tenantId, async () => {
      const connection = await deps.prisma.platformConnection.findFirst({ where: { id: intent.connectionId } })
      if (!connection) throw new NonRetryableError('CONNECTION_NOT_FOUND', '店铺授权不存在，无法调用亚马逊')
      return new AwdApi(new AmazonSpApiClient(connection, deps.secrets, deps.guardFor(intent.tenantId, intent.connectionId)))
    })
  /** 调用亚马逊前再确认一次写入开关（接口受理之后开关可能已被关闭或自动关闭）。 */
  const assertSwitchOn = async (tenantId: string) => {
    const on = await inTenant(tenantId, () => deps.prisma.integrationSwitch.findFirst({ where: { tenantId, switchKey: AWD_SWITCH_KEY, sellerAccountId: null, enabled: true }, select: { id: true } }))
    if (!on) throw new NonRetryableError('SWITCH_DISABLED', '上游仓储入库订单的写入开关已关闭，未向亚马逊发出请求')
  }
  const needOrderId = (row: Row) => {
    if (!row.orderId) throw new NonRetryableError('AWD_ORDER_NOT_SUBMITTED', '订单还没有提交到亚马逊')
    return row.orderId
  }

  async function callAmazon(intent: Intent, row: Row): Promise<Record<string, unknown>> {
    await assertSwitchOn(intent.tenantId)
    const api = await apiFor(intent)
    const action = intent.awdAction
    if (action === 'CREATE') {
      if (row.orderId) return { orderId: row.orderId } // 已经提交过：直接沿用，不再调用
      const { address, packages, region } = resolveOrderPayload(row)
      const created = await api.createOrder({
        externalReferenceId: row.externalReferenceId ?? row.id,
        originAddress: toAmazonAddress(address),
        packagesToInbound: toAmazonPackages(packages),
        ...(region ? { preferences: { destinationRegion: region } } : {}),
      })
      if (!created.orderId) throw new NonRetryableError('AWD_ORDER_ID_NOT_RETURNED', '亚马逊没有返回入库订单编号')
      return { orderId: created.orderId }
    }
    const orderId = needOrderId(row)
    if (action === 'UPDATE') {
      const current = unwrap(await api.getOrder(orderId))
      if (current.orderStatus !== 'DRAFT') throw new NonRetryableError('AWD_ORDER_NOT_DRAFT', '订单已不是草稿状态，不能再修改；请取消后重新创建')
      const { address, packages, region } = resolveOrderPayload(row)
      // 亚马逊的更新是整体覆盖（PUT，请求体是完整订单）：以刚读到的订单为底，只覆盖地址、包装与区域偏好
      await api.updateOrder(orderId, {
        ...current,
        originAddress: toAmazonAddress(address),
        packagesToInbound: toAmazonPackages(packages),
        ...(region ? { preferences: { destinationRegion: region } } : {}),
      })
      return { orderId }
    }
    if (action === 'CONFIRM') await api.confirmOrder(orderId)
    else if (action === 'CANCEL') await api.cancelOrder(orderId)
    else if (action === 'TRANSPORT') {
      const transport = record(pendingOf(row).transport)
      const shipment = await inTenant(intent.tenantId, () =>
        deps.prisma.awdInboundShipment.findFirst({ where: { orderId, sellerAccountId: row.sellerAccountId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'asc' } }),
      )
      if (!shipment) throw new NonRetryableError('AWD_SHIPMENT_NOT_FOUND', '订单还没有对应的入库货件，暂时不能填写运输信息；等亚马逊生成货件后再试')
      if (typeof transport.bookingId !== 'string' || !transport.bookingId) throw new NonRetryableError('AWD_TRANSPORT_MISSING', '缺少预约号或追踪号')
      await api.updateTransport(shipment.shipmentId, { bookingId: transport.bookingId, carrierCode: typeof transport.carrierCode === 'string' ? transport.carrierCode : undefined })
    } else throw new NonRetryableError('AWD_ACTION_UNKNOWN', '不认识的上游仓储操作')
    return { orderId }
  }

  return {
    kind: AWD_ORDER_WRITE,
    steps: [
      {
        name: '向亚马逊执行上游仓储订单操作',
        // 意图只记编号与动作，不含地址与商品明细
        buildRequest: async ctx => {
          const row = await loadOrder(ctx.tenantId, ctx.intent.awdOrderId)
          return { awdOrderId: row.id, action: ctx.intent.awdAction, externalReferenceId: row.externalReferenceId, requestedAt: new Date().toISOString() }
        },
        run: async ctx => callAmazon(ctx.intent, await loadOrder(ctx.tenantId, ctx.intent.awdOrderId)),
        reconcile: async ctx => {
          const row = await loadOrder(ctx.tenantId, ctx.intent.awdOrderId)
          const action = ctx.intent.awdAction
          if (action === 'CREATE') return row.orderId ? { found: true, response: { orderId: row.orderId } } : { found: false }
          if (action !== 'CONFIRM' && action !== 'CANCEL') return { found: false }
          const current = unwrap(await (await apiFor(ctx.intent)).getOrder(needOrderId(row)))
          const done = action === 'CANCEL' ? current.orderStatus === 'CANCELLED' : CONFIRMED_STATES.includes(String(current.orderStatus))
          return done ? { found: true, response: { orderId: row.orderId } } : { found: false }
        },
      },
      {
        name: '回写上游仓储订单',
        run: async ctx => {
          const { orderId } = record(ctx.responseOf(0)) as { orderId: string }
          const row = await loadOrder(ctx.tenantId, ctx.intent.awdOrderId)
          const action = ctx.intent.awdAction
          const base = { orderId, lastErrorCode: null, lastErrorMessage: null, pendingAction: null, draftJson: withoutPending(row), version: { increment: 1 } }
          let data: Prisma.AwdInboundOrderUpdateInput
          if (action === 'CREATE') data = { ...base, status: 'DRAFT' }
          else if (action === 'UPDATE') {
            const { address, packages, region } = resolveOrderPayload(row)
            data = { ...base, originAddressJson: json(address), packagesJson: json(packages), preferredRegion: region }
          } else if (action === 'CONFIRM') data = { ...base, status: 'CONFIRMED' }
          else if (action === 'CANCEL') data = { ...base, status: 'CANCELLED' }
          else data = base
          await inTenant(ctx.tenantId, () => deps.prisma.awdInboundOrder.update({ where: { id: row.id }, data }))
          return { orderId }
        },
      },
    ],
  }
}
