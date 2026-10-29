import type { DashState, DashCompare, DashPeriod } from './dashboard'
import type { ADS_WRITE_PENDING, AdsCampaignRatios } from './ads-campaigns'
import type { AdsCampaignChangesResponse, AdsCampaignHourlyResponse, AdsCampaignTrendResponse, AdsEntityMetrics, AdsTabList, AdsTabShell } from './ads-campaigns-tabs'
import { addTotals, adsRatios, type AdsTotals } from './ads-overview-math'

// 广告组与投放对象详情契约（P3-08，08 章 8.4、8.5）：只有常量、类型与纯函数，没有 zod（列表型页签沿用 ads-campaigns-query.ts 的分页参数）。
// 数据来源：活动管理接口同步的广告组、广告、投放对象（AdsAdGroup、AdsAd、AdsTarget、AdsKeyword、AdsNegativeTarget）；指标来自指标表（AdsMetric 按对象类型）、词级报表（AdsTermMetric）与营销数据流小时指标。
// 没有数据的块写“尚无记录”，同步器未交付的块写“尚未接入”，空值不是 0。本包只读：修改默认竞价、暂停启用、调价、否定的写入在 P3-17 接入（页面顶部的按钮，先预览再提交）。

export const ADS_GROUP_ENTITY_TYPE = 'ADS_AD_GROUP'
export const ADS_TARGET_ENTITY_TYPE = 'ADS_TARGET'
/** 投放对象调价的变更事件种类（写亚马逊的包 P3-17 写入，详情的“竞价历史与效果”页签读它；格式见 AdsBidChangeDetail）。 */
export const ADS_TARGET_BID_EVENT_KIND = 'ads.target.bid'
/** 调价前后各看几天的指标做对照。 */
export const ADS_BID_EFFECT_DAYS = 7
export const ADS_BID_HISTORY_LIMIT = 50

export const ADS_GROUP_WRITE_NOTE = '修改默认竞价、暂停与启用、添加否定投放与关键词用页面顶部的按钮（先预览再提交，由后台写入亚马逊）；这个页签里的单项动作暂未提供入口，请在亚马逊广告后台操作'
export const ADS_TARGET_WRITE_NOTE = '调价与暂停、启用用页面顶部的按钮（先预览再提交，由后台写入亚马逊）；“设为否定”请到所属广告组添加否定投放，这个入口暂未提供'

// ---- 页签 ----

export const ADS_GROUP_TABS = [
  { key: 'trend', label: '表现趋势' },
  { key: 'targets', label: '投放对象' },
  { key: 'search-terms', label: '搜索词' },
  { key: 'products', label: '广告商品' },
  { key: 'negatives', label: '否定投放' },
  { key: 'hourly', label: '分时表现' },
  { key: 'history', label: '操作记录' },
] as const
export type AdsGroupTabKey = (typeof ADS_GROUP_TABS)[number]['key']

/** 投放对象页签；品牌分析只有关键词类才有。 */
export const ADS_TARGET_TABS = [
  { key: 'trend', label: '趋势' },
  { key: 'search-terms', label: '带来的搜索词' },
  { key: 'placements', label: '广告位' },
  { key: 'hourly', label: '分时表现' },
  { key: 'bid-history', label: '竞价历史与效果' },
  { key: 'brand-analytics', label: '品牌分析', onlyKeyword: true },
] as const
export type AdsTargetTabKey = (typeof ADS_TARGET_TABS)[number]['key']

export function adsTargetTabsFor(kind: string): Array<{ key: AdsTargetTabKey; label: string }> {
  return ADS_TARGET_TABS.filter(tab => !('onlyKeyword' in tab) || kind === 'KEYWORD').map(tab => ({ key: tab.key, label: tab.label }))
}

// ---- 身份区与详情 ----

