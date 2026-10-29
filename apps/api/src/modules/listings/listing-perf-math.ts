import {
  LISTING_ANOMALY_INFO,
  LISTING_DEMAND_DAYS,
  LISTING_MIN_SESSIONS,
  isConversionDrop,
  listingConversion,
  listingDaysOfSupply,
  listingReturnRate,
  type ListingAnomalySummary,
  type ListingPerfRow,
  type ListingTrendPoint,
} from '@nova/api-contracts'
import { nullableSum } from '../overview'

// 刊登表现的纯计算（P4-09，不访问数据库）：来源取舍、装配行、异常分布、逐日趋势。
// 约定：官方没给的值是 null，不当 0；合计只加有值的行，整段都没有值才是 null。

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits
const roundOrNull = (value: number | null, digits: number) => (value === null ? null : round(value, digits))

export interface ProductRecord {
  id: string
  sellerAccountId: string
  storeName: string
  asin: string
  sellerSku: string
  title: string
  imageUrl: string | null
  brand: string | null
  listingStatus: string
  fulfillmentChannel: string
  price: number | null
  currency: string
  ownerUserId: string | null
  updatedAt: Date
}

/** 一个店铺 × ASIN 在一段日期里的销售与流量合计。 */
export interface TrafficFact {
  sessions: number | null
  pageViews: number | null
  units: number | null
  sales: number | null
  /** 日值的简单平均。 */
  buyBox: number | null
}

export interface TrafficGroup extends TrafficFact {
  sellerAccountId: string
  asin: string
  source: string
}

export const factKey = (storeId: string, asin: string) => `${storeId}|${asin}`
export const skuKey = (storeId: string, sku: string) => `${storeId}\u001f${sku}`

/** 同店同 ASIN 两个来源都有时整段范围只用数据中心的合计（不逐日混合），没有才用报告补充。 */
export function preferTraffic(groups: readonly TrafficGroup[]): Map<string, TrafficFact> {
  const best = new Map<string, TrafficGroup>()
  for (const group of groups) {
    const key = factKey(group.sellerAccountId, group.asin)
    const held = best.get(key)
    if (!held || (group.source === 'DATA_KIOSK' && held.source !== 'DATA_KIOSK')) best.set(key, group)
  }
  return new Map([...best].map(([key, group]) => [key, { sessions: group.sessions, pageViews: group.pageViews, units: group.units, sales: group.sales, buyBox: group.buyBox }]))
}

export interface BuildInput {
  records: readonly ProductRecord[]
  current: ReadonlyMap<string, TrafficFact>
  previous: ReadonlyMap<string, TrafficFact>
  /** 店铺 × ASIN 的广告销售额（只含有值的）；没有 ads.read 时为 null。 */
  ads: ReadonlyMap<string, number> | null
  /** 店铺 × ASIN 范围内的退货件数；没有 returns.read 或退货记录从没同步过为 null。 */
  returns: ReadonlyMap<string, number> | null
  /** 店铺 × ASIN 范围最后几天的订购件数；没有数据为空表。 */
  recentUnits: ReadonlyMap<string, number>
  /** 店铺 × SKU 的可售数量；没有 inventory.read 时为 null。 */
  stock: ReadonlyMap<string, number> | null
  /** 日均订购件数用的天数（范围不足 7 天时是范围天数）。 */
  demandDays: number
  names: ReadonlyMap<string, string>
  formerLabel: string
}

export function buildListingRows(input: BuildInput): ListingPerfRow[] {
  const perAsin = new Map<string, number>()
  for (const record of input.records) perAsin.set(factKey(record.sellerAccountId, record.asin), (perAsin.get(factKey(record.sellerAccountId, record.asin)) ?? 0) + 1)
  return input.records.map(record => {
    const key = factKey(record.sellerAccountId, record.asin)
    const now = input.current.get(key)
    const before = input.previous.get(key)
    const sessions = now?.sessions ?? null
    const units = now?.units ?? null
    const conversion = listingConversion(units, sessions)
    const sessionsPrev = before?.sessions ?? null
    const conversionPrev = listingConversion(before?.units ?? null, sessionsPrev)
    const sellable = input.stock?.get(skuKey(record.sellerAccountId, record.sellerSku)) ?? null
    return {
      id: record.id,
      sellerAccountId: record.sellerAccountId,
      storeName: record.storeName,
      asin: record.asin,
      sku: record.sellerSku,
      title: record.title,
      imageUrl: record.imageUrl,
      brand: record.brand,
      listingStatus: record.listingStatus,
      fulfillmentChannel: record.fulfillmentChannel,
      price: record.price,
      currency: record.currency,
      sessions,
      pageViews: now?.pageViews ?? null,
      units,
      sales: roundOrNull(now?.sales ?? null, 2),
      conversion,
      buyBox: roundOrNull(now?.buyBox ?? null, 6),
      sessionsPrev,
      conversionPrev,
      adsSales: roundOrNull(input.ads?.get(key) ?? null, 2),
      returnRate: input.returns === null ? null : listingReturnRate(input.returns.get(key) ?? 0, units),
      daysOfSupply: listingDaysOfSupply(sellable, input.recentUnits.get(key) ?? null, input.demandDays),
      salesShared: now !== undefined && (perAsin.get(key) ?? 0) > 1,
      anomalies: isConversionDrop({ sessions, conversion }, { sessions: sessionsPrev, conversion: conversionPrev }) ? ['CONVERSION_DROP'] : [],
      ownerUserId: record.ownerUserId,
      ownerName: record.ownerUserId ? (input.names.get(record.ownerUserId) ?? input.formerLabel) : null,
      updatedAt: record.updatedAt.toISOString(),
    }
  })
}

