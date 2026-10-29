import type { CursorPageInfo } from './query.js'
import type { InventoryFreshness } from './inventory.js'

// 评价与反馈（P4-13，05 章 5.7）：常量、类型与口径文字。纯计算在 reviews-math.ts，请求校验在 reviews-query.ts（zod 单独成文件）。
// 数据来源：客户反馈接口（商品评论主题、类目评论主题趋势、类目退货主题趋势）、请求评价接口（可请求动作与发起请求）、评分文件导入（官方没有平均星级与评分数的接口）。
// 没有数据显示“尚无记录”，没有权限显示“无权限”，来源没接上显示“尚未接入”，永远不显示成 0。接口字段依据官方文档整理，没有用真实店铺核对（CR-088）。

export const REVIEWS_READ = 'reviews.read'
export const REVIEWS_SOLICIT = 'reviews.solicit'
export const REVIEWS_IMPORT_PERMISSION = 'data.import'
export const FEEDBACK_SYNC_JOB = 'FEEDBACK_SYNC'
export const SOLICITATION_SEND_JOB = 'SOLICITATION_SEND'
export const FEEDBACK_FRESHNESS_KEY = 'feedback.api'
/** 店铺没有品牌分析权限，客户反馈接口返回 403：同步任务以这个不可重试的失败码结束（新鲜度记“未授权”，不触发同步失败预警）。 */
export const FEEDBACK_NO_BRAND_ACCESS = 'FBK_NO_BRAND_ACCESS'
export const SOLICITATION_SWITCH_KEY = 'sw.solicitation.send'
export const REVIEWS_MARKETPLACE_ID = 'ATVPDKIKX0DER'
export const REVIEWS_ACTIONS = { ratingsImported: 'REVIEW_RATINGS_IMPORTED', solicitationsRequested: 'REVIEW_SOLICITATIONS_REQUESTED' } as const

export const REVIEWS_TABS = ['ratings', 'topics', 'returns', 'solicit'] as const
export type ReviewsTab = (typeof REVIEWS_TABS)[number]
export const REVIEWS_TAB_LABEL: Record<ReviewsTab, string> = { ratings: '评分概况', topics: '评论主题', returns: '退货主题', solicit: '请求评价' }

export const REVIEW_SORTS = ['asin', 'avgRating', 'ratingCount', 'captureDate', 'delta'] as const
export type ReviewSort = (typeof REVIEW_SORTS)[number]
export const ELIGIBLE_SORTS = ['deliveredAt', 'purchaseDate'] as const
export type EligibleSort = (typeof ELIGIBLE_SORTS)[number]

export const REVIEW_SENTIMENTS = ['POSITIVE', 'NEGATIVE'] as const
export type ReviewSentiment = (typeof REVIEW_SENTIMENTS)[number]
export const REVIEW_SENTIMENT_LABEL: Record<ReviewSentiment, string> = { POSITIVE: '正面', NEGATIVE: '负面' }
/** ALL：类目全部商品；TOP25：类目前 25% 商品。 */
export const REVIEW_TREND_SCOPES = ['ALL', 'TOP25'] as const
export type ReviewTrendScope = (typeof REVIEW_TREND_SCOPES)[number]
export const REVIEW_TREND_SCOPE_LABEL: Record<ReviewTrendScope, string> = { ALL: '类目全部商品', TOP25: '类目前 25% 商品' }

/** 请求评价记录的状态。QUEUED 是已受理、还没发给亚马逊（用来保证每单只请求一次）。 */
export const SOLICITATION_STATUSES = ['QUEUED', 'REQUESTED', 'UNAVAILABLE', 'WINDOW_CLOSED', 'FAILED'] as const
export type SolicitationStatus = (typeof SOLICITATION_STATUSES)[number]
export const SOLICITATION_STATUS_LABEL: Record<SolicitationStatus, string> = {
  QUEUED: '处理中',
  REQUESTED: '已请求',
  UNAVAILABLE: '亚马逊不允许请求',
  WINDOW_CLOSED: '已过请求期限',
  FAILED: '发送失败',
}

