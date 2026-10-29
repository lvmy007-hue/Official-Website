import { Injectable } from '@nestjs/common'
import type { EvaluateResponse, Shipment } from '@nova/api-contracts'
import { US_MARKETPLACE_ID } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { daysBetween, InventoryPolicyService, plusDays } from '../inventory'
import { evaluateOutcome, MIN_COVERAGE_RATIO, type DailyPoint } from './replenishment-outcome'
import { frozenOf } from './replenishment-rows'

const PERMISSION = 'replenishment.plan.create'
/** 最后一批到仓之后至少要有这么多天的实际销量，才有评估意义。 */
export const MIN_DAYS_AFTER_ARRIVAL = 7
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (value: Date) => value.toISOString().slice(0, 10)

// 结果回看：把批次冻结的预测日销与到仓之后的实际销量对照，算预测误差、断货天数、多余库存；按需触发（不是定时任务），同一天重复评估会覆盖当天的结果。
@Injectable()
export class ReplenishmentEvaluateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly inventoryPolicies: InventoryPolicyService,
  ) {}

  async evaluate(req: RequestWithContext, batchId: string): Promise<EvaluateResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    const batch = await this.prisma.replenishmentBatch.findFirst({ where: { id: batchId, tenantId: context.tenantId } })
    if (!batch) throw appError('RESOURCE_NOT_FOUND', '补货批次不存在')
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const windowEnd = plusDays(today, -1)
    const windowStart = dateText(batch.today)
    const recs = await this.prisma.replenishmentRecommendation.findMany({ where: { tenantId: context.tenantId, batchId, ...storeWhere(scope) }, take: 6000 })

    const ready = recs.filter(rec => {
      const arrivals = (rec.shipmentsJson as unknown as Shipment[]).map(shipment => shipment.arriveDate).sort()
      const last = arrivals[arrivals.length - 1]
      return Boolean(rec.asin) && Boolean(last) && daysBetween(last, windowEnd) >= MIN_DAYS_AFTER_ARRIVAL && frozenOf(rec).dailyDemand !== null
    })
    if (ready.length === 0)
      return { evaluated: 0, skipped: recs.length, note: `没有可评估的建议：评估需要最后一批到仓后至少有 ${MIN_DAYS_AFTER_ARRIVAL} 天的实际销量，且建议里有 ASIN 与冻结的预测日销` }

    const summaries = await this.prisma.asinDailySummary.findMany({
      where: {
        tenantId: context.tenantId,
        sellerAccountId: { in: [...new Set(ready.map(rec => rec.sellerAccountId))] },
        asin: { in: [...new Set(ready.map(rec => rec.asin))] },
        summaryDate: { gte: asDate(windowStart), lte: asDate(windowEnd) },
      },
      select: { sellerAccountId: true, asin: true, summaryDate: true, units: true, inventoryAvailable: true },
      take: 200_000,
    })
    const daily = new Map<string, DailyPoint[]>()
    for (const row of summaries) {
      const key = `${row.sellerAccountId}|${row.asin}`
      daily.set(key, [...(daily.get(key) ?? []), { date: dateText(row.summaryDate), units: row.units, inventoryAvailable: row.inventoryAvailable }])
    }
    const stock = await this.prisma.fbaInventoryRecord.findMany({
      where: {
        tenantId: context.tenantId,
        marketplaceId: US_MARKETPLACE_ID,
        sellerAccountId: { in: [...new Set(ready.map(rec => rec.sellerAccountId))] },
        sellerSku: { in: [...new Set(ready.map(rec => rec.sku))] },
      },
      select: { sellerAccountId: true, sellerSku: true, fulfillableQuantity: true },
      take: 20_000,
    })
    const sellable = new Map(stock.map(row => [`${row.sellerAccountId}|${row.sellerSku}`, row.fulfillableQuantity]))

    let evaluated = 0
    await this.prisma.$transaction(async tx => {
      for (const rec of ready) {
        const frozen = frozenOf(rec)
        const outcome = evaluateOutcome({
          forecastRate: frozen.dailyDemand as number,
          windowStart,
          windowEnd,
          daily: daily.get(`${rec.sellerAccountId}|${rec.asin}`) ?? [],
          sellableNow: sellable.get(`${rec.sellerAccountId}|${rec.sku}`) ?? null,
          coverageDays: frozen.coverageDays ?? 0,
        })
        if (!outcome) continue
        const data = {
          windowStart: asDate(windowStart),
          windowEnd: asDate(windowEnd),
          forecastQty: outcome.forecastQty,
          actualQty: outcome.actualQty,
          errorPct: outcome.errorPct === null ? null : outcome.errorPct.toFixed(4),
          stockoutDays: outcome.stockoutDays,
          excessUnits: frozen.coverageDays === null ? null : outcome.excessUnits,
        }
        await tx.replenishmentOutcome.upsert({
          where: { recommendationId_evaluatedAt: { recommendationId: rec.id, evaluatedAt: asDate(today) } },
          create: { tenantId: context.tenantId, recommendationId: rec.id, evaluatedAt: asDate(today), ...data },
          update: data,
        })
        evaluated += 1
      }
      await this.audit.record(
        req,
        { action: 'REPLENISHMENT_EVALUATED', resourceType: 'ReplenishmentBatch', resourceId: batchId, detail: { evaluated, candidates: ready.length, windowStart, windowEnd } },
        { client: tx },
      )
    })
    const skipped = recs.length - evaluated
    return { evaluated, skipped, note: `已评估 ${evaluated} 条；${skipped} 条未评估（到仓不足 ${MIN_DAYS_AFTER_ARRIVAL} 天、没有 ASIN、或窗口内销量汇总覆盖不足 ${MIN_COVERAGE_RATIO * 100}%）` }
  }
}
