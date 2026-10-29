import type { CursorPageInfo } from './query'
import type { DashPeriod, DashState } from './dashboard'
import type { ADS_WRITE_PENDING, AdsCampaignRatios } from './ads-campaigns'
import type { AdsTermStatus, AdsTrendPointDay } from './ads-campaigns-tabs'
import type { AdsBidChangeRow } from './ads-groups'
import type { AdsQuadrant } from './ads-overview'
import type { AdsTotals } from './ads-overview-math'

// 词级中心契约（P3-10，08 章 8.7）：只有常量与类型，没有 zod（请求校验在 ad-terms-query.ts，纯函数在 ad-terms-math.ts）。
// 数据来源：词级报表（AdsTermMetric，level = KEYWORD 是投放层、SEARCH_TERM 是搜索词层，只含美元）、活动管理接口同步的关键词、投放、否定投放与广告组（实体表）。
// 全部在数据库里按范围聚合，只取聚合结果；没有数据写“尚无记录”，同步器未交付写“尚未接入”，空值不是 0。
// 本包只读：词级中心里的否定、加词、调价按钮暂未接入写入（P3-17 的入口在广告组与投放对象详情），按钮禁用并说明去向。

/** 保存视图的页面标识（collab 的保存视图接口按它归类）。 */
export const AD_TERMS_VIEW_PAGE_KEY = 'ad-terms'
/** 列表默认回看天数（没有选择时间范围时），与活动、广告商品一致。 */
export const AD_TERMS_DEFAULT_DAYS = 30
/** 读词级报表时最多读多少个分组（Prisma take 上限 20000，多读一行判断是否截断）。 */
export const AD_TERMS_GROUP_LIMIT = 19_999
/** 四象限最多画多少个点（按花费从高到低）。 */
export const AD_TERMS_QUADRANT_LIMIT = 200
/** 详情页各块最多列多少行。 */
export const AD_TERM_DETAIL_LIMIT = 200
/** 详情页历史动作最多看多少个投放对象的调价记录。 */
export const AD_TERM_HISTORY_TARGETS = 5
export const AD_TERM_HISTORY_LIMIT = 50
/** 词根分析每个词根最多举几个例子词、最多记几种写法。 */
export const AD_TERM_ROOT_EXAMPLES = 3
export const AD_TERM_ROOT_FORMS = 5

/** 页面的 5 个页签；词根分析是独立接口 GET /ads/terms/roots，其余四个走 GET /ads/terms?tab=。 */
export const AD_TERM_PAGE_TABS = [
  { key: 'targets', label: '投放对象' },
  { key: 'search-terms', label: '搜索词' },
  { key: 'negatives', label: '否定词库' },
  { key: 'quadrant', label: '四象限' },
  { key: 'roots', label: '词根分析' },
] as const
export type AdTermPageTab = (typeof AD_TERM_PAGE_TABS)[number]['key']
export const AD_TERM_LIST_TABS = ['targets', 'search-terms', 'negatives', 'quadrant'] as const
export type AdTermListTab = (typeof AD_TERM_LIST_TABS)[number]

export const AD_TERM_SORTS = ['spend', 'sales', 'orders', 'clicks', 'impressions', 'acos', 'roas', 'cvr', 'cpc', 'ctr', 'term'] as const
export type AdTermSort = (typeof AD_TERM_SORTS)[number]
export const AD_TERM_SORT_LABEL: Record<AdTermSort, string> = {
  spend: '花费',
  sales: '广告销售额',
  orders: '订单',
  clicks: '点击',
  impressions: '展示',
  acos: '广告成本销售比',
  roas: '广告回报率',
  cvr: '转化率',
  cpc: '单次点击成本',
  ctr: '点击率',
  term: '词',
}
export const AD_TERM_ROOT_SORTS = [...AD_TERM_SORTS, 'terms', 'stores'] as const
export type AdTermRootSort = (typeof AD_TERM_ROOT_SORTS)[number]

