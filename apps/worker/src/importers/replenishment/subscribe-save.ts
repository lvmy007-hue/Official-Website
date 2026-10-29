import { isNotEnrolled, MAX_OFFSET, OFFERS_PAGE_SIZE, OFFER_METRICS_PAGE_SIZE, type ReplenishmentApi } from '../../connectors/replenishment-api'
import type { ImportContext } from '../../types'
import { parseOfferUnits, parseOffers, parseSellerMetrics } from './parse'

// 订阅省同步器（importers.md I-19，P2a-07）：卖家整体指标 → SubscribeSaveMetric；报价列表（含官方预测出货）+ 上月按 SKU 出货件数 → SubscribeSaveOffer。
// 补货计算只读这两张表：官方预测是“确定性需求”，上月订阅出货用来从历史销量里扣掉订阅部分，避免重复计算。
// “不适用”：没有开通订阅省、或没有任何订阅省报价 → 返回 notApplicable，不写任何行、不补 0；缺少角色（403）等其他错误原样抛出，不被吞掉。

export interface SubscribeSaveScope {
  tenantId: string
  sellerAccountId: string
}
export interface SubscribeSaveOptions {
  /** 企业数据口径的“今天”（UTC 零点的日期）：报价快照日期、上月与近 31 天都以它为基准。 */
  today: Date
}
export type SubscribeSaveResult =
  { notApplicable: true; reason: 'NOT_ENROLLED' | 'NO_OFFERS'; imported: 0 } | { notApplicable: false; imported: number; offers: number; metrics: number; skipped: number; incomplete: boolean }

const ymd = (date: Date) => date.toISOString().slice(0, 10)
const startOfDay = (date: Date) => `${ymd(date)}T00:00:00Z`
const endOfDay = (date: Date) => `${ymd(date)}T23:59:59Z`
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000)

/** 上一个完整自然月（UTC）。 */
export function previousMonth(today: Date) {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))
  return { start, end, days: end.getUTCDate() }
}

export async function syncSubscribeSave(ctx: ImportContext, api: ReplenishmentApi, scope: SubscribeSaveScope, options: SubscribeSaveOptions): Promise<SubscribeSaveResult> {
  const { prisma } = ctx
  const { today } = options
  const sourceUpdatedAt = new Date()
  let skipped = 0
  let incomplete = false

  // 1. 报价列表（逐页，offset 上限 9000）。第一页就报“没开通”→ 不适用。
  const offers: ReturnType<typeof parseOffers>['offers'] = []
  for (let offset = 0; ; offset += OFFERS_PAGE_SIZE) {
    if (offset > MAX_OFFSET) {
      incomplete = true
      break
    }
    let body
    try {
      body = await api.listOffers(offset)
    } catch (error) {
      if (offset === 0 && isNotEnrolled(error)) return { notApplicable: true, reason: 'NOT_ENROLLED', imported: 0 }
      throw error
    }
    const page = parseOffers(body)
    skipped += page.skipped
    offers.push(...page.offers)
    const returned = Array.isArray(body.offers) ? body.offers.length : 0
    if (returned < OFFERS_PAGE_SIZE) break
  }
  if (offers.length === 0) return { notApplicable: true, reason: 'NO_OFFERS', imported: 0 }

  // 2. 上月按 SKU 的订阅出货件数
  const month = previousMonth(today)
  const monthWindow = { startDate: startOfDay(month.start), endDate: endOfDay(month.end) }
  const prevUnits = new Map<string, number>()
  for (let offset = 0; ; offset += OFFER_METRICS_PAGE_SIZE) {
    if (offset > MAX_OFFSET) {
      incomplete = true
      break
    }
    const page = parseOfferUnits(await api.listOfferMetrics(monthWindow, 'MONTH', offset))
    for (const [sku, units] of page.units) prevUnits.set(sku, (prevUnits.get(sku) ?? 0) + units)
    if (page.count < OFFER_METRICS_PAGE_SIZE) break
  }

  for (const offer of offers) {
    const data = { ...offer, shippedUnitsPrevMonth: prevUnits.get(offer.sku) ?? null, prevMonthStart: month.start, prevMonthDays: month.days, sourceUpdatedAt }
    await prisma.subscribeSaveOffer.upsert({
      where: { tenantId_sellerAccountId_sku_snapshotDate: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, sku: offer.sku, snapshotDate: today } },
      create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, snapshotDate: today, ...data },
      update: data,
    })
  }

  // 3. 卖家整体指标：近 31 天按天（官方上限 31 天）与近 6 个自然月按月。拿不到指标不影响报价（报价与预测才是补货要用的）。
  const dayWindow = { startDate: startOfDay(addDays(today, -31)), endDate: endOfDay(addDays(today, -1)) }
  const monthsWindow = { startDate: startOfDay(new Date(Date.UTC(month.start.getUTCFullYear(), month.start.getUTCMonth() - 5, 1))), endDate: endOfDay(month.end) }
  let metrics = 0
  for (const [window, frequency] of [
    [dayWindow, 'DAY'],
    [monthsWindow, 'MONTH'],
  ] as const) {
    let body
    try {
      body = await api.sellerMetrics(window, frequency)
    } catch (error) {
      if (isNotEnrolled(error)) continue
      throw error
    }
    const parsed = parseSellerMetrics(body)
    skipped += parsed.skipped
    for (const metric of parsed.metrics) {
      const data = { activeSubscribers: metric.activeSubscribers, shippedUnits: metric.shippedUnits, revenue: metric.revenue, currency: metric.currency, sourceUpdatedAt }
      await prisma.subscribeSaveMetric.upsert({
        where: { tenantId_sellerAccountId_granularity_metricDate: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, granularity: frequency, metricDate: metric.metricDate } },
        create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, granularity: frequency, metricDate: metric.metricDate, ...data },
        update: data,
      })
      metrics += 1
    }
  }

  if (skipped > 0) ctx.logger.warn({ ...scope, skipped }, 'subscribe and save rows skipped: missing sku or time interval')
  if (incomplete) ctx.logger.warn({ ...scope }, 'subscribe and save pagination reached the offset limit; offers may be incomplete')
  return { notApplicable: false, imported: offers.length + metrics, offers: offers.length, metrics, skipped, incomplete }
}
