import type { CursorPageInfo } from './query'
import type { DashState, DashCompare, DashPeriod } from './dashboard'
import type { AdsAnomalyKind, AdsProductKey } from './ads-overview'
import type { AdsLevelSummary } from './ads-levels'
import type { AdsTotals } from './ads-overview-math'

// 广告活动契约（P3-07，08 章 8.3）：只有常量与类型，没有 zod（请求校验在 ads-campaigns-query.ts）。
// 数据来源：活动管理接口同步的活动、广告组、投放对象（AdsCampaign 等实体表）；指标来自广告日汇总（AdsDailySummary，只含美元）与各级指标表；
// 分时来自营销数据流小时指标；官方推荐与预测来自 P3-01 的同步结果。没有数据的块写“尚无记录”，同步器未交付的块写“尚未接入”，空值不是 0。
// 本包只读，唯一的写入是系统内标签与负责人（不写亚马逊）；暂停、预算、竞价等写入亚马逊的动作在 P3-17 接入（列表上的批量按钮，先预览再提交）。

export const ADS_CAMPAIGN_WRITE = 'ads.campaign.write'
/** 列表默认回看天数（没有选择时间范围时）。 */
export const ADS_CAMPAIGN_DEFAULT_DAYS = 30
export const ADS_CAMPAIGN_TAG_LIMITS = { MAX_TAGS: 20, MAX_LENGTH: 30, BATCH_MAX: 200 } as const
/** 页签列表一次最多取多少行（超过标记截断）。 */
export const ADS_CAMPAIGN_TAB_ROW_LIMIT = 2000
export const ADS_CAMPAIGN_SORTS = ['spend', 'sales', 'orders', 'acos', 'roas', 'ctr', 'cpc', 'cvr', 'budget', 'name', 'syncedAt'] as const
export type AdsCampaignSort = (typeof ADS_CAMPAIGN_SORTS)[number]
export const ADS_CAMPAIGN_SEARCH_MODES = ['contains', 'excludes'] as const
export const ADS_TARGETING_LABEL: Record<'AUTO' | 'MANUAL', string> = { AUTO: '自动', MANUAL: '手动' }

/** 平均超预算时长需要活动管理接口的预算消耗数据，同步器未交付。 */
export const ADS_OVER_BUDGET_NOTE = '平均超预算时长需要活动管理接口的预算消耗数据，该同步器尚未接入'
/** 详情页建议里的写入动作（采纳推荐、降价或否定等）暂未提供入口；列表上的批量写入走 P3-17 的预览与提交。 */
export const ADS_WRITE_PENDING = {
  state: 'NOT_CONNECTED' as const,
  note: '暂停、启用、改预算与改竞价策略请在“广告活动”列表勾选活动后操作；添加关键词与否定投放请到广告组详情；这一处的动作（广告位调整、采纳官方推荐）暂未提供入口，请在亚马逊广告后台操作',
}

// ---- 12 个页签 ----

export const ADS_CAMPAIGN_TABS = [
  { key: 'trend', label: '表现趋势' },
  { key: 'hourly', label: '分时表现' },
  { key: 'ad-groups', label: '广告组' },
  { key: 'targets', label: '投放对象' },
  { key: 'search-terms', label: '搜索词' },
  { key: 'products', label: '广告商品' },
  { key: 'placements', label: '广告位' },
  { key: 'creatives', label: '创意与着陆页', only: ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] },
  { key: 'audiences', label: '受众', only: ['SPONSORED_DISPLAY'] },
  { key: 'history', label: '预算与竞价历史' },
  { key: 'advice', label: '预测与推荐' },
  { key: 'changes', label: '操作记录' },
] as const satisfies ReadonlyArray<{ key: string; label: string; only?: readonly AdsProductKey[] }>
export type AdsCampaignTabKey = (typeof ADS_CAMPAIGN_TABS)[number]['key']

/** 某个广告产品的活动能看到的页签：创意只有品牌推广与展示型推广，受众只有展示型推广。 */
export function adsCampaignTabsFor(adProduct: string): Array<{ key: AdsCampaignTabKey; label: string }> {
  return ADS_CAMPAIGN_TABS.filter(tab => !('only' in tab) || (tab.only as readonly string[]).includes(adProduct)).map(tab => ({ key: tab.key, label: tab.label }))
}

// ---- 建议动作 ----

/** 建议规则的自定默认值（08 章没有给数，页面明示）。 */
export const ADS_CAMPAIGN_ADVICE_RULES = { WINDOW_DAYS: 30, WASTE_MIN_SPEND: 20, WASTE_MIN_CLICKS: 20, STOCKOUT_LOOKBACK_DAYS: 3, HIT_LIMIT: 10 } as const
export const ADS_ADVICE_KINDS = ['RAISE_BUDGET', 'WASTED_TARGETS', 'OFFICIAL_RECOMMENDATION', 'STOCKOUT_PRODUCTS'] as const
export type AdsAdviceKind = (typeof ADS_ADVICE_KINDS)[number]
export const ADS_ADVICE_LABEL: Record<AdsAdviceKind, string> = {
  RAISE_BUDGET: '平均超预算时长超过阈值且 ACoS 低于目标：提高日预算',
  WASTED_TARGETS: '投放对象花费高但无成交：降低竞价或否定',
  OFFICIAL_RECOMMENDATION: '亚马逊官方推荐：采纳或忽略',
  STOCKOUT_PRODUCTS: '广告商品已断货：暂停该商品广告',
}
/** HIT 命中；NO_HIT 数据齐全但没有命中；NOT_CONNECTED 缺数据来源，规则没法评估。 */
export type AdsAdviceState = 'HIT' | 'NO_HIT' | 'NOT_CONNECTED'

