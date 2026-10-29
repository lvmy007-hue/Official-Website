import { addTotals, adsRatios, type AdsRatios, type AdsTotals } from './ads-overview-math'
import type { CursorPageInfo } from './query'

// 广告层级页的公共契约（P6-23，16 章第 8 节）：活动、广告组、投放、搜索词、广告商品五个列表共用的区间筛选、分类计数与汇总行。
// 纯函数与常量，没有 zod：筛选参数的取值范围写在 ADS_RANGE_FILTERS 里，各列表的请求校验把它展开进自己的 filters。

export const ADS_LEVELS = ['campaigns', 'ad-groups', 'targets', 'search-terms', 'products'] as const
export type AdsLevel = (typeof ADS_LEVELS)[number]
export const ADS_LEVEL_LABEL: Record<AdsLevel, string> = { campaigns: '广告活动', 'ad-groups': '广告组', targets: '投放', 'search-terms': '搜索词', products: '广告商品' }
export const isAdsLevel = (value: string): value is AdsLevel => (ADS_LEVELS as readonly string[]).includes(value)

// ---- 分类计数（投放与搜索词的四类，其余层级也能用）----

export const ADS_BUCKETS = ['CONVERTED', 'CLICK_NO_ORDER', 'IMPRESSION_NO_CLICK', 'NO_IMPRESSION'] as const
export type AdsBucket = (typeof ADS_BUCKETS)[number]
export const ADS_BUCKET_LABEL: Record<AdsBucket, string> = { CONVERTED: '有成交', CLICK_NO_ORDER: '有点击无成交', IMPRESSION_NO_CLICK: '有曝光无点击', NO_IMPRESSION: '无曝光' }
export const ADS_BUCKET_RULE = '四类互斥、按先后判断：订单大于 0 算有成交；否则点击大于 0 算有点击无成交；否则曝光大于 0 算有曝光无点击；其余算无曝光。'

/** 一行属于哪一类：只看范围内的曝光、点击、订单。 */
export function adsBucketOf(totals: Pick<AdsTotals, 'impressions' | 'clicks' | 'orders'>): AdsBucket {
  if (totals.orders > 0) return 'CONVERTED'
  if (totals.clicks > 0) return 'CLICK_NO_ORDER'
  if (totals.impressions > 0) return 'IMPRESSION_NO_CLICK'
  return 'NO_IMPRESSION'
}

export type AdsBucketCounts = Record<AdsBucket, number>
export const emptyBucketCounts = (): AdsBucketCounts => ({ CONVERTED: 0, CLICK_NO_ORDER: 0, IMPRESSION_NO_CLICK: 0, NO_IMPRESSION: 0 })

/** 没有指标（null）的行不进任何一类，单独数在 withoutMetrics 里，不当 0 曝光。 */
export function countBuckets(items: ReadonlyArray<AdsTotals | null>): { buckets: AdsBucketCounts; withoutMetrics: number } {
  const buckets = emptyBucketCounts()
  let withoutMetrics = 0
  for (const item of items) {
    if (!item) withoutMetrics += 1
    else buckets[adsBucketOf(item)] += 1
  }
  return { buckets, withoutMetrics }
}

export const inBucket = (totals: AdsTotals | null, bucket: AdsBucket | undefined): boolean => !bucket || (totals !== null && adsBucketOf(totals) === bucket)

// ---- 指标区间筛选 ----

export const ADS_RANGE_METRICS = ['spend', 'sales', 'acos', 'ctr', 'cpc', 'cvr', 'impressions', 'clicks', 'orders'] as const
export type AdsRangeMetric = (typeof ADS_RANGE_METRICS)[number]
export const ADS_RANGE_LABEL: Record<AdsRangeMetric, string> = {
  spend: '花费',
  sales: '广告销售额',
  acos: '广告成本销售比',
  ctr: '点击率',
  cpc: '单次点击成本',
  cvr: '转化率',
  impressions: '曝光',
  clicks: '点击',
  orders: '订单',
}
/** 比率类指标：接口里是小数（0.2 表示 20%），页面上按百分数输入。 */
export const ADS_RANGE_PERCENT: ReadonlySet<AdsRangeMetric> = new Set<AdsRangeMetric>(['acos', 'ctr', 'cvr'])

export type AdsRangeQuery = { [K in AdsRangeMetric as `${K}Min` | `${K}Max`]?: number }

const bound = { type: 'number', min: 0, max: 1_000_000_000 } as const
/** 展开进各列表请求校验的 filters（number 类型，由 cursorListQuery 校验）。 */
export const ADS_RANGE_FILTERS = {
  spendMin: bound,
  spendMax: bound,
  salesMin: bound,
  salesMax: bound,
  acosMin: bound,
  acosMax: bound,
  ctrMin: bound,
  ctrMax: bound,
  cpcMin: bound,
  cpcMax: bound,
  cvrMin: bound,
  cvrMax: bound,
  impressionsMin: bound,
  impressionsMax: bound,
  clicksMin: bound,
  clicksMax: bound,
  ordersMin: bound,
  ordersMax: bound,
} as const

