import { ASIN360_TRAFFIC_ROW_LIMIT, BA_NO_BRAND, BA_NO_BRAND_NOTE, BA_NO_DATA_NOTE, BA_PERIOD_OPTIONS_LIMIT, BA_ROW_LIMIT, type Asin360CatalogMetrics, type BaPeriod } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { asDate, dateText, resolvePeriods, todayIn, validZone, type ScopeDates } from '../overview'
import type { TermRow, TrafficRow } from './product-traffic-math'

// ASIN 360 流量转化、定价、竞品页签的取数（P4-08）：每个查询都带企业与店铺（商品已经校验过在成员的数据范围内），读取上限多读一行判断是否被截断。
// 官方没给的列是空（不是 0），这里原样带回 null。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const CURRENCY = 'USD'

export interface Target {
  tenantId: string
  storeId: string
  /** 品牌分析里的 ASIN 一律大写。 */
  asin: string
}

/** 页面日期范围：没有显式选择就是近 30 天；日期按企业时区算“今天”。 */
export async function rangeFor(prisma: PrismaService, tenantId: string, dates: ScopeDates, now: Date): Promise<{ from: string; to: string; defaulted: boolean }> {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  const periods = resolvePeriods(dates, todayIn(validZone(tenant?.timezone), now))
  return { from: periods.period.from, to: periods.period.to, defaulted: periods.defaulted }
}

/** 逐日销售与流量（子体粒度，美元）；同一天可能有数据中心与报告两个来源各一行。 */
export async function loadTrafficDaily(prisma: PrismaService, target: Target, from: string, to: string): Promise<{ rows: TrafficRow[]; truncated: boolean }> {
  const found = await prisma.salesTrafficAsinDaily.findMany({
    where: { tenantId: target.tenantId, sellerAccountId: target.storeId, asin: target.asin, asinGranularity: 'CHILD', currency: CURRENCY, date: { gte: asDate(from), lte: asDate(to) } },
    select: { date: true, source: true, sessions: true, pageViews: true, units: true, orderedSales: true, buyBoxPct: true, unitSessionPct: true },
    orderBy: [{ date: 'asc' }, { source: 'asc' }],
    take: ASIN360_TRAFFIC_ROW_LIMIT + 1,
  })
  const rows = found.slice(0, ASIN360_TRAFFIC_ROW_LIMIT).map<TrafficRow>(row => ({
    date: dateText(row.date),
    source: row.source,
    sessions: row.sessions,
    pageViews: row.pageViews,
    units: row.units,
    sales: num(row.orderedSales),
    buyBoxPct: num(row.buyBoxPct),
    unitSessionPct: num(row.unitSessionPct),
  }))
  return { rows, truncated: found.length > ASIN360_TRAFFIC_ROW_LIMIT }
}

/** 这家店的这些数据来源是否同步过：没同步过是“尚未接入”，同步过但没有数据是“尚无记录”。 */
export async function everSynced(prisma: PrismaService, target: Target, keys: readonly string[]): Promise<{ synced: boolean; noBrand: boolean }> {
  const rows = await prisma.dataFreshness.findMany({
    where: { tenantId: target.tenantId, sellerAccountId: target.storeId, sourceKey: { in: [...keys] } },
    select: { lastErrorCode: true, lastSuccessAt: true },
    take: keys.length * 2,
  })
  return { synced: rows.length > 0, noBrand: rows.length > 0 && rows.every(row => row.lastErrorCode === BA_NO_BRAND && !row.lastSuccessAt) }
}

/** 品牌分析类区块没有数据时的状态与原因。 */
export async function brandEmpty(prisma: PrismaService, target: Target, key: string, periodNote: string | null): Promise<{ state: 'NOT_CONNECTED' | 'NO_DATA'; note: string }> {
  const { synced, noBrand } = await everSynced(prisma, target, [key])
  if (noBrand) return { state: 'NOT_CONNECTED', note: BA_NO_BRAND_NOTE }
  if (!synced) return { state: 'NOT_CONNECTED', note: '这家店还没有同步过这份品牌分析报告：店铺具备品牌分析角色后，同步任务会按周、月自动申请，数据会自动出现' }
  return { state: 'NO_DATA', note: periodNote ?? BA_NO_DATA_NOTE }
}

const asDay = (text: string) => new Date(`${text}T00:00:00Z`)
const startsOf = (rows: ReadonlyArray<{ periodStart: Date }>) => rows.map(row => row.periodStart.toISOString().slice(0, 10))

/** 搜索查询表现里这个 ASIN 已有数据的周期起始日（最近的在前）。 */
export async function loadSqpStarts(prisma: PrismaService, target: Target, kind: BaPeriod): Promise<string[]> {
  const found = await prisma.brandSearchQueryPerformance.findMany({
    where: { tenantId: target.tenantId, sellerAccountId: target.storeId, reportPeriod: kind, asin: target.asin },
    distinct: ['periodStart'],
    select: { periodStart: true },
    orderBy: { periodStart: 'desc' },
    take: BA_PERIOD_OPTIONS_LIMIT,
  })
  return startsOf(found)
}