export const AD_TERM_NEGATIVE_LEVELS = ['CAMPAIGN', 'AD_GROUP'] as const
export type AdTermNegativeLevel = (typeof AD_TERM_NEGATIVE_LEVELS)[number]
export const AD_TERM_NEGATIVE_LEVEL_LABEL: Record<AdTermNegativeLevel, string> = { CAMPAIGN: '活动级', AD_GROUP: '广告组级' }
export const AD_TERM_SUBJECTS = ['search-terms', 'targets'] as const
export type AdTermSubject = (typeof AD_TERM_SUBJECTS)[number]

/**
 * 异常分组的自定默认值（08 章只给了四个分组的名字，没有给数；页面明示，不是亚马逊口径）：
 *   HIGH_SPEND_NO_ORDER  花费不低于 MIN_SPEND、点击不少于 MIN_CLICKS 但没有订单；
 *   SCALE_UP             订单不少于 SCALE_MIN_ORDERS 且广告成本销售比不高于 SCALE_MAX_ACOS；
 *   ADD_KEYWORD          还没有投放的搜索词，订单不少于 ADD_MIN_ORDERS 且转化率（订单 ÷ 点击）不低于 ADD_MIN_CVR；
 *   NEGATIVE_CANDIDATE   还没有投放也没有否定的搜索词，点击不少于 NEGATIVE_MIN_CLICKS、花费不低于 NEGATIVE_MIN_SPEND 但没有订单。
 */
export const AD_TERM_RULES = {
  MIN_SPEND: 20,
  MIN_CLICKS: 20,
  SCALE_MAX_ACOS: 0.25,
  SCALE_MIN_ORDERS: 3,
  ADD_MIN_ORDERS: 2,
  ADD_MIN_CVR: 0.1,
  NEGATIVE_MIN_CLICKS: 10,
  NEGATIVE_MIN_SPEND: 5,
} as const
export const AD_TERM_ANOMALIES = ['HIGH_SPEND_NO_ORDER', 'SCALE_UP', 'ADD_KEYWORD', 'NEGATIVE_CANDIDATE'] as const
export type AdTermAnomaly = (typeof AD_TERM_ANOMALIES)[number]
export const AD_TERM_ANOMALY_LABEL: Record<AdTermAnomaly, string> = {
  HIGH_SPEND_NO_ORDER: '高花费无成交',
  SCALE_UP: '低广告成本销售比可扩量',
  ADD_KEYWORD: '高转化可加词',
  NEGATIVE_CANDIDATE: '否定候选',
}
/** 每个分组适用于哪些页签：投放对象只有前两个；搜索词四个都有；高花费无成交没有订单也就没有广告销售额，四象限画不出，不适用。 */
export const AD_TERM_ANOMALY_TABS: Record<AdTermAnomaly, readonly AdTermListTab[]> = {
  HIGH_SPEND_NO_ORDER: ['targets', 'search-terms'],
  SCALE_UP: ['targets', 'search-terms', 'quadrant'],
  ADD_KEYWORD: ['search-terms'],
  NEGATIVE_CANDIDATE: ['search-terms'],
}

/** 已投放与已否定的判断口径（和活动页签一致）。 */
export const AD_TERM_MATCH_BASIS =
  '“已投放”“已否定”按搜索词与投放词、否定词完全相同判断（不分大小写、合并多余空格），在同一个活动内比对；广泛、词组、否定词组匹配的命中不在其内，活动里任一广告组的否定都算该活动已否定'
export const AD_TERM_AGGREGATE_BASIS = '词级报表按“搜索词”汇总全部活动与店铺（美元账户，花费为空的报表行没有计入）；亚马逊把低于披露阈值的搜索词合并成“其他”，那部分不在列表里'
export const AD_TERM_ROOT_BASIS =
  '词根分析把每个搜索词拆成单词（去掉常见虚词与 ASIN 样式的词），英文单词按规则还原单复数（不是完整的词形还原词典）；一个搜索词含几个词根，它的花费就分别计入每个词根，所以词根之间不能相加'
export const AD_TERM_QUADRANT_BASIS = '横轴花费、纵轴广告成本销售比；分界线是各点的平均花费与整体广告成本销售比。没有广告销售额的词画不出广告成本销售比，不在图上，请看“高花费无成交”分组'
export const AD_TERM_TARGETS_BASIS = '投放对象指标来自词级报表的投放层（关键词与投放表达式），不是活动管理接口的投放对象表；竞价与状态来自已同步的关键词与投放对象，没有同步为空'
export const AD_TERM_NEGATIVES_BASIS = '否定词库是活动管理接口同步的否定投放记录，每条记录一行（同一个词在多个活动里否定会有多行）；这里不判断否定后是否仍有花费'