export interface AdsAdviceHit {
  id: string
  title: string
  evidence: string
  impact: string
  risk: string
  /** 对应的写动作（采纳后写亚马逊，采纳入口暂未提供）；忽略推荐是系统内操作，recommendationId 不为空时可忽略。 */
  action: 'RAISE_BUDGET' | 'LOWER_BID' | 'NEGATE' | 'PAUSE_PRODUCT' | 'ADOPT' | null
  recommendationId: string | null
}
export interface AdsAdviceRule {
  kind: AdsAdviceKind
  rule: string
  state: AdsAdviceState
  note: string | null
  hits: AdsAdviceHit[]
}

// ---- 列表 ----

export interface AdsCampaignRatios {
  acos: number | null
  roas: number | null
  ctr: number | null
  cpc: number | null
  cvr: number | null
}

export interface AdsCampaignRow {
  /** 系统编号（AdsCampaign.id），详情页地址用它。 */
  id: string
  adsProfileId: string
  externalCampaignId: string
  adProduct: string
  productLabel: string
  name: string
  targetingType: 'AUTO' | 'MANUAL' | null
  state: string
  servingStatus: string | null
  portfolioId: string | null
  portfolioName: string | null
  budget: number | null
  budgetType: string | null
  currency: string
  bidStrategy: string | null
  startDate: string | null
  endDate: string | null
  /** 范围内合计（广告日汇总，美元）；没有汇总行（或不是美元活动）为 null，不当 0。 */
  totals: AdsTotals | null
  ratios: AdsCampaignRatios | null
  /** 花费 ÷ 所属店铺总销售额；活动所在账户没有绑定店铺或没有店铺销售汇总为 null。 */
  adsShare: number | null
  /** 花费 ÷（日预算 × 天数）；不是日预算、没有预算或没有花费为 null。 */
  budgetUtilization: number | null
  anomaly: AdsAnomalyKind | null
  tags: string[]
  ownerId: string | null
  ownerName: string | null
  storeName: string | null
  accountName: string | null
  syncedAt: string
  version: number
}

export interface AdsCampaignListResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: AdsCampaignRow[]
  pageInfo: CursorPageInfo
  range: { from: string; to: string; defaulted: boolean }
  currency: 'USD'
  /** 筛选下拉：广告组合、已有标签、已被指定的负责人。 */
  filterOptions: { portfolios: Array<{ id: string; name: string }>; tags: string[]; owners: Array<{ id: string; name: string }> }
  /** 可以被指定为负责人的在职成员（只有可写的人才返回）。 */
  members: Array<{ id: string; name: string }>
  canWrite: boolean
  avgOverBudget: { state: 'NOT_CONNECTED'; note: string }
  write: typeof ADS_WRITE_PENDING
  /** 汇总行（P6-23）：筛选后的全部活动合计（不是只有当前页）；没有指标的活动不计入合计。 */
  summary: AdsLevelSummary
  /** 活动超过读取上限，只处理了前一部分。 */
  truncated: boolean
  /** 指标聚合超过读取上限，部分活动的指标可能缺失。 */
  metricsTruncated: boolean
}

// ---- 批量设置标签与负责人（系统内，不写亚马逊）----

export type AdsTagMode = 'ADD' | 'REMOVE' | 'SET'
export interface AdsCampaignMetaResult {
  updated: number
  /** 请求里没有任何变化的活动数（标签与负责人都已是目标值）。 */
  unchanged: number
  items: Array<{ id: string; version: number; tags: string[]; ownerId: string | null }>
}

// ---- 详情 ----

export interface AdsCampaignIdentity {
  id: string
  adsProfileId: string
  externalCampaignId: string
  adProduct: string
  productLabel: string
  name: string
  targetingType: 'AUTO' | 'MANUAL' | null
  state: string
  servingStatus: string | null
  budget: number | null
  budgetType: string | null
  currency: string
  bidStrategy: string | null
  /** 广告位调整没有同步器写入，没有字段可读。 */
  placementAdjustments: { state: 'NOT_CONNECTED'; note: string }
  portfolio: { id: string; name: string | null } | null
  account: { name: string; adsAccountId: string | null; storeName: string | null; bindingStatus: string }
  startDate: string | null
  endDate: string | null
  syncedAt: string
  tags: string[]
  owner: { id: string; name: string } | null
  version: number
}

export interface AdsCampaignMetrics {
  state: DashState
  note: string | null
  period: DashPeriod
  compare: DashCompare | null
  totals: AdsTotals | null
  previous: AdsTotals | null
  ratios: AdsCampaignRatios | null
  previousRatios: AdsCampaignRatios | null
  adsShare: number | null
  budgetUtilization: number | null
  avgOverBudget: { state: 'NOT_CONNECTED'; note: string }
}

export interface AdsCampaignDetailResponse {
  identity: AdsCampaignIdentity
  metrics: AdsCampaignMetrics
  advice: AdsAdviceRule[]
  tabs: Array<{ key: AdsCampaignTabKey; label: string }>
  canWrite: boolean
  members: Array<{ id: string; name: string }>
  write: typeof ADS_WRITE_PENDING
}

export const ADS_CAMPAIGN_ENTITY_TYPE = 'ADS_CAMPAIGN'
export const ADS_CAMPAIGN_EVENT_KIND = 'ads.campaign.meta'
export const ADS_CAMPAIGN_META_ACTION = 'ADS_CAMPAIGN_META_UPDATED'
export const ADS_RECOMMENDATION_DISMISS_ACTION = 'ADS_RECOMMENDATION_DISMISSED'
