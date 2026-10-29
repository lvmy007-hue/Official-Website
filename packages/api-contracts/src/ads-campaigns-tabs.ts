import type { CursorPageInfo } from './query'
import type { DashState, DashCompare, DashPeriod } from './dashboard'
import type { AdsAttributionSection } from './ads-overview'
import type { AdsTotals } from './ads-overview-math'
import type { ADS_WRITE_PENDING } from './ads-campaigns'

// 广告活动各页签的响应类型（P3-07）。常量与列表、详情类型在 ads-campaigns.ts。

// ---- 页签响应 ----

export interface AdsTabShell {
  state: DashState
  note: string | null
}

export interface AdsTrendPointDay {
  date: string
  impressions: number | null
  clicks: number | null
  spend: number | null
  sales: number | null
  orders: number | null
}
export interface AdsCampaignTrendResponse extends AdsTabShell {
  period: DashPeriod
  compare: DashCompare | null
  /** 活动自己的币种（趋势按这个币种读汇总，不折算）。 */
  currency: string
  points: AdsTrendPointDay[]
  previousPoints: AdsTrendPointDay[]
  totals: AdsTotals | null
  previous: AdsTotals | null
  /** 我方改动（标签、负责人）按日标注；亚马逊侧变更没有同步器。 */
  events: Array<{ date: string; label: string; kind: string }>
  amazonEvents: { state: 'NOT_CONNECTED'; note: string }
  attribution: AdsAttributionSection
}

export interface AdsHourlyCell {
  /** 周一为 0，周日为 6（企业时区）。 */
  weekday: number
  hour: number
  spend: number | null
  clicks: number
  orders: number
  sales: number | null
  /** 这个格子累计了多少个自然日的小时数据。 */
  samples: number
}
export interface AdsCampaignHourlyResponse extends AdsTabShell {
  streamConnected: boolean
  historyDays: number
  cells: AdsHourlyCell[]
  reportHours: { state: 'NOT_CONNECTED'; note: string }
}

export interface AdsEntityMetrics {
  impressions: number
  clicks: number
  spend: number | null
  sales: number | null
  orders: number
}
export interface AdsAdGroupRow {
  /** 系统编号（AdsAdGroup.id），广告组详情页地址用它。 */
  id: string
  adGroupId: string
  name: string
  state: string
  defaultBid: number | null
  metrics: AdsEntityMetrics | null
}
export interface AdsTargetRow {
  /** 系统编号（关键词表或投放表的 id），投放对象详情页地址用它。 */
  id: string
  key: string
  targetId: string
  kind: string
  expression: string
  matchType: string | null
  bid: number | null
  state: string
  adGroupId: string
  adGroupName: string | null
  /** 官方推荐里的建议竞价（取自推荐原文里的 suggestedBid，没有为 null）。 */
  suggestedBid: number | null
  metrics: AdsEntityMetrics | null
}
export type AdsTermStatus = 'TARGETED' | 'NEGATED' | 'UNTARGETED'
export const ADS_TERM_STATUS_LABEL: Record<AdsTermStatus, string> = { TARGETED: '已投放', NEGATED: '已否定', UNTARGETED: '未投放' }
export interface AdsSearchTermRow {
  searchTerm: string
  status: AdsTermStatus
  metrics: AdsEntityMetrics
}
export interface AdsCampaignProductRow {
  asin: string
  title: string | null
  imageUrl: string | null
  metrics: AdsEntityMetrics
  /** 最近一次库存快照的可售数量；没有快照或没给为 null。 */
  sellable: number | null
  snapshotDate: string | null
  stock: 'OUT_OF_STOCK' | 'IN_STOCK' | 'UNKNOWN'
}
export interface AdsPlacementRow {
  placement: string
  label: string
  metrics: AdsEntityMetrics
}
export interface AdsCreativeRow {
  creativeId: string
  adId: string
  kind: string
  headline: string | null
  landingPage: string | null
  assetCount: number
}
export interface AdsAudienceRow {
  targetId: string
  expression: string
  state: string
  bid: number | null
  adGroupId: string
}

/** 列表型页签的响应：行、分页与读取说明。 */
export interface AdsTabList<T> extends AdsTabShell {
  items: T[]
  pageInfo: CursorPageInfo
  truncated: boolean
}
export interface AdsTermList extends AdsTabList<AdsSearchTermRow> {
  period: DashPeriod
  /** 标记已投放与已否定的口径：搜索词与投放词完全相同（不分大小写与多余空格），广泛、词组匹配的命中不算。 */
  matchBasis: string
  write: typeof ADS_WRITE_PENDING
}
export interface AdsCampaignProductList extends AdsTabList<AdsCampaignProductRow> {
  period: DashPeriod
}
export interface AdsPlacementResponse extends AdsTabShell {
  period: DashPeriod
  items: AdsPlacementRow[]
  adjustments: { state: 'NOT_CONNECTED'; note: string }
}

export interface AdsHistorySection extends AdsTabShell {
  items: Array<{ at: string; text: string }>
}
export interface AdsCampaignHistoryResponse {
  current: { budget: number | null; budgetType: string | null; currency: string; bidStrategy: string | null; servingStatus: string | null }
  budgetChanges: AdsHistorySection
  bidChanges: AdsHistorySection
  overBudget: AdsHistorySection
}

export interface AdsForecastRow {
  id: string
  requestedAt: string
  requestedBudget: number
  currency: string
  /** 预测原文里的数值字段（路径与值）；区间字段随亚马逊版本变化，尚未对真实账户核对解析。 */
  fields: Array<{ path: string; value: string }>
}
export interface AdsCampaignForecastResponse extends AdsTabShell {
  items: AdsForecastRow[]
  basis: string
  request: typeof ADS_WRITE_PENDING
}
export interface AdsRecommendationRow {
  id: string
  recommendationId: string
  type: string
  status: 'NEW' | 'ADOPTED' | 'IGNORED' | 'EXPIRED'
  receivedAt: string
  lastSeenAt: string
  summary: string | null
  suggestedBudget: number | null
  suggestedBid: number | null
  decidedAt: string | null
  decidedByName: string | null
}
export interface AdsCampaignRecommendationsResponse extends AdsTabShell {
  items: AdsRecommendationRow[]
  canDismiss: boolean
  write: typeof ADS_WRITE_PENDING
}

export interface AdsCampaignChangeRow {
  id: string
  source: 'system' | 'manual'
  kindLabel: string
  title: string
  occurredAt: string
  actor: string
  before: string | null
  after: string | null
}
export interface AdsCampaignChangesResponse extends AdsTabShell {
  items: AdsCampaignChangeRow[]
  truncated: boolean
  amazonSide: { state: 'NOT_CONNECTED'; note: string }
}