export interface AdsEntityAccount {
  name: string
  adsAccountId: string | null
  storeName: string | null
  bindingStatus: string
}
export interface AdsParentCampaign {
  /** 系统编号（AdsCampaign.id）；活动还没有同步时为 null，页面不给链接。 */
  id: string | null
  externalCampaignId: string
  name: string | null
  productLabel: string | null
}
export interface AdsEntityMetricsBlock {
  state: DashState
  note: string | null
  period: DashPeriod
  compare: DashCompare | null
  totals: AdsTotals | null
  previous: AdsTotals | null
  ratios: AdsCampaignRatios | null
  previousRatios: AdsCampaignRatios | null
}

export interface AdsGroupIdentity {
  id: string
  adsProfileId: string
  adGroupId: string
  name: string
  state: string
  defaultBid: number | null
  currency: string
  campaign: AdsParentCampaign
  account: AdsEntityAccount
  syncedAt: string
}
export interface AdsGroupDetailResponse {
  identity: AdsGroupIdentity
  metrics: AdsEntityMetricsBlock
  tabs: Array<{ key: AdsGroupTabKey; label: string }>
  write: { state: typeof ADS_WRITE_PENDING.state; note: string }
}

/** 官方推荐给的建议竞价：区间两端与单点值，原文里没有的为 null（字段名是假设，没有对真实账户核对）。 */
export interface AdsSuggestedBid {
  low: number | null
  high: number | null
  point: number | null
  /** 推荐原文的收到时间；没有推荐为 null。 */
  receivedAt: string | null
}
export interface AdsTargetIdentity {
  id: string
  adsProfileId: string
  targetId: string
  kind: string
  kindLabel: string
  expression: string
  matchType: string | null
  state: string
  bid: number | null
  currency: string
  suggestedBid: AdsSuggestedBid | null
  campaign: AdsParentCampaign
  adGroup: { id: string | null; adGroupId: string; name: string | null }
  account: AdsEntityAccount
  syncedAt: string
}
export interface AdsTargetDetailResponse {
  identity: AdsTargetIdentity
  metrics: AdsEntityMetricsBlock
  tabs: Array<{ key: AdsTargetTabKey; label: string }>
  write: { state: typeof ADS_WRITE_PENDING.state; note: string }
}

// ---- 页签响应（趋势、分时、操作记录与活动共用同一形状）----

export type AdsEntityTrendResponse = AdsCampaignTrendResponse
export type AdsEntityHourlyResponse = AdsCampaignHourlyResponse
export type AdsEntityChangesResponse = AdsCampaignChangesResponse

export interface AdsGroupProductRow {
  adId: string
  asin: string | null
  sku: string | null
  state: string
  title: string | null
  imageUrl: string | null
  /** 广告级指标（指标表对象类型 AD）；没有行为 null。 */
  metrics: AdsEntityMetrics | null
  sellable: number | null
  snapshotDate: string | null
  stock: 'OUT_OF_STOCK' | 'IN_STOCK' | 'UNKNOWN'
}
export interface AdsNegativeRow {
  negativeId: string
  level: 'CAMPAIGN' | 'AD_GROUP'
  expression: string
  matchType: string
}
export interface AdsNegativeList extends AdsTabList<AdsNegativeRow> {
  write: { state: typeof ADS_WRITE_PENDING.state; note: string }
}
export interface AdsTargetTermRow {
  searchTerm: string
  /** 搜索词命中的投放表达式（词级报表给的）；没给为 null。 */
  matchedExpression: string | null
  metrics: AdsEntityMetrics
}
export interface AdsTargetTermList extends AdsTabList<AdsTargetTermRow> {
  period: DashPeriod
}
export interface AdsTargetPlacementResponse extends AdsTabShell {
  /** 活动级广告位表现在活动详情里；这里只给指引，不放活动级数字冒充投放对象的。 */
  campaignId: string | null
}