/** 分类筛选与区间筛选一起展开。 */
export const ADS_LEVEL_FILTERS = { ...ADS_RANGE_FILTERS, bucket: { type: 'enum', values: ADS_BUCKETS } } as const

/** 区间筛选与分类计数不属于“对象自己的筛选”，计数接口要先剔除分页与排序参数。 */
export const ADS_COUNTS_STRIPPED_KEYS = ['bucket', 'cursor', 'pageSize', 'sort'] as const

export const rangeKeysOf = (metric: AdsRangeMetric) => [`${metric}Min`, `${metric}Max`] as const

export function hasRangeFilter(query: AdsRangeQuery): boolean {
  return ADS_RANGE_METRICS.some(metric => query[`${metric}Min`] !== undefined || query[`${metric}Max`] !== undefined)
}

/** 下限大于上限等不合法的组合：返回第一条问题，没问题为 null。 */
export function adsRangeIssue(query: AdsRangeQuery): string | null {
  for (const metric of ADS_RANGE_METRICS) {
    const min = query[`${metric}Min`]
    const max = query[`${metric}Max`]
    if (min !== undefined && max !== undefined && min > max) return `${ADS_RANGE_LABEL[metric]}的下限不能大于上限`
  }
  return null
}

function metricValue(metric: AdsRangeMetric, totals: AdsTotals, ratios: AdsRatios): number | null {
  switch (metric) {
    case 'spend':
      return totals.spend
    case 'sales':
      return totals.sales
    case 'impressions':
      return totals.impressions
    case 'clicks':
      return totals.clicks
    case 'orders':
      return totals.orders
    default:
      return ratios[metric]
  }
}

/** 一行是否落在所有设置的区间内；没有指标或指标值为空（比如没有销售额算不出广告成本销售比）的行，设了对应区间就不命中，不当 0。 */
export function inAdsRanges(totals: AdsTotals | null, query: AdsRangeQuery): boolean {
  if (!hasRangeFilter(query)) return true
  if (!totals) return false
  const ratios = adsRatios(totals)
  for (const metric of ADS_RANGE_METRICS) {
    const min = query[`${metric}Min`]
    const max = query[`${metric}Max`]
    if (min === undefined && max === undefined) continue
    const value = metricValue(metric, totals, ratios)
    if (value === null) return false
    // 比率按四位小数比较，避免 0.54 ÷ 18 这类浮点误差让“刚好等于”的行被挡掉
    const compared = ADS_RANGE_PERCENT.has(metric) || metric === 'cpc' ? Math.round(value * 10_000) / 10_000 : value
    if (min !== undefined && compared < min) return false
    if (max !== undefined && compared > max) return false
  }
  return true
}

// ---- 汇总行 ----

export interface AdsLevelSummary {
  /** 筛选后的对象个数。 */
  total: number
  /** 其中有指标的对象合计（没有指标的不计，也不当 0）。 */
  totals: AdsTotals
  ratios: AdsRatios
  /** 筛选后没有指标的对象个数。 */
  withoutMetrics: number
}

export function summarizeLevel(items: ReadonlyArray<AdsTotals | null>): AdsLevelSummary {
  const measured = items.filter((item): item is AdsTotals => item !== null)
  const totals = addTotals(measured)
  return { total: items.length, totals, ratios: adsRatios(totals), withoutMetrics: items.length - measured.length }
}

// ---- 分类计数接口 ----

export interface AdsLevelCountsResponse {
  level: AdsLevel
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  range: { from: string; to: string; defaulted: boolean }
  /** 当前筛选后的对象个数（分类筛选之前）。 */
  total: number
  buckets: AdsBucketCounts
  withoutMetrics: number
  rule: string
  /** 读取上限导致只数了一部分。 */
  truncated: boolean
}

// ---- 广告组列表 ----

export const ADS_AD_GROUP_SORTS = ['spend', 'sales', 'orders', 'clicks', 'impressions', 'acos', 'roas', 'ctr', 'cpc', 'cvr', 'name', 'defaultBid'] as const
export type AdsAdGroupSort = (typeof ADS_AD_GROUP_SORTS)[number]
export const ADS_AD_GROUP_ROW_LIMIT = 5000

export interface AdsAdGroupListRow {
  /** 系统编号（AdsAdGroup.id），详情页地址与趋势小窗用它。 */
  id: string
  adsProfileId: string
  adGroupId: string
  name: string
  state: string
  defaultBid: number | null
  campaignId: string | null
  campaignName: string | null
  externalCampaignId: string
  portfolioId: string | null
  currency: string
  storeName: string | null
  accountName: string | null
  /** 范围内合计（指标表，美元）；没有指标行或不是美元为 null，不当 0。 */
  totals: AdsTotals | null
  ratios: AdsRatios | null
}

export interface AdsAdGroupListResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: AdsAdGroupListRow[]
  pageInfo: CursorPageInfo
  range: { from: string; to: string; defaulted: boolean }
  currency: 'USD'
  summary: AdsLevelSummary
  filterOptions: { portfolios: Array<{ id: string; name: string }> }
  truncated: boolean
}
