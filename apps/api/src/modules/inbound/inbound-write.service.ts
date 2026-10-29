import { Injectable } from '@nestjs/common'
import {
  InboundLabelBodySchema,
  InboundOptionBodySchema,
  InboundTrackingBodySchema,
  InboundTransportBodySchema,
  InboundVersionBodySchema,
  InboundWindowBodySchema,
  validateBoxes,
  type InboundActionResponse,
} from '@nova/api-contracts'
import type { FbaInboundPlan } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { INBOUND_WRITE, loadPlan, record } from './inbound-common'
import { InboundDraftService } from './inbound-draft.service'
import { InboundJobsService } from './inbound-jobs.service'

const NOW = () => new Date()
const asItems = (value: unknown) =>
  (Array.isArray(value) ? value : []).map(record).flatMap(item => (typeof item.sku === 'string' && typeof item.quantity === 'number' ? [{ sku: item.sku, quantity: item.quantity }] : []))

// 入仓计划里要调用亚马逊的动作。每个动作：权限 → 连接 → 写入开关（生成方案、资格预检、取标签不受开关控制）→ 状态是否允许 → 内容校验，
// 全部通过才把计划标为“处理中”并交给后台任务；真正的结果以操作记录和计划状态为准。
@Injectable()
export class InboundWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly jobs: InboundJobsService,
    private readonly drafts: InboundDraftService,
  ) {}

  private async open(req: RequestWithContext, id: string) {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    return { context, scope, plan: await loadPlan(this.prisma, context.tenantId, scope, id) }
  }

  async eligibility(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundVersionBodySchema.parse(rawBody)
    return this.jobs.enqueue(req, context, plan, { action: 'ELIGIBILITY', operation: 'ELIGIBILITY', version: body.version, audit: { action: 'FBA_INBOUND_ELIGIBILITY_CHECKED' } })
  }

  /** 提交到亚马逊创建入仓计划：每个 SKU 的最近一次资格预检都必须合格。 */
  async submit(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundVersionBodySchema.parse(rawBody)
    const [items, checks] = await Promise.all([
      this.prisma.inboundPlanItem.findMany({ where: { tenantId: plan.tenantId, planId: plan.id }, select: { sku: true }, take: 500 }),
      this.prisma.inboundEligibilityCheck.findMany({ where: { tenantId: plan.tenantId, planId: plan.id }, orderBy: { checkedAt: 'desc' }, take: 2000 }),
    ])
    if (items.length === 0) throw appError('VALIDATION_FAILED', '计划没有商品，不能提交', { fieldErrors: { items: ['至少添加一个商品'] } })
    const latest = new Map<string, boolean>()
    for (const check of checks) if (!latest.has(check.sku)) latest.set(check.sku, check.eligible)
    const bad = items.filter(item => latest.get(item.sku) !== true).map(item => item.sku)
    if (bad.length > 0) throw appError('CONFLICT', `这些 SKU 没有通过资格预检：${bad.slice(0, 10).join('、')}${bad.length > 10 ? ' 等' : ''}`, { details: { skus: bad.slice(0, 50).join(',') } })
    return this.jobs.enqueue(req, context, plan, { action: 'SUBMIT', operation: 'CREATE_PLAN', version: body.version, audit: { action: 'FBA_INBOUND_PLAN_SUBMITTED' } })
  }

  async packingOptions(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundOptionBodySchema.parse(rawBody)
    if (body.action === 'GENERATE')
      return this.jobs.enqueue(req, context, plan, { action: 'GENERATE_PACKING', operation: 'GENERATE_PACKING', version: body.version, audit: { action: 'FBA_INBOUND_PACKING_GENERATED' } })
    const option = await this.prisma.packingOption.findFirst({ where: { tenantId: plan.tenantId, planId: plan.id, packingOptionId: body.optionId } })
    if (!option || option.status !== 'OFFERED') throw appError('CONFLICT', '这个装箱方案已不可选，请重新生成')
    if (option.expiresAt && option.expiresAt.getTime() <= NOW().getTime()) throw appError('CONFLICT', '这个装箱方案已过期，请重新生成')
    return this.jobs.enqueue(req, context, plan, {
      action: 'CONFIRM_PACKING',
      operation: 'CONFIRM_PACKING',
      params: { optionId: body.optionId },
      version: body.version,
      audit: { action: 'FBA_INBOUND_PACKING_CONFIRMED' },
    })
  }

  /** 提交箱内物品：服务端再校验一遍（每个 SKU 的装箱总数必须等于计划数量），不依赖页面的校验结果。 */
  async packingInfo(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundVersionBodySchema.parse(rawBody)
    const [boxes, items, groups] = await Promise.all([
      this.prisma.inboundBox.findMany({ where: { tenantId: plan.tenantId, planId: plan.id }, orderBy: { boxId: 'asc' }, take: 1000 }),
      this.prisma.inboundPlanItem.findMany({ where: { tenantId: plan.tenantId, planId: plan.id }, select: { sku: true, quantity: true }, take: 500 }),
      plan.selectedPackingOptionId
        ? this.prisma.packingGroup.findMany({ where: { tenantId: plan.tenantId, planId: plan.id, packingOptionId: plan.selectedPackingOptionId }, take: 200 })
        : Promise.resolve([]),
    ])
    const validation = validateBoxes(
      items,
      boxes.map(box => ({ boxId: box.boxId, packingGroupId: box.packingGroupId, quantity: box.quantity, items: asItems(box.contentJson) })),
      groups.map(group => ({ packingGroupId: group.packingGroupId, items: asItems(group.itemsJson) })),
    )
    if (!validation.ok) throw appError('VALIDATION_FAILED', '箱内物品与计划不一致，不能提交', { fieldErrors: { boxes: validation.problems.slice(0, 20) } })
    return this.jobs.enqueue(req, context, plan, { action: 'SUBMIT_PACKING_INFO', operation: 'SUBMIT_PACKING_INFO', version: body.version, audit: { action: 'FBA_INBOUND_PACKING_INFO_SUBMITTED' } })
  }

  async placementOptions(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundOptionBodySchema.parse(rawBody)
    if (body.action === 'GENERATE')
      return this.jobs.enqueue(req, context, plan, { action: 'GENERATE_PLACEMENT', operation: 'GENERATE_PLACEMENT', version: body.version, audit: { action: 'FBA_INBOUND_PLACEMENT_GENERATED' } })
    const option = await this.prisma.placementOption.findFirst({ where: { tenantId: plan.tenantId, planId: plan.id, placementOptionId: body.optionId } })
    if (!option || option.status !== 'OFFERED') throw appError('CONFLICT', '这个分仓方案已不可选，请重新生成')
    if (option.expiresAt && option.expiresAt.getTime() <= NOW().getTime()) throw appError('CONFLICT', '这个分仓方案已过期，请重新生成')
    return this.jobs.enqueue(req, context, plan, {
      action: 'CONFIRM_PLACEMENT',
      operation: 'CONFIRM_PLACEMENT',
      params: { optionId: body.optionId },
      version: body.version,
      audit: { action: 'FBA_INBOUND_PLACEMENT_CONFIRMED' },
    })
  }

  private async shipmentIds(plan: FbaInboundPlan): Promise<string[]> {
    const rows = await this.prisma.fbaInboundShipment.findMany({ where: { planId: plan.id }, select: { shipmentId: true }, take: 200 })
    return rows.map(row => row.shipmentId)
  }

  async transportOptions(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundTransportBodySchema.parse(rawBody)
    const shipments = await this.shipmentIds(plan)
    if (body.action === 'GENERATE') {
      const unknown = body.shipments.filter(item => !shipments.includes(item.shipmentId)).map(item => item.shipmentId)
      if (unknown.length > 0) throw appError('VALIDATION_FAILED', `货件不属于这个计划：${unknown.join('、')}`, { fieldErrors: { shipments: ['货件不属于这个计划'] } })
      // 联系人只用于这一次调用，操作完成后由后台任务清除（不进审计，不留在操作记录里）
      return this.jobs.enqueue(req, context, plan, {
        action: 'GENERATE_TRANSPORT',
        operation: 'GENERATE_TRANSPORT',
        params: { shipments: body.shipments },
        version: body.version,
        audit: { action: 'FBA_INBOUND_TRANSPORT_GENERATED' },
      })
    }
    const now = NOW().getTime()
    const covered = new Set(body.selections.map(item => item.shipmentId))
    const missing = shipments.filter(shipmentId => !covered.has(shipmentId))
    if (missing.length > 0) throw appError('VALIDATION_FAILED', `还有货件没有选择运输方案：${missing.join('、')}`, { fieldErrors: { selections: ['每个货件都要选择运输方案'] } })
    for (const selection of body.selections) {
      const option = await this.prisma.transportOption.findFirst({
        where: { tenantId: plan.tenantId, planId: plan.id, shipmentId: selection.shipmentId, transportOptionId: selection.transportOptionId },
      })
      if (!option) throw appError('VALIDATION_FAILED', `货件 ${selection.shipmentId} 没有这个运输方案`, { fieldErrors: { selections: ['运输方案不存在'] } })
      if (option.expiresAt && option.expiresAt.getTime() <= now) throw appError('CONFLICT', `货件 ${selection.shipmentId} 的运输方案报价已过期，请重新生成`)
      const needsWindow = Array.isArray(option.preconditionsJson) && option.preconditionsJson.includes('CONFIRMED_DELIVERY_WINDOW')
      if (
        needsWindow &&
        !(await this.prisma.deliveryWindow.findFirst({ where: { tenantId: plan.tenantId, planId: plan.id, shipmentId: selection.shipmentId, confirmed: true }, select: { id: true } }))
      )
        throw appError('CONFLICT', `货件 ${selection.shipmentId} 的这个运输方案要求先确认送达时间窗`)
    }
    return this.jobs.enqueue(req, context, plan, {
      action: 'CONFIRM_TRANSPORT',
      operation: 'CONFIRM_TRANSPORT',
      params: { selections: body.selections },
      version: body.version,
      audit: { action: 'FBA_INBOUND_TRANSPORT_CONFIRMED' },
    })
  }

  async deliveryWindows(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundWindowBodySchema.parse(rawBody)
    if (!(await this.shipmentIds(plan)).includes(body.shipmentId)) throw appError('VALIDATION_FAILED', '货件不属于这个计划', { fieldErrors: { shipmentId: ['货件不属于这个计划'] } })
    if (body.action === 'GENERATE')
      return this.jobs.enqueue(req, context, plan, {
        action: 'GENERATE_WINDOWS',
        operation: 'GENERATE_WINDOWS',
        params: { shipmentId: body.shipmentId },
        version: body.version,
        audit: { action: 'FBA_INBOUND_WINDOWS_GENERATED' },
      })
    const window = await this.prisma.deliveryWindow.findFirst({ where: { tenantId: plan.tenantId, planId: plan.id, shipmentId: body.shipmentId, deliveryWindowOptionId: body.optionId } })
    if (!window) throw appError('VALIDATION_FAILED', '没有这个送达时间窗', { fieldErrors: { optionId: ['时间窗不存在'] } })
    if (window.availabilityExpiresAt && window.availabilityExpiresAt.getTime() <= NOW().getTime()) throw appError('CONFLICT', '这个送达时间窗已过期，请重新生成')
    return this.jobs.enqueue(req, context, plan, {
      action: 'CONFIRM_WINDOW',
      operation: 'CONFIRM_WINDOW',
      params: { shipmentId: body.shipmentId, optionId: body.optionId },
      version: body.version,
      audit: { action: 'FBA_INBOUND_WINDOW_CONFIRMED' },
    })
  }

  /** 批量打印：每个货件一个打印任务；取标签是只读调用，不受写入开关控制，不要求版本号。 */
  async labelPrintJobs(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    const body = InboundLabelBodySchema.parse(rawBody)
    const shipments = await this.shipmentIds(plan)
    const targets = body.shipmentId ? shipments.filter(shipmentId => shipmentId === body.shipmentId) : shipments
    if (targets.length === 0) throw appError('CONFLICT', body.shipmentId ? '货件不属于这个计划' : '计划还没有货件，不能打印标签')
    return this.jobs.enqueue(req, context, plan, {
      action: 'PRINT_LABELS',
      operation: 'LABELS',
      version: null,
      audit: { action: 'FBA_INBOUND_LABELS_REQUESTED' },
      inTransaction: async (tx, current, op) => {
        const created = await Promise.all(
          targets.map(shipmentId =>
            tx.labelPrintJob.create({
              data: {
                tenantId: current.tenantId,
                planId: current.id,
                shipmentId,
                kind: body.kind,
                status: 'QUEUED',
                pageType: body.kind === 'BOX' ? body.pageType : null,
                requestedBy: context.userId,
              },
            }),
          ),
        )
        await tx.inboundOperation.update({ where: { id: op.id }, data: { paramsJson: { jobIds: created.map(job => job.id) } } })
      },
    })
  }

  /** 回填追踪号：小包裹按箱，零担填提单号；承运商记在货件上。 */
  async tracking(req: RequestWithContext, shipmentRowId: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = InboundTrackingBodySchema.parse(rawBody)
    const shipment = await this.prisma.fbaInboundShipment.findFirst({ where: { id: shipmentRowId, plan: { tenantId: context.tenantId } } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '货件不存在')
    const plan = await loadPlan(this.prisma, context.tenantId, scope, shipment.planId)
    const known = record(shipment.trackingJson).boxIds
    if (body.items && Array.isArray(known) && known.length > 0) {
      const unknown = body.items.filter(item => !known.includes(item.boxId)).map(item => item.boxId)
      if (unknown.length > 0) throw appError('VALIDATION_FAILED', `这些箱子不属于这个货件：${unknown.slice(0, 10).join('、')}`, { fieldErrors: { items: ['箱子编号不属于这个货件'] } })
    }
    return this.jobs.enqueue(req, context, plan, {
      action: 'UPDATE_TRACKING',
      operation: 'UPDATE_TRACKING',
      params: { shipmentId: shipment.shipmentId, items: body.items ?? [], billOfLadingNumber: body.billOfLadingNumber, freightBillNumber: body.freightBillNumber },
      version: body.version,
      audit: { action: 'FBA_INBOUND_TRACKING_UPDATED' },
      inTransaction: async tx => {
        if (body.carrier) await tx.fbaInboundShipment.update({ where: { id: shipment.id }, data: { carrier: body.carrier } })
      },
    })
  }

  /** 取消：还没到亚马逊的计划只在本地取消；已在亚马逊的计划作废（受开关控制，运输方案确认后受作废窗口限制）。 */
  async cancel(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, plan } = await this.open(req, id)
    return plan.externalPlanId ? this.drafts.cancelRemote(req, context, plan, rawBody) : this.drafts.cancelLocal(req, context, plan, rawBody)
  }
}
