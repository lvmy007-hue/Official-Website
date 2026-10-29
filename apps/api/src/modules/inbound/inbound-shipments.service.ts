import { Injectable } from '@nestjs/common'
import {
  InboundShipmentListQuerySchema,
  OPPORTUNITY_RULE_LABEL,
  OPPORTUNITY_STATUS_LABEL,
  claimWindowOf,
  isInboundStage,
  type AttachmentRow,
  type InboundDiscrepancyResponse,
  type InboundShipmentListResponse,
  type InboundShipmentTimelineResponse,
  type InboundShipmentView,
  type InboundTimelineEvent,
  type NoncomplianceItem,
  type OpportunityEvidence,
  type OpportunityItem,
  type OpportunityRule,
  type OpportunityStatus,
  type ReceivingAuditRow,
} from '@nova/api-contracts'
import { Prisma, type FbaInboundPlan, type FbaInboundShipment } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AttachmentService } from '../procurement'
import { ContextService, storeWhere } from '../auth'
import { INBOUND_READ, inboundFreshness, iso, num } from './inbound-common'
import { InboundOptionsService } from './inbound-options.service'
import { INBOUND_RULE, loadReceivingExtras, noncomplianceConnected } from './receiving-common'

// 货件接收与差异：按货件看接收数量与差异、接收时间线、不合规问题、赔付任务、证据附件与审计。
// 接收数量来自旧版入库接口（v2024 没有接收数量），货件关闭之前不判差异；差异与不合规问题是同步器落库的（ReceivingDiscrepancy）。
@Injectable()
export class InboundShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly options: InboundOptionsService,
    private readonly attachments: AttachmentService,
  ) {}

  private async load(tenantId: string, scope: Parameters<typeof storeWhere>[0], id: string): Promise<{ shipment: FbaInboundShipment; plan: FbaInboundPlan }> {
    // 货件行编号之外也认亚马逊的货件编号与确认号：库存台账的参考编号是亚马逊的编号，从台账点进来要能打开
    const shipment = await this.prisma.fbaInboundShipment.findFirst({
      where: { OR: [{ id }, { shipmentId: id }, { shipmentConfirmationId: id }], plan: { tenantId, ...storeWhere(scope) } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '货件不存在')
    const { plan, ...rest } = shipment
    return { shipment: rest, plan }
  }

  /** 有未消除的差异或不合规问题的货件编号（来源给的编号，可能是确认号）。 */
  private async discrepancyRefs(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.receivingDiscrepancy.findMany({ where: { tenantId, resolvedAt: null }, select: { shipmentRef: true }, distinct: ['shipmentRef'], take: 5000 })
    return rows.map(row => row.shipmentRef)
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<InboundShipmentListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, rawQuery)
    const query = InboundShipmentListQuerySchema.parse(rawQuery)
    const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })
    const refs = query.discrepancy ? await this.discrepancyRefs(context.tenantId) : null
    const where: Prisma.FbaInboundShipmentWhereInput = {
      plan: { tenantId: context.tenantId, ...storeWhere(scope), ...(query.planId ? { id: query.planId } : {}) },
      ...(query.status ? { status: query.status } : {}),
      ...(query.destinationFc ? { destinationFc: query.destinationFc } : {}),
      ...(refs ? { OR: [{ shipmentId: { in: refs } }, { shipmentConfirmationId: { in: refs } }] } : {}),
      ...(query.q
        ? { AND: [{ OR: [{ shipmentId: contains(query.q) }, { shipmentConfirmationId: contains(query.q) }, { trackingNumber: contains(query.q) }, { plan: { name: contains(query.q) } }] }] }
        : {}),
    }
    const now = new Date()
    const [rows, total, freshness] = await Promise.all([
      this.prisma.fbaInboundShipment.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { plan: { select: { id: true, name: true, stage: true, shippingMode: true, sellerAccountId: true } } },
      }),
      this.prisma.fbaInboundShipment.count({ where }),
      inboundFreshness(this.prisma, context.tenantId, scope),
    ])
    const [views, extras] = await Promise.all([
      this.options.shipmentViews(context.tenantId, { id: { in: rows.map(row => row.id) } }, new Map(rows.map(row => [row.planId, row.plan.shippingMode]))),
      loadReceivingExtras(
        this.prisma,
        context.tenantId,
        scope,
        rows.map(row => ({
          id: row.id,
          shipmentId: row.shipmentId,
          shipmentConfirmationId: row.shipmentConfirmationId,
          status: row.status,
          transportStatus: row.transportStatus,
          sellerAccountId: row.plan.sellerAccountId,
        })),
        now,
      ),
    ])
    const byId = new Map(views.map(view => [view.id, view]))
    const items = rows.flatMap(row => {
      const view = byId.get(row.id)
      const receiving = extras.get(row.id)
      if (!view || !receiving) return []
      return [{ ...view, planId: row.plan.id, planName: row.plan.name, planStage: isInboundStage(row.plan.stage) ? row.plan.stage : ('DRAFT' as const), receiving }]
    })
    return { items, page: query.page, pageSize: query.pageSize, total, freshness }
  }

  async detail(req: RequestWithContext, id: string): Promise<InboundShipmentView & { planId: string; planName: string; sellerAccountId: string; transportStatus: string | null }> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const { shipment, plan } = await this.load(context.tenantId, scope, id)
    const [view] = await this.options.shipmentViews(context.tenantId, { id: shipment.id }, new Map([[plan.id, plan.shippingMode]]))
    return { ...view, planId: plan.id, planName: plan.name, sellerAccountId: plan.sellerAccountId, transportStatus: shipment.transportStatus }
  }

  async discrepancies(req: RequestWithContext, id: string): Promise<InboundDiscrepancyResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const { shipment, plan } = await this.load(context.tenantId, scope, id)
    const tenantId = context.tenantId
    const refs = [shipment.shipmentId, ...(shipment.shipmentConfirmationId ? [shipment.shipmentConfirmationId] : [])]
    const [items, recorded, opportunities, connected] = await Promise.all([
      this.prisma.shipmentItem.findMany({ where: { tenantId, planId: plan.id, shipmentId: shipment.shipmentId }, orderBy: { sku: 'asc' }, take: 2000 }),
      this.prisma.receivingDiscrepancy.findMany({ where: { tenantId, shipmentRef: { in: refs } }, orderBy: [{ firstSeenAt: 'asc' }, { sku: 'asc' }], take: 5000 }),
      this.prisma.reimbursementOpportunity.findMany({ where: { tenantId, ruleCode: INBOUND_RULE, dedupKey: { startsWith: `${shipment.shipmentId}:` } }, orderBy: { detectedAt: 'asc' }, take: 2000 }),
      noncomplianceConnected(this.prisma, tenantId, scope, [plan.sellerAccountId]),
    ])
    const closed = shipment.status === 'CLOSED'
    const noncompliance: NoncomplianceItem[] = recorded
      .filter(row => row.kind === 'NONCOMPLIANCE')
      .map(row => ({
        sku: row.sku,
        problemType: row.problemType,
        qty: row.qty,
        amount: num(row.amount),
        currency: row.currency,
        firstSeenAt: row.firstSeenAt.toISOString(),
        resolvedAt: iso(row.resolvedAt),
      }))
    const reasonOf = (sku: string) => noncompliance.find(row => row.sku === sku && row.problemType)?.problemType ?? null
    const shortQty = new Map(recorded.filter(row => row.kind === 'SHORT').map(row => [row.sku, row.qty]))
    const claimItems: OpportunityItem[] = opportunities.map(row => {
      const sku = row.dedupKey.slice(shipment.shipmentId.length + 1)
      const status = row.status as OpportunityStatus
      const rule = row.ruleCode as OpportunityRule
      return {
        id: row.id,
        ruleCode: rule,
        ruleLabel: OPPORTUNITY_RULE_LABEL[rule] ?? row.ruleCode,
        sku,
        status,
        statusLabel: OPPORTUNITY_STATUS_LABEL[status] ?? row.status,
        qty: shortQty.get(sku) ?? null,
        estimatedAmount: num(row.estimatedAmount),
        currency: row.currency,
        deadlineAt: iso(row.deadlineAt),
        detectedAt: row.detectedAt.toISOString(),
        evidence: Array.isArray(row.evidenceRefsJson) ? (row.evidenceRefsJson as unknown as OpportunityEvidence[]) : [],
      }
    })
    return {
      shipmentId: shipment.shipmentId,
      closed,
      rows: items.map(item => {
        const diff = item.receivedQty === null ? null : item.shippedQty - item.receivedQty
        return {
          sku: item.sku,
          fnsku: item.fnsku,
          shippedQty: item.shippedQty,
          receivedQty: item.receivedQty,
          discrepancyQty: closed ? diff : null,
          state: !closed || diff === null ? ('PENDING' as const) : diff > 0 ? ('SHORT' as const) : diff < 0 ? ('OVER' as const) : ('MATCH' as const),
          reason: reasonOf(item.sku),
        }
      }),
      compliance: {
        state: connected.has(plan.sellerAccountId) || noncompliance.length > 0 ? 'OK' : 'NOT_CONNECTED',
        items: noncompliance,
        note: '来自亚马逊的入仓不合规报告，每天同步一次；报告里的货件编号可能是 FBA 确认号。',
      },
      claims: {
        state: closed ? 'OK' : 'NOT_JUDGED',
        items: claimItems,
        window: closed && shipment.receivedDoneAt ? claimWindowOf(shipment.receivedDoneAt, new Date()) : null,
        note: closed
          ? '少收的货件关闭后先等亚马逊自己调查，过了等待期仍少收才生成赔付机会；等待期与申请期限现为默认值（关闭起 45 天、540 天），设置页在赔付中心上线后开放。'
          : '货件还没有关闭，关闭之后才判断是否有赔付机会。',
      },
      note: closed ? '差异 = 发出数量 − 接收数量；为正是少收，为负是多收。亚马逊的接收接口不提供差异原因。' : '货件还没有关闭，接收数量可能还在变化，关闭之后才判断差异。',
    }
  }

  async timeline(req: RequestWithContext, id: string): Promise<InboundShipmentTimelineResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const { shipment, plan } = await this.load(context.tenantId, scope, id)
    const tracking = shipment.trackingNumber
      ? await this.prisma.trackingEvent.findMany({ where: { tenantId: context.tenantId, trackingNumber: shipment.trackingNumber }, orderBy: { occurredAt: 'asc' }, take: 200 })
      : []
    const events: InboundTimelineEvent[] = [{ at: plan.createdAt.toISOString(), kind: 'PLAN', title: '入仓计划创建', precision: 'LOCAL', detail: null }]
    if (plan.transportConfirmedAt) events.push({ at: plan.transportConfirmedAt.toISOString(), kind: 'TRANSPORT', title: '运输方案已确认', precision: 'OBSERVED', detail: null })
    if (plan.shippedAt) events.push({ at: plan.shippedAt.toISOString(), kind: 'SHIPPED', title: '标记为已发货', precision: 'LOCAL', detail: '我方记录的时间，不是承运商的揽收时间' })
    if (shipment.receivedFirstAt)
      events.push({ at: shipment.receivedFirstAt.toISOString(), kind: 'RECEIVING', title: '运营中心开始接收', precision: 'OBSERVED', detail: '同步时第一次看到收到数量的时间，实际到货时间更早' })
    if (shipment.receivedDoneAt) events.push({ at: shipment.receivedDoneAt.toISOString(), kind: 'RECEIVING', title: '货件已关闭', precision: 'OBSERVED', detail: '同步时第一次看到货件关闭的时间' })
    for (const event of tracking)
      events.push({ at: event.occurredAt.toISOString(), kind: 'TRACKING', title: event.milestone, precision: 'EXACT', detail: [event.location, event.source].filter(Boolean).join(' · ') || null })
    return {
      shipmentId: shipment.shipmentId,
      events: events.sort((a, b) => a.at.localeCompare(b.at)),
      note: '承运商的物流节点没有接入（亚马逊接口不提供运输轨迹），这里只有计划与接收的关键时间。标注“同步时看到”的时间不是事件实际发生的时间。',
    }
  }

  /** 证据附件列表（装箱单、提单、签收证明等）。 */
  async evidence(req: RequestWithContext, id: string): Promise<AttachmentRow[]> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    await this.load(context.tenantId, scope, id)
    return this.attachments.list(context.tenantId, 'INBOUND_SHIPMENT', id)
  }

  /** 这个货件的审计记录：货件本身与它所在计划上的写操作（取追踪号、上传证据等）。 */
  async audit(req: RequestWithContext, id: string): Promise<ReceivingAuditRow[]> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const { shipment, plan } = await this.load(context.tenantId, scope, id)
    const events = await this.prisma.auditEvent.findMany({
      where: {
        tenantId: context.tenantId,
        OR: [
          { resourceType: 'FbaInboundShipment', resourceId: shipment.id },
          { resourceType: 'FbaInboundPlan', resourceId: plan.id },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      events.map(event => event.actorId),
    )
    return events.map(event => ({ id: event.id, at: event.createdAt.toISOString(), action: event.action, actorName: nameOrFormer(names, event.actorId), result: event.result, reason: event.reason }))
  }

  /** 证据附件的写入与下载入口：先校验货件在当前成员的数据范围内。 */
  async assertShipmentInScope(req: RequestWithContext, id: string, permission: string) {
    const { context, scope } = await this.context.authorizeScoped(req, permission, {})
    await this.load(context.tenantId, scope, id)
  }
}