/** 品牌分析份额同屏（P4-04 接入）：来自品牌分析“搜索查询表现”最近一个有数据的周期；没有这个词的记录或没有品牌分析读取权限时接口返回 null，整块不显示。 */
export interface AdTermBrandShare {
  searchVolume: number | null
  clickShare: number | null
  purchaseShare: number | null
  /** 品牌分析数据对应的周期与最近更新时间，形状由 P4-04 确定。 */
  periodText: string | null
  sourceUpdatedAt: string | null
}

// ---- 列表 ----

export interface AdTermMetricBlock {
  totals: AdsTotals
  ratios: AdsCampaignRatios
}
export interface AdTermCampaigns {
  /** 出现过这个词的活动数（广告档案 × 活动）。 */
  total: number
  /** 其中已经被投放的活动数。 */
  targeted: number
  /** 其中已经被否定的活动数。 */
  negated: number
}
export interface AdTermSearchRow extends AdTermMetricBlock {
  /** 归一化后的词（不分大小写、合并空格），列表里的稳定键，也是详情页的参数。 */
  key: string
  searchTerm: string
  status: AdsTermStatus
  campaigns: AdTermCampaigns
  /** 带来这个词的店铺数（广告账户没有绑定店铺的不计）。 */
  stores: number
  anomalies: AdTermAnomaly[]
}
export interface AdTermTargetRow extends AdTermMetricBlock {
  key: string
  adsProfileId: string
  externalCampaignId: string
  campaignName: string | null
  adGroupId: string | null
  adGroupName: string | null
  /** 关键词或投放编号；词级报表没给为 null。 */
  targetId: string | null
  expression: string
  matchType: string | null
  storeName: string | null
  /** 对应的关键词或投放对象的系统编号（趋势小窗与详情用）；还没有同步为 null。 */
  entityId?: string | null
  /** 已同步的竞价与状态；对应的关键词或投放对象还没有同步为 null。 */
  bid: number | null
  state: string | null
  anomalies: AdTermAnomaly[]
}
export interface AdTermNegativeRow {
  id: string
  expression: string
  matchType: string
  level: string
  externalCampaignId: string
  campaignName: string | null
  adGroupId: string | null
  adGroupName: string | null
  storeName: string | null
  accountName: string
  syncedAt: string
}

export interface AdTermListShell {
  state: Extract<DashState, 'OK' | 'NO_DATA' | 'NOT_CONNECTED'>
  note: string | null
  period: DashPeriod
  range: { from: string; to: string; defaulted: boolean }
  currency: 'USD'
  pageInfo: CursorPageInfo
  /** 报表分组超过读取上限，花费较低的词可能缺失。 */
  truncated: boolean
  basis: string
  write: typeof ADS_WRITE_PENDING
}
export interface AdTermSummary {
  /** 筛选条件（关键字、状态）之后的词数，异常分组过滤之前。 */
  total: number
  totals: AdsTotals
  ratios: AdsCampaignRatios
  /** 每个异常分组命中的词数（和上面同一批词）。 */
  anomalies: Record<AdTermAnomaly, number>
}
export interface AdTermSearchResponse extends AdTermListShell {
  items: AdTermSearchRow[]
  summary: AdTermSummary
  /** 被亚马逊合并成“其他”的搜索词的花费；报表没有这类行为 null。 */
  undisclosedSpend: number | null
  /** 投放词与否定词记录没有同步或被截断时的说明（此时“未投放”不代表真的没有投放）。 */
  targetingNote: string | null
}
export interface AdTermTargetsResponse extends AdTermListShell {
  items: AdTermTargetRow[]
  summary: AdTermSummary
}
export interface AdTermNegativesResponse extends AdTermListShell {
  items: AdTermNegativeRow[]
  total: number
}

// ---- 四象限 ----

