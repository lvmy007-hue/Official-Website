import { Injectable } from '@nestjs/common'
import {
  BatchListQuerySchema,
  RecommendationQuerySchema,
  AWD_ORDER_STATUS_LABEL,
  INBOUND_DRAFT_TARGET,
  INBOUND_STAGE_LABEL,
  type InboundStage,
  type AwdOrderStatus,
  type BatchDetailResponse,
  type BatchListResponse,
  type BatchSummary,
  type OutcomeRow,
  type RecommendationListResponse,
  type RecommendationQuery,
  type ReplenishAction,
  REPLENISH_ACTIONS,
  SHIP_DUE_WEEK_DAYS,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { InventoryPolicyService, plusDays, riskRank } from '../inventory'
import { batchSummaryOf, recommendationRowOf, snapshotOf } from './replenishment-rows'
import { effectiveActions } from './replenishment-status'

const READ = 'replenishment.read'
const MAX_ROWS = 6000
const dateText = (value: Date) => value.toISOString().slice(0, 10)

// 建议与批次的读取：列表先只取排序用的轻量列，排好序切出当页的编号，再读当页的完整行（计算链 JSON 较大，不整批读出）。
@Injectable()
export class ReplenishmentReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly inventoryPolicies: InventoryPolicyService,
  ) {}

  /** 建议发货日（有发货日用发货日，没有就用下单日）的快捷筛选：本周 = 今天起连续 7 天，逾期 = 早于今天。 */
  private dueWhere(due: RecommendationQuery['due'], today: string): Prisma.ReplenishmentRecommendationWhereInput[] {
    if (!due) return []
    const start = new Date(`${today}T00:00:00Z`)
    const last = new Date(`${plusDays(today, SHIP_DUE_WEEK_DAYS - 1)}T00:00:00Z`)
    const range = due === 'WEEK' ? { gte: start, lte: last } : { lt: start }
    return [{ OR: [{ shipDate: range }, { shipDate: null, dueDate: range }] }]
  }

  private async batchOf(tenantId: string, batchId: string | undefined) {
    const batch = batchId
      ? await this.prisma.replenishmentBatch.findFirst({ where: { id: batchId, tenantId } })
      : await this.prisma.replenishmentBatch.findFirst({ where: { tenantId }, orderBy: { computedAt: 'desc' } })
    if (batchId && !batch) throw appError('RESOURCE_NOT_FOUND', '补货批次不存在')
    return batch
  }

  private async page(tenantId: string, scope: ResolvedScope, batchId: string, query: RecommendationQuery, today: string) {
    const where: Prisma.ReplenishmentRecommendationWhereInput = {
      tenantId,
      batchId,
      ...storeWhere(scope),
      ...(query.risk ? { riskLevel: query.risk } : {}),
      ...(query.q ? { OR: [{ sku: { contains: query.q, mode: 'insensitive' } }, { asin: { contains: query.q, mode: 'insensitive' } }] } : {}),
      AND: this.dueWhere(query.due, today),
    }
    const light = await this.prisma.replenishmentRecommendation.findMany({
      where,
      select: { id: true, sku: true, sellerAccountId: true, riskLevel: true, recommendedQty: true, dueDate: true, shipDate: true, arriveDate: true },
      take: MAX_ROWS,
    })
    const sign = query.sort.dir === 'asc' ? 1 : -1
    const key = (row: (typeof light)[number]): string | number => {
      switch (query.sort.field) {
        case 'sku':
          return row.sku
        case 'recommendedQty':
          return row.recommendedQty
        case 'orderDate':
          return dateText(row.dueDate)
        case 'shipDate':
          return dateText(row.shipDate ?? row.dueDate)
        case 'arriveDate':
          return row.arriveDate ? dateText(row.arriveDate) : '9999-12-31'
        default:
          return riskRank(row.riskLevel as never)
      }
    }
    light.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      const primary = (ka < kb ? -1 : ka > kb ? 1 : 0) * sign
      return primary || a.sku.localeCompare(b.sku) || a.sellerAccountId.localeCompare(b.sellerAccountId)
    })
    const start = (query.page - 1) * query.pageSize
    const ids = light.slice(start, start + query.pageSize).map(row => row.id)
    const rows = await this.prisma.replenishmentRecommendation.findMany({ where: { id: { in: ids }, tenantId }, include: { actions: true } })
    const order = new Map(ids.map((id, index) => [id, index]))
    rows.sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number))
    const stores = await this.prisma.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(rows.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 500 })
    const storeNames = new Map(stores.map(store => [store.id, store.displayName]))
    const titles = rows.length
      ? await this.prisma.fbaProduct.findMany({
          where: { tenantId, sellerSku: { in: rows.map(row => row.sku) }, sellerAccountId: { in: stores.map(store => store.id) } },
          select: { sellerAccountId: true, sellerSku: true, title: true },
          take: 1000,
        })
      : []
    const titleOf = new Map(titles.map(item => [`${item.sellerAccountId}|${item.sellerSku}`, item.title]))
    return { total: light.length, rows, storeNames, titleOf }
  }

  async recommendations(req: RequestWithContext, rawQuery: Record<string, string>): Promise<RecommendationListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, READ, rawQuery)
    const query = RecommendationQuerySchema.parse(rawQuery)
    const batch = await this.batchOf(context.tenantId, query.batchId)
    if (!batch) return { batch: null, snapshot: null, items: [], page: query.page, pageSize: query.pageSize, total: 0 }
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const { total, rows, storeNames, titleOf } = await this.page(context.tenantId, scope, batch.id, query, today)
    const snapshot = snapshotOf(batch)
    const names = await memberNames(this.prisma, context.tenantId, [batch.computedBy])
    return {
      batch: batchSummaryOf(batch, names),
      snapshot,
      items: rows.map(rec =>
        recommendationRowOf(rec, {
          storeName: storeNames.get(rec.sellerAccountId) ?? rec.sellerAccountId,
          title: titleOf.get(`${rec.sellerAccountId}|${rec.sku}`) ?? null,
          restockSnapshotDate: snapshot.dataTimes.restockSnapshotDate,
          today,
        }),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total,
    }
  }

  async batches(req: RequestWithContext, rawQuery: Record<string, string>): Promise<BatchListResponse> {
    const context = await this.context.authorize(req, READ)
    const query = BatchListQuerySchema.parse(rawQuery)
    const where = { tenantId: context.tenantId }
    const [rows, total] = await Promise.all([
      this.prisma.replenishmentBatch.findMany({ where, orderBy: [{ computedAt: query.sort.dir }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.replenishmentBatch.count({ where }),
    ])
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.computedBy),
    )
    return { items: rows.map(row => batchSummaryOf(row, names)), page: query.page, pageSize: query.pageSize, total }
  }

  async batchDetail(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<BatchDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, READ, rawQuery)
    const query = RecommendationQuerySchema.parse({ ...rawQuery, batchId: id })
    const batch = await this.batchOf(context.tenantId, id)
    if (!batch) throw appError('RESOURCE_NOT_FOUND', '补货批次不存在')
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const { total, rows, storeNames, titleOf } = await this.page(context.tenantId, scope, batch.id, query, today)
    const snapshot = snapshotOf(batch)
    const names = await memberNames(this.prisma, context.tenantId, [batch.computedBy])
    const summary: BatchSummary = batchSummaryOf(batch, names)
    return {
      batch: summary,
      snapshot,
      items: rows.map(rec =>
        recommendationRowOf(rec, {
          storeName: storeNames.get(rec.sellerAccountId) ?? rec.sellerAccountId,
          title: titleOf.get(`${rec.sellerAccountId}|${rec.sku}`) ?? null,
          restockSnapshotDate: snapshot.dataTimes.restockSnapshotDate,
          today,
        }),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total,
      execution: await this.execution(context.tenantId, scope, batch.id),
      review: await this.review(context.tenantId, scope, batch.id),
    }
  }

  private async execution(tenantId: string, scope: ResolvedScope, batchId: string): Promise<BatchDetailResponse['execution']> {
    // 只登记过、后来补建了草稿的旧意向已被取代，不再计入动作条数与待补建条数
    const actions = effectiveActions(
      await this.prisma.replenishmentAction.findMany({
        where: { tenantId, batchId },
        select: { recommendationId: true, action: true, status: true, targetDocType: true, targetDocId: true },
        take: 5000,
      }),
    )
    const actionCounts = Object.fromEntries(REPLENISH_ACTIONS.map(action => [action, 0])) as Record<ReplenishAction, number>
    for (const item of actions) actionCounts[item.action as ReplenishAction] += 1
    const poIds = [...new Set(actions.filter(item => item.targetDocType === 'PURCHASE_ORDER' && item.targetDocId).map(item => item.targetDocId as string))]
    const orders = poIds.length
      ? await this.prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: poIds } }, select: { id: true, number: true, status: true, _count: { select: { lines: true } } }, take: 200 })
      : []
    const awdIds = [...new Set(actions.filter(item => item.targetDocType === 'AWD_ORDER' && item.targetDocId).map(item => item.targetDocId as string))]
    const awdOrders = awdIds.length
      ? await this.prisma.awdInboundOrder.findMany({
          where: { tenantId, id: { in: awdIds }, ...storeWhere(scope) },
          select: { id: true, externalReferenceId: true, status: true, draftJson: true },
          take: 200,
        })
      : []
    const planIds = [...new Set(actions.filter(item => item.targetDocType === INBOUND_DRAFT_TARGET && item.targetDocId).map(item => item.targetDocId as string))]
    const plans = planIds.length
      ? await this.prisma.fbaInboundPlan.findMany({
          where: { tenantId, id: { in: planIds }, ...storeWhere(scope) },
          select: { id: true, name: true, stage: true, sellerAccountId: true, totalUnits: true, shipFromAddress: { select: { name: true } }, _count: { select: { planItems: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 200,
        })
      : []
    const planStores = plans.length
      ? await this.prisma.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(plans.map(plan => plan.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 200 })
      : []
    const planStoreName = new Map(planStores.map(store => [store.id, store.displayName]))
    return {
      purchaseOrders: orders.map(order => ({ id: order.id, number: order.number, status: order.status, lineCount: order._count.lines })),
      awdOrders: awdOrders.map(order => {
        const items = (order.draftJson as { items?: unknown } | null)?.items
        return {
          id: order.id,
          reference: order.externalReferenceId,
          status: order.status,
          statusLabel: AWD_ORDER_STATUS_LABEL[order.status as AwdOrderStatus] ?? order.status,
          lineCount: Array.isArray(items) ? items.length : 0,
        }
      }),
      inboundPlans: plans.map(plan => ({
        id: plan.id,
        name: plan.name,
        stage: plan.stage,
        stageLabel: INBOUND_STAGE_LABEL[plan.stage as InboundStage] ?? plan.stage,
        storeName: planStoreName.get(plan.sellerAccountId) ?? plan.sellerAccountId,
        skuCount: plan._count.planItems,
        totalUnits: plan.totalUnits,
        shipFromAddressName: plan.shipFromAddress?.name ?? null,
      })),
      actionCounts,
      pendingTargets: actions.filter(item => item.status === 'PENDING_TARGET').length,
    }
  }

  private async review(tenantId: string, scope: ResolvedScope, batchId: string): Promise<BatchDetailResponse['review']> {
    const rows = await this.prisma.replenishmentOutcome.findMany({
      where: { tenantId, recommendation: { batchId, ...storeWhere(scope) } },
      include: { recommendation: { select: { sku: true } } },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'asc' }],
      take: 500,
    })
    const outcomes: OutcomeRow[] = rows.map(row => ({
      recommendationId: row.recommendationId,
      sku: row.recommendation.sku,
      evaluatedAt: dateText(row.evaluatedAt),
      windowStart: dateText(row.windowStart),
      windowEnd: dateText(row.windowEnd),
      forecastQty: row.forecastQty,
      actualQty: row.actualQty,
      errorPct: row.errorPct === null ? null : Number(row.errorPct.toString()),
      stockoutDays: row.stockoutDays,
      excessUnits: row.excessUnits,
    }))
    // 同一条建议只取最近一次评估汇总
    const latest = new Map<string, OutcomeRow>()
    for (const outcome of outcomes) if (!latest.has(outcome.recommendationId)) latest.set(outcome.recommendationId, outcome)
    const errors = [...latest.values()].flatMap(outcome => (outcome.errorPct === null ? [] : [Math.abs(outcome.errorPct)]))
    return {
      outcomes,
      summary: {
        evaluated: latest.size,
        meanAbsErrorPct: errors.length ? Math.round((errors.reduce((total, value) => total + value, 0) / errors.length) * 10_000) / 10_000 : null,
        stockoutDays: [...latest.values()].reduce((total, outcome) => total + outcome.stockoutDays, 0),
      },
      arrival: { state: 'NOT_CONNECTED', note: '是否按时到仓需要入仓计划与货件接收记录（P2a-12、P2a-13 交付），尚未接入' },
    }
  }
}