export const REVIEWS_LIMITS = {
  /** 订单送达后第 5 至 30 天内才可以请求评价（亚马逊规定）。 */
  windowStartDay: 5,
  windowEndDay: 30,
  /** 一次批量请求最多的订单数。 */
  batchMax: 50,
  /** 每次同步最多处理的 ASIN 数；优先处理没有快照与快照最旧的；距上次快照不足这么多天的 ASIN 跳过。 */
  syncAsinsMax: 40,
  syncSkipFreshDays: 6,
  /** 每个商品最多存的主题条数（每种情感）。 */
  topicsPerSentiment: 10,
  /** 类目趋势保留的月数。 */
  trendMonths: 6,
  /** 评分导入：文件最多行数、文件名与错误明细上限。 */
  importRowsMax: 5000,
  importFileNameMax: 200,
  importErrorsShown: 50,
  /** 评分概况趋势每个商品最多展示的采集点；列表读取行数上限（Prisma take 上限 20000，判断截断要多读一行）。 */
  ratingTrendPoints: 12,
  ratingRowsMax: 19_999,
  ratingListMax: 2000,
  /** 主题页与退货页的下拉选项上限。 */
  optionsMax: 200,
  /** 请求评价：可请求订单读取上限（订单与包裹先按时间窗取，再排除已记录的）。 */
  eligibleScanMax: 5000,
  /** 请求覆盖率与评分增长的统计窗口（天）。 */
  coverageDays: 90,
  growthAsinsMax: 50,
  /** 改进清单最多条数、每行展示的主题与退货原因数。 */
  improvementsMax: 30,
  improvementTopics: 3,
  improvementReasons: 3,
  returnReasonDays: 90,
  pageSizeDefault: 50,
} as const

export const REVIEWS_RATINGS_BASIS =
  '平均星级与评分数在亚马逊官方接口里没有来源，只能由你从卖家后台或其他渠道导出后在本页导入；每一行都标注来源（文件导入）、采集日期、导入文件与导入人。变化 = 最新采集 − 上一次采集；只有一次采集时没有变化。'
export const REVIEWS_TOPICS_BASIS =
  '评论主题来自亚马逊客户反馈接口：每个商品最多前 10 个正面与前 10 个负面主题，提及量用接口给的区间原样显示（不估算占比）；类目对比取该商品所在类目（浏览节点）最近一个月的主题占比，分“类目全部商品”“类目前 25% 商品”两档；需要品牌备案与品牌分析角色，每周刷新一次。'
export const REVIEWS_RETURNS_BASIS =
  '退货主题只到类目级（接口没有商品级退货主题）：取该类目（浏览节点）近 6 个月的退货主题占比，分“全部商品”“前 25% 商品”两档。改进清单把商品最新的负面评论主题与近 90 天的退货原因放在一起，按退货件数排序；主题是英文原文、退货原因是报告代码，系统只在文字有重合时标“可能相关”，不做语义判断。'
export const REVIEWS_SOLICIT_BASIS =
  '可请求订单：订单的全部包裹都已送达、送达后第 5 至 30 天、还没有请求记录（或上次发送失败）。每个订单只能请求一次（数据库唯一约束），发送前会向亚马逊再查一次是否允许；受写入开关“请求评价”控制，开关关闭时不会向亚马逊发出请求。请求覆盖率 = 近 90 天已请求订单 ÷ 近 90 天已送达订单。'
export const REVIEWS_GROWTH_BASIS =
  '请求后评分数增长 = 首次请求之后最近一次导入的评分数 − 首次请求当天或之前最近一次导入的评分数；需要请求前后各有一次评分导入，缺任何一次就写“需要再导入一次评分”，不推测。增长只反映时间上的先后，不代表因果。'

// ---- 通用 ----

export type ReviewSectionState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'RESTRICTED' | 'NOT_APPLICABLE'
export interface ReviewStoreRef {
  id: string
  name: string
}