/** 日均订购件数用的天数：范围最后 7 天，范围不足 7 天用范围天数。 */
export const demandDaysOf = (rangeDays: number) => Math.max(1, Math.min(LISTING_DEMAND_DAYS, rangeDays))

// ---- 异常分布 ----

const hasComparison = (row: ListingPerfRow) => row.conversion !== null && row.conversionPrev !== null && row.sessions !== null && row.sessionsPrev !== null

/** 四类异常的分布：转化率骤降现在算得出来；其余三类来源还没交付，计数是 null（不是 0）并写明工作包。 */
export function anomalySummary(rows: readonly ListingPerfRow[]): ListingAnomalySummary[] {
  const comparable = rows.filter(hasComparison).length
  const enough = rows.filter(row => hasComparison(row) && row.sessions! >= LISTING_MIN_SESSIONS && row.sessionsPrev! >= LISTING_MIN_SESSIONS).length
  const drop = rows.filter(row => row.anomalies.includes('CONVERSION_DROP')).length
  const noData = comparable === 0
  return [
    {
      kind: 'CONVERSION_DROP',
      label: LISTING_ANOMALY_INFO.CONVERSION_DROP.label,
      state: noData ? 'NO_DATA' : 'OK',
      count: noData ? null : drop,
      note: noData ? '没有商品同时有本期与上一周期的会话与件数记录，无法判断转化率变化' : `${LISTING_ANOMALY_INFO.CONVERSION_DROP.basis}；${enough} 个商品两期样本足够参与判断，其余样本不足不判断`,
    },
    ...(['OFFER_LOST', 'ISSUE_NEW', 'SUPPRESSED'] as const).map<ListingAnomalySummary>(kind => ({
      kind,
      label: LISTING_ANOMALY_INFO[kind].label,
      state: 'NOT_CONNECTED',
      count: null,
      note: `${LISTING_ANOMALY_INFO[kind].basis}（由 ${LISTING_ANOMALY_INFO[kind].pendingWorkPackage} 交付）`,
    })),
  ]
}

// ---- 逐日趋势 ----

/** 店铺 × 日 × 来源的合计（已在数据库里按这三项汇总）。 */
export interface DailyGroup {
  sellerAccountId: string
  date: string
  source: string
  sessions: number | null
  pageViews: number | null
  units: number | null
  sales: number | null
  buyBoxSum: number | null
  buyBoxCount: number
}

/** 同店同日两个来源都有时只用数据中心；逐日跨店铺相加；转化率只用件数与会话同一组都有值的相除；购物车获得率是该日全部 ASIN 日值的简单平均。 */
export function trendPoints(days: readonly string[], groups: readonly DailyGroup[]): ListingTrendPoint[] {
  const best = new Map<string, DailyGroup>()
  for (const group of groups) {
    const key = `${group.sellerAccountId}|${group.date}`
    const held = best.get(key)
    if (!held || (group.source === 'DATA_KIOSK' && held.source !== 'DATA_KIOSK')) best.set(key, group)
  }
  const byDate = new Map<string, DailyGroup[]>()
  for (const group of best.values()) byDate.set(group.date, [...(byDate.get(group.date) ?? []), group])
  return days.map<ListingTrendPoint>(date => {
    const day = byDate.get(date) ?? []
    const paired = day.filter(group => group.units !== null && group.sessions !== null)
    const sessionsBase = paired.reduce((total, group) => total + group.sessions!, 0)
    const buyBoxCount = day.reduce((total, group) => total + group.buyBoxCount, 0)
    return {
      date,
      sessions: nullableSum(day.map(group => group.sessions)),
      pageViews: nullableSum(day.map(group => group.pageViews)),
      units: nullableSum(day.map(group => group.units)),
      sales: roundOrNull(nullableSum(day.map(group => group.sales)), 2),
      conversion: sessionsBase > 0 ? round(paired.reduce((total, group) => total + group.units!, 0) / sessionsBase, 6) : null,
      buyBox: buyBoxCount > 0 ? round(day.reduce((total, group) => total + (group.buyBoxSum ?? 0), 0) / buyBoxCount, 6) : null,
    }
  })
}