/** 目录表现里这个 ASIN 已有数据的周期起始日（最近的在前）。 */
export async function loadCatalogStarts(prisma: PrismaService, target: Target, kind: BaPeriod): Promise<string[]> {
  const found = await prisma.brandSearchCatalogPerformance.findMany({
    where: { tenantId: target.tenantId, sellerAccountId: target.storeId, reportPeriod: kind, asin: target.asin },
    distinct: ['periodStart'],
    select: { periodStart: true },
    orderBy: { periodStart: 'desc' },
    take: BA_PERIOD_OPTIONS_LIMIT,
  })
  return startsOf(found)
}

/** 一个周期里这个 ASIN 的全部搜索词（同一店铺同一 ASIN 一个词一行）。 */
export async function loadSqpTerms(prisma: PrismaService, target: Target, kind: BaPeriod, start: string): Promise<{ rows: TermRow[]; truncated: boolean }> {
  const found = await prisma.brandSearchQueryPerformance.findMany({
    where: { tenantId: target.tenantId, sellerAccountId: target.storeId, reportPeriod: kind, periodStart: asDay(start), asin: target.asin },
    select: {
      searchQuery: true,
      searchVolume: true,
      impressionsOwn: true,
      impressionsTotal: true,
      clicksOwn: true,
      clicksTotal: true,
      cartAddsOwn: true,
      cartAddsTotal: true,
      purchasesOwn: true,
      purchasesTotal: true,
      impressionShare: true,
      clickShare: true,
      cartAddShare: true,
      purchaseShare: true,
    },
    orderBy: [{ searchVolume: { sort: 'desc', nulls: 'last' } }, { searchQuery: 'asc' }],
    take: BA_ROW_LIMIT + 1,
  })
  const rows = found.slice(0, BA_ROW_LIMIT).map<TermRow>(row => ({
    searchQuery: row.searchQuery,
    searchVolume: row.searchVolume,
    own: { impressions: row.impressionsOwn, clicks: row.clicksOwn, cartAdds: row.cartAddsOwn, purchases: row.purchasesOwn },
    total: { impressions: row.impressionsTotal, clicks: row.clicksTotal, cartAdds: row.cartAddsTotal, purchases: row.purchasesTotal },
    official: { impression: num(row.impressionShare), click: num(row.clickShare), cartAdd: num(row.cartAddShare), purchase: num(row.purchaseShare) },
  }))
  return { rows, truncated: found.length > BA_ROW_LIMIT }
}

/** 热门搜索词报告里一个词的行（点击份额前三的商品）。 */
export interface HotTermRow {
  searchTerm: string
  frequencyRank: number | null
  slots: Array<{ asin: string | null; title: string | null; clickShare: number | null; conversionShare: number | null }>
}

/** 一个周期里这些搜索词在热门搜索词报告里的行（同一个词在多个部门时，搜索频率排名最靠前的在前）。 */
export async function loadHotTerms(prisma: PrismaService, target: Target, kind: BaPeriod, start: string, terms: readonly string[]): Promise<HotTermRow[]> {
  if (terms.length === 0) return []
  const found = await prisma.brandSearchTerm.findMany({
    where: {
      tenantId: target.tenantId,
      sellerAccountId: target.storeId,
      reportPeriod: kind,
      periodStart: asDay(start),
      searchTerm: { in: [...new Set([...terms, ...terms.map(term => term.toLowerCase())])] },
    },
    select: {
      searchTerm: true,
      searchFrequencyRank: true,
      clickedAsin1: true,
      clickedTitle1: true,
      clickShare1: true,
      conversionShare1: true,
      clickedAsin2: true,
      clickedTitle2: true,
      clickShare2: true,
      conversionShare2: true,
      clickedAsin3: true,
      clickedTitle3: true,
      clickShare3: true,
      conversionShare3: true,
    },
    orderBy: [{ searchFrequencyRank: { sort: 'asc', nulls: 'last' } }, { department: 'asc' }],
    take: 200,
  })
  return found.map<HotTermRow>(row => ({
    searchTerm: row.searchTerm,
    frequencyRank: row.searchFrequencyRank,
    slots: [
      { asin: row.clickedAsin1, title: row.clickedTitle1, clickShare: num(row.clickShare1), conversionShare: num(row.conversionShare1) },
      { asin: row.clickedAsin2, title: row.clickedTitle2, clickShare: num(row.clickShare2), conversionShare: num(row.conversionShare2) },
      { asin: row.clickedAsin3, title: row.clickedTitle3, clickShare: num(row.clickShare3), conversionShare: num(row.conversionShare3) },
    ],
  }))
}

/** 一个周期里这个 ASIN 的目录表现（搜索流量的展示、点击、加购、购买）。 */
export async function loadCatalogMetrics(prisma: PrismaService, target: Target, kind: BaPeriod, start: string): Promise<Asin360CatalogMetrics | null> {
  const row = await prisma.brandSearchCatalogPerformance.findFirst({
    where: { tenantId: target.tenantId, sellerAccountId: target.storeId, reportPeriod: kind, periodStart: asDay(start), asin: target.asin },
    select: { impressions: true, clicks: true, cartAdds: true, purchases: true, clickRate: true, conversionRate: true, searchTrafficSales: true, currency: true },
  })
  if (!row) return null
  const currency = row.currency
  return {
    impressions: row.impressions,
    clicks: row.clicks,
    cartAdds: row.cartAdds,
    purchases: row.purchases,
    clickRate: num(row.clickRate),
    conversionRate: num(row.conversionRate),
    // 非美元的销售额不当作美元
    searchTrafficSales: currency && currency !== CURRENCY ? null : num(row.searchTrafficSales),
    currency,
  }
}