// ---- 评分概况 ----

export interface RatingPoint {
  date: string
  avgRating: number | null
  ratingCount: number | null
}
export interface RatingRow {
  storeId: string
  storeName: string
  asin: string
  title: string | null
  avgRating: number | null
  ratingCount: number | null
  captureDate: string
  /** 评分分布（1 到 5 星的人数，键 "1" 到 "5"）；没有导入为 null。 */
  distribution: Record<string, number> | null
  sourceLabel: string
  sourceFileName: string
  importedBy: string | null
  /** 与上一次采集的变化；只有一次采集或上一次没有对应字段为 null。 */
  ratingDelta: number | null
  countDelta: number | null
  previousDate: string | null
  /** 最近的采集点（旧到新，最多 12 个）。 */
  trend: RatingPoint[]
}
export interface RatingsSummary {
  /** 商品目录里的 ASIN 数（店铺 × ASIN）。 */
  catalogAsins: number
  /** 有评分导入的 ASIN 数；两者差就是“尚无记录”的商品。 */
  withRating: number
  /** 最近一次采集日期；没有导入为 null。 */
  latestCapture: string | null
  /** 带评分的商品里的最低星级与低于 4 星的商品数；没有数据为 null。 */
  lowestRating: number | null
  below4: number | null
}
export interface RatingsTabResponse {
  tab: 'ratings'
  state: ReviewSectionState
  note: string | null
  items: RatingRow[]
  pageInfo: CursorPageInfo
  summary: RatingsSummary
  stores: ReviewStoreRef[]
  truncated: boolean
  basis: string
}

// ---- 评论主题 ----

export interface TopicRow {
  rank: number
  topic: string
  sentiment: ReviewSentiment
  /** 接口给的提及量区间文字，没给为 null。 */
  mentionRange: string | null
  reviewCountBucket: string | null
  /** 所在类目最近一个月该主题的占比（小数），没有为 null。 */
  categoryAll: number | null
  categoryTop: number | null
}
export interface TrendSeries {
  topic: string
  sentiment: ReviewSentiment
  scope: ReviewTrendScope
  points: Array<{ month: string; rate: number | null }>
}
export interface TopicAsinOption {
  storeId: string
  storeName: string
  asin: string
  title: string | null
  snapshotDate: string
}
export interface TopicsSelected {
  storeId: string
  storeName: string
  asin: string
  title: string | null
  snapshotDate: string
  browseNodeId: string | null
  browseNodeName: string | null
  positive: TopicRow[]
  negative: TopicRow[]
  /** 类目近 6 个月主题趋势：只含这个商品出现过的主题；没有同步到类目趋势时为空。 */
  trend: TrendSeries[]
  trendMonths: string[]
  categoryNote: string | null
}
export interface TopicsTabResponse {
  tab: 'topics'
  state: ReviewSectionState
  note: string | null
  options: TopicAsinOption[]
  selected: TopicsSelected | null
  stores: ReviewStoreRef[]
  freshness: InventoryFreshness | null
  basis: string
}

// ---- 退货主题 ----

export interface ReturnNodeOption {
  storeId: string
  storeName: string
  browseNodeId: string
  browseNodeName: string | null
  asinCount: number
}
export interface ReturnTopicRow {
  topic: string
  /** 最近一个月的占比（小数）：全部商品 / 前 25% 商品。 */
  rateAll: number | null
  rateTop: number | null
  latestMonth: string
  series: Array<{ month: string; all: number | null; top: number | null }>
}
export interface ImprovementRow {
  storeId: string
  storeName: string
  asin: string
  title: string | null
  negativeTopics: Array<{ topic: string; mentionRange: string | null }>
  returnUnits: number
  returnReasons: Array<{ code: string; label: string; units: number; share: number }>
  /** 负面主题与退货原因文字有重合时为真（“可能相关”）。 */
  possiblyRelated: boolean
  snapshotDate: string
  suggestion: string
}
export interface ReturnsTabResponse {
  tab: 'returns'
  state: ReviewSectionState
  note: string | null
  nodes: ReturnNodeOption[]
  selectedNode: { storeId: string; storeName: string; browseNodeId: string; browseNodeName: string | null; months: string[]; topics: ReturnTopicRow[] } | null
  improvements: { state: ReviewSectionState; note: string | null; rows: ImprovementRow[]; days: number }
  stores: ReviewStoreRef[]
  freshness: InventoryFreshness | null
  basis: string
}