export interface AdTermQuadrantPoint {
  key: string
  name: string
  spend: number
  sales: number
  orders: number
  acos: number
  quadrant: AdsQuadrant
}
export interface AdTermQuadrantResponse {
  state: Extract<DashState, 'OK' | 'NO_DATA' | 'NOT_CONNECTED'>
  note: string | null
  period: DashPeriod
  range: { from: string; to: string; defaulted: boolean }
  currency: 'USD'
  subject: AdTermSubject
  /** 分界线：各点的平均花费与整体广告成本销售比；没有点为 null。 */
  spendLine: number | null
  acosLine: number | null
  points: AdTermQuadrantPoint[]
  counts: Record<AdsQuadrant, number>
  /** 有花费但没有广告销售额（画不出广告成本销售比）的词数与花费。 */
  withoutSales: { terms: number; spend: number | null }
  /** 全部能画出的点数（points 只留花费最高的一部分）。 */
  total: number
  truncated: boolean
  basis: string
}

// ---- 词根分析 ----

export interface AdTermRootRow extends AdTermMetricBlock {
  root: string
  /** 合并进这个词根的写法（例如 mat、mats），按出现频次。 */
  forms: string[]
  /** 含这个词根的搜索词数。 */
  terms: number
  stores: number
  /** 花费最高的几个例子词。 */
  examples: Array<{ term: string; spend: number | null }>
}
export interface AdTermRootsResponse {
  state: Extract<DashState, 'OK' | 'NO_DATA' | 'NOT_CONNECTED'>
  note: string | null
  period: DashPeriod
  range: { from: string; to: string; defaulted: boolean }
  currency: 'USD'
  items: AdTermRootRow[]
  pageInfo: CursorPageInfo
  truncated: boolean
  basis: string
  /** 参与统计的不同搜索词数。 */
  termCount: number
}

// ---- 词级分析页 ----

export const AD_TERM_ADVICE_ACTIONS = ['NEGATE', 'ADD_KEYWORD', 'LOWER_BID', 'RAISE_BID'] as const
export type AdTermAdviceAction = (typeof AD_TERM_ADVICE_ACTIONS)[number]
export const AD_TERM_ADVICE_LABEL: Record<AdTermAdviceAction, string> = { NEGATE: '加为否定词', ADD_KEYWORD: '加为关键词', LOWER_BID: '降低竞价或暂停', RAISE_BID: '提高竞价' }
export interface AdTermAdvice {
  action: AdTermAdviceAction
  label: string
  reason: string
}
/** 词级报表里的一条“投放词 → 搜索词”关系：在哪个活动、广告组，被哪个投放词、什么匹配方式带来。 */
export interface AdTermRelationRow extends AdTermMetricBlock {
  key: string
  adsProfileId: string
  externalCampaignId: string
  campaignName: string | null
  adGroupId: string | null
  adGroupName: string | null
  targetExpression: string | null
  matchType: string | null
  /** 这个词在这个活动里的状态。 */
  status: AdsTermStatus
}
/** 与这个词文字完全相同的关键词、投放表达式与否定词记录。 */
export interface AdTermTargetingRow {
  id: string
  kind: 'KEYWORD' | 'TARGET' | 'NEGATIVE'
  expression: string
  matchType: string | null
  bid: number | null
  state: string | null
  externalCampaignId: string | null
  adGroupId: string | null
}
export interface AdTermHistoryRow extends AdsBidChangeRow {
  expression: string
}
export interface AdTermDetailResponse {
  term: string
  state: Extract<DashState, 'OK' | 'NO_DATA' | 'NOT_CONNECTED'>
  note: string | null
  period: DashPeriod
  currency: 'USD'
  status: AdsTermStatus | null
  campaigns: AdTermCampaigns
  totals: AdsTotals | null
  ratios: AdsCampaignRatios | null
  anomalies: AdTermAnomaly[]
  trend: AdsTrendPointDay[]
  relations: { items: AdTermRelationRow[]; truncated: boolean }
  targeting: { state: DashState; note: string | null; items: AdTermTargetingRow[] }
  advice: AdTermAdvice[]
  history: { state: DashState; note: string | null; items: AdTermHistoryRow[]; truncated: boolean }
  /** 品牌分析份额：P4-04 交付之前为 null，页面不显示这一块。 */
  brand: AdTermBrandShare | null
  basis: string
  write: typeof ADS_WRITE_PENDING
}