export interface AdsBidChangeDetail {
  before: { bid: number | null }
  after: { bid: number | null }
}
export interface AdsBidEffectSide {
  days: number
  /** 前后窗口里有指标行的天数；0 说明没有数据可对照。 */
  daysWithData: number
  totals: AdsTotals | null
  ratios: AdsCampaignRatios | null
}
export interface AdsBidChangeRow {
  id: string
  at: string
  actor: string
  source: 'system' | 'manual'
  beforeBid: number | null
  afterBid: number | null
  title: string
  before: AdsBidEffectSide
  after: AdsBidEffectSide
}
export interface AdsTargetBidHistoryResponse {
  current: { bid: number | null; currency: string; suggestedBid: AdsSuggestedBid | null }
  /** 本系统内的调价（P3-17 起写入）。 */
  changes: AdsTabShell & { items: AdsBidChangeRow[]; truncated: boolean }
  /** 亚马逊侧或其他工具做的调价没有同步器。 */
  amazonSide: { state: 'NOT_CONNECTED'; note: string }
  write: { state: typeof ADS_WRITE_PENDING.state; note: string }
}
export interface AdsTargetBrandResponse extends AdsTabShell {
  keyword: string
}

// ---- 纯函数 ----

type Json = unknown
const asRecord = (value: Json): Record<string, Json> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Json>) : null)
const asNumber = (value: Json): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}
const firstNumber = (nodes: ReadonlyArray<Record<string, Json>>, keys: readonly string[]): number | null => {
  for (const node of nodes)
    for (const key of keys) {
      const value = asNumber(node[key])
      if (value !== null) return value
    }
  return null
}

/** 从推荐原文读建议竞价区间：顶层与下一层找 suggestedBid（单点）、suggestedBidLow/rangeStart（下限）、suggestedBidHigh/rangeEnd（上限）；三个都没有为 null。字段名是假设。 */
export function suggestedBidOf(payload: Json, receivedAt: string | null): AdsSuggestedBid | null {
  const top = asRecord(payload)
  if (!top) return null
  const nodes = [top, ...Object.values(top).flatMap(child => (asRecord(child) ? [asRecord(child)!] : []))]
  const low = firstNumber(nodes, ['suggestedBidLow', 'bidLow', 'rangeStart', 'lowerBound'])
  const high = firstNumber(nodes, ['suggestedBidHigh', 'bidHigh', 'rangeEnd', 'upperBound'])
  const point = firstNumber(nodes, ['suggestedBid', 'recommendedBid', 'bid'])
  return low === null && high === null && point === null ? null : { low, high, point, receivedAt }
}

/** 变更事件详情里的前后竞价；格式不对为 null。 */
export function bidChangeOf(detail: Json): AdsBidChangeDetail | null {
  const record = asRecord(detail)
  const before = asRecord(record?.before)
  const after = asRecord(record?.after)
  if (!before || !after) return null
  return { before: { bid: asNumber(before.bid) }, after: { bid: asNumber(after.bid) } }
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000)

/** 调价当天（企业时区日期）前后各 days 天的合计：前窗口是调价前一天往前，后窗口是调价后一天往后（调价当天两边都不算，因为当天前后混在一起）。 */
export function bidEffectWindows(daily: ReadonlyMap<string, AdsTotals>, changeDate: string, days: number = ADS_BID_EFFECT_DAYS): { before: AdsBidEffectSide; after: AdsBidEffectSide } {
  const center = dayNumber(changeDate)
  const side = (from: number, to: number): AdsBidEffectSide => {
    const rows: AdsTotals[] = []
    for (let day = from; day <= to; day += 1) {
      const row = daily.get(new Date(day * 86_400_000).toISOString().slice(0, 10))
      if (row) rows.push(row)
    }
    if (rows.length === 0) return { days, daysWithData: 0, totals: null, ratios: null }
    const totals = addTotals(rows)
    return { days, daysWithData: rows.length, totals, ratios: adsRatios(totals) }
  }
  return { before: side(center - days, center - 1), after: side(center + 1, center + days) }
}