// ---- 请求评价 ----

export interface EligibleOrderRow {
  storeId: string
  storeName: string
  amazonOrderId: string
  purchaseDate: string
  deliveredAt: string
  /** 送达后已过去的整天数（送达当天为 0）与请求期限剩余天数（送达后第 30 天为 0）。 */
  dayAfterDelivery: number
  daysLeft: number
  asins: string[]
  /** 上一次发送失败（可再次请求）为 FAILED，否则为 null。 */
  lastStatus: SolicitationStatus | null
}
export interface SolicitCoverage {
  storeId: string
  storeName: string
  deliveredOrders: number
  requestedOrders: number
  /** 覆盖率（小数）；没有已送达订单为 null。 */
  coverage: number | null
  eligibleNow: number
}
export interface RatingGrowthRow {
  storeId: string
  storeName: string
  asin: string
  title: string | null
  requestedOrders: number
  firstRequestAt: string
  beforeCount: number | null
  beforeDate: string | null
  afterCount: number | null
  afterDate: string | null
  delta: number | null
  note: string | null
}
export interface SolicitSwitchState {
  /** 写入开关是否已打开（企业级）；页面据此给出按钮的禁用原因。 */
  enabled: boolean
  /** 当前成员是否有请求评价的权限。 */
  permitted: boolean
}
export interface SolicitTabResponse {
  tab: 'solicit'
  state: ReviewSectionState
  /** 写入开关与权限；没给就表示服务端没判断，页面只写“受写入开关控制”。 */
  switch?: SolicitSwitchState
  note: string | null
  items: EligibleOrderRow[]
  pageInfo: CursorPageInfo
  coverage: SolicitCoverage[]
  growth: RatingGrowthRow[]
  recent: Array<{ amazonOrderId: string; storeName: string; status: SolicitationStatus; statusLabel: string; requestedAt: string; failureCode: string | null }>
  stores: ReviewStoreRef[]
  truncated: boolean
  basis: string
  growthBasis: string
}
export type ReviewsTabResponse = RatingsTabResponse | TopicsTabResponse | ReturnsTabResponse | SolicitTabResponse

// ---- 写入 ----

export interface RatingsImportError {
  line: number
  column: string
  code: 'FILE_COLUMN_MISSING' | 'FILE_VALUE_RANGE' | 'FILE_DUPLICATE' | 'FILE_VALUE_INVALID'
  message: string
}
export interface RatingsImportResult {
  imported: number
  /** 同一店铺、ASIN、采集日期已有记录、被这次导入覆盖的行数。 */
  replaced: number
  batchId: string
  fileName: string
  errors: RatingsImportError[]
}
export interface SolicitationBatchResult {
  accepted: number
  /** 被跳过的订单：已经有请求记录、不在可请求期内、不属于这个店铺。 */
  skipped: Array<{ amazonOrderId: string; reason: 'ALREADY_REQUESTED' | 'OUT_OF_WINDOW' | 'NOT_FOUND' | 'NOT_DELIVERED' }>
  batchId: string | null
  jobId: string | null
}

/** 评分导入模板（页面下载）：列名固定，星级分布列可空。 */
export const RATINGS_TEMPLATE_HEADER = ['ASIN', '采集日期', '平均星级', '评分数', '1星', '2星', '3星', '4星', '5星'] as const
export const RATINGS_TEMPLATE_EXAMPLE = ['B0ABCDE123', '2026-10-24', '4.5', '1280', '', '', '', '', ''] as const
