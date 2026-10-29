import type { CursorPageInfo } from './query.js'
import type { InventoryFreshness } from './inventory.js'

// 竞品监控（P4-12，05 章 5.6）：常量、类型与口径文字。纯计算在 competitors-math.ts，请求校验在 competitors-query.ts（zod 单独成文件）。
// 数据来源只有官方接口与报告：热门搜索词报告里点击前三的商品（来源 SEARCH_TERM）、手工添加（MANUAL）；价格、推荐报价、配送方式、会员资格来自定价接口的竞争摘要，
// 标题、品牌、图片数量、销售排名来自商品目录接口。**不抓取亚马逊前台页面**；竞品的评分没有官方来源，一律显示“无官方来源”。
// 没有数据显示“尚无记录”，没有权限显示“无权限”，来源没接上显示“尚未接入”，永远不显示成 0。接口字段依据官方文档整理，没有用真实店铺核对（CR-087）。

export const COMPETITORS_READ = 'competitors.read'
export const COMPETITORS_WRITE = 'competitors.write'
export const COMPETITOR_SYNC_JOB = 'COMPETITOR_SYNC'
export const COMPETITOR_FRESHNESS_KEY = 'competitors.api'
/** 商品目录或定价接口的角色未获批（403）时，同步任务以通用的 ROLE_MISSING 结束（不可重试）。 */
export const COMPETITOR_ROLE_MISSING = 'ROLE_MISSING'
export const COMPETITOR_MARKETPLACE_ID = 'ATVPDKIKX0DER'
export const COMPETITOR_ACTIONS = { added: 'COMPETITOR_WATCH_ADDED', removed: 'COMPETITOR_WATCH_REMOVED' } as const

export const COMPETITOR_REASONS = ['SEARCH_TERM', 'MANUAL'] as const
export type CompetitorReason = (typeof COMPETITOR_REASONS)[number]
export const COMPETITOR_REASON_LABEL: Record<CompetitorReason, string> = { SEARCH_TERM: '热门搜索词点击前三', MANUAL: '手工添加' }

export const COMPETITOR_FEATURED = ['HAS_FEATURED', 'NONE'] as const
export type CompetitorFeatured = (typeof COMPETITOR_FEATURED)[number]
export const COMPETITOR_FEATURED_LABEL: Record<CompetitorFeatured, string> = { HAS_FEATURED: '有推荐报价', NONE: '没有推荐报价' }

export const COMPETITOR_SORTS = ['addedAt', 'asin', 'price', 'rank', 'priceGap', 'rankGap', 'clickShare', 'observedAt'] as const
export type CompetitorSort = (typeof COMPETITOR_SORTS)[number]

export const COMPETITOR_LIMITS = {
  /** 商品目录与竞争摘要的官方批量上限都是 20 个 ASIN。 */
  catalogBatch: 20,
  summaryBatch: 20,
  /** 每次同步最多调用的批数（竞争摘要官方限速约 30 秒一次）；关注的竞品更多时按时间槽确定性轮转。 */
  syncBatchesMax: 10,
  syncSlotMs: 6 * 3_600_000,
  /** 快照只在可见属性变化、或距上一条超过 24 小时时才写。 */
  heartbeatMs: 24 * 3_600_000,
  /** 取“最近一次”时只看这么久以内的快照；更久没有刷新（例如竞品下架）显示“尚无记录”。 */
  freshWindowMs: 3 * 24 * 3_600_000,
  /** 每个店铺最多关注的竞品条数（一个竞品对多个我方商品算多条）。 */
  watchMaxPerStore: 200,
  listMax: 2000,
  noteMax: 200,
  /** 核心搜索词：我方这个商品搜索量最高的前若干个词；推荐候选最多返回的条数。 */
  coreTerms: 20,
  candidatesMax: 50,
  candidateTermsShown: 5,
  /** 推荐候选：每个店铺最多看搜索量靠前的这么多个我方商品，最多处理这么多个店铺。 */
  candidateAsinsMax: 100,
  candidateStoresMax: 20,
  /** 读取热门搜索词与我方搜索查询表现的行数上限。 */
  termRowsMax: 4000,
  trendDays: 90,
  trendDaysMax: 180,
  trendRowsMax: 2000,
  changesMax: 50,
  sharePeriods: 12,
  offersMax: 30,
  pageSizeDefault: 50,
} as const

/** 竞品页各区块的状态。 */
export type CompetitorSectionState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'NOT_APPLICABLE' | 'NO_OFFICIAL_SOURCE' | 'RESTRICTED'

export const COMPETITOR_RATING_NOTE = '竞品的评分与评分数没有官方来源（客户反馈接口只提供我方商品，本系统不抓取亚马逊前台页面），所以这里不显示'
export const COMPETITOR_BASIS =
  '竞品来源只有官方接口与报告：热门搜索词报告里点击份额前三的商品，或手工添加。价格、推荐报价、配送方式、会员资格来自定价接口的竞争摘要；标题、品牌、图片数量、销售排名来自商品目录接口；每 6 小时同步一次，只在有变化（或每 24 小时）时留存一条快照。不抓取亚马逊前台页面。'
export const COMPETITOR_SHARE_BASIS =
  '“在我方核心词中的点击份额”：取我方这个商品搜索量最高的前 20 个核心搜索词，按搜索量加权汇总该竞品在这些词里的点击份额。热门搜索词报告只给点击前三的份额，竞品没进前三的词按 0 计，所以这是**下限**，不是精确值。'
export const COMPETITOR_GAP_BASIS =
  '与我方的价格差 = 竞品价格 − 我方价格（正数表示竞品更贵）；名次差 = 竞品名次 − 我方名次（负数表示竞品名次更靠前），只在两边是同一个分类的排名时才比较。我方价格取定价同步器最近一次的价格快照。'

// ---- 列表 ----

export interface CompetitorRow {
  /** 关注记录编号（店铺 × 竞品 ASIN × 我方对应 ASIN）。 */
  id: string
  storeId: string
  storeName: string
  asin: string
  /** 我方对应的 ASIN；没有指定为 null（此时没有价格差与名次差）。 */
  ownAsin: string | null
  ownTitle: string | null
  reason: CompetitorReason
  /** 来源是搜索词时是那个词；手工添加时是备注。 */
  reasonNote: string | null
  title: string | null
  brand: string | null
  imageCount: number | null
  price: number | null
  currency: string
  featured: CompetitorFeatured | null
  /** FBA / FBM 等，接口没给为 null。 */
  fulfillment: string | null
  memberEligible: boolean | null
  rank: number | null
  rankName: string | null
  ownPrice: number | null
  priceGap: number | null
  /** 价格差占我方价格的比例（小数）。 */
  priceGapPct: number | null
  ownRank: number | null
  rankGap: number | null
  /** 名次差为空时的原因（没有我方对应商品、分类不同、没有记录）。 */
  rankNote: string | null
  clickShare: number | null
  clickShareTerms: { hit: number; total: number } | null
  /** 最近一次快照时间；null 表示还没有同步到。 */
  observedAt: string | null
  addedAt: string
}

export interface CompetitorSummary {
  watched: number
  /** 已有快照的竞品条数 / 还在等待第一次同步的条数。 */
  withSnapshot: number
  waiting: number
}

export interface CompetitorListResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: CompetitorRow[]
  pageInfo: CursorPageInfo
  summary: CompetitorSummary
  stores: Array<{ id: string; name: string }>
  truncated: boolean
  freshness: InventoryFreshness | null
  basis: string
}

// ---- 搜索词推荐的候选 ----

export interface CompetitorCandidateTerm {
  term: string
  /** 竞品在这个词里的位次（1 到 3）与点击、转化份额。 */
  slot: 1 | 2 | 3
  clickShare: number | null
  conversionShare: number | null
  /** 我方这个商品在这个词上的搜索量（搜索查询表现）。 */
  volume: number | null
}

export interface CompetitorCandidate {
  storeId: string
  storeName: string
  asin: string
  title: string | null
  /** 这个词组里搜索量最高的我方商品（作为对应商品）。 */
  ownAsin: string
  ownTitle: string | null
  terms: CompetitorCandidateTerm[]
  termCount: number
  clickShare: number | null
  clickShareTerms: { hit: number; total: number }
}

export interface CompetitorCandidatesResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  period: { kind: 'WEEK'; start: string } | null
  items: CompetitorCandidate[]
  truncated: boolean
  freshness: InventoryFreshness | null
  basis: string
}

// ---- 详情 ----

export interface CompetitorSnapshotView {
  title: string | null
  brand: string | null
  imageCount: number | null
  price: number | null
  currency: string
  featured: CompetitorFeatured | null
  fulfillment: string | null
  memberEligible: boolean | null
  rank: number | null
  rankName: string | null
  rankClassificationId: string | null
  observedAt: string
}

export interface CompetitorWatchView {
  id: string
  ownAsin: string | null
  ownTitle: string | null
  reason: CompetitorReason
  reasonNote: string | null
  addedAt: string
}

export interface CompetitorTrendPoint {
  at: string
  price: number | null
  ownPrice: number | null
  rank: number | null
  ownRank: number | null
}

export type CompetitorChangeField = 'title' | 'brand' | 'imageCount'
export const COMPETITOR_CHANGE_LABEL: Record<CompetitorChangeField, string> = { title: '标题', brand: '品牌', imageCount: '图片数量' }
export interface CompetitorChange {
  at: string
  field: CompetitorChangeField
  label: string
  before: string | null
  after: string | null
}

export interface CompetitorSharePoint {
  periodStart: string
  share: number | null
  hit: number
  total: number
}

export interface CompetitorCompareRow {
  key: string
  label: string
  own: string | null
  competitor: string | null
  /** 无法比较时的原因（两边至少一边没有记录、分类不同）。 */
  note: string | null
}

export interface CompetitorOfferView {
  fulfillment: string
  condition: string
  price: number
  shipping: number | null
  isFeatured: boolean
  isOwn: boolean
}

export interface CompetitorDetailResponse {
  asin: string
  store: { id: string; name: string }
  /** 当前对照的我方商品；没有指定为 null。 */
  ownAsin: string | null
  ownTitle: string | null
  watches: CompetitorWatchView[]
  latest: CompetitorSnapshotView | null
  trend: { state: CompetitorSectionState; note: string | null; range: { from: string; to: string }; points: CompetitorTrendPoint[]; truncated: boolean; currency: string }
  changes: { state: CompetitorSectionState; note: string | null; items: CompetitorChange[]; truncated: boolean }
  shareTrend: { state: CompetitorSectionState; note: string | null; points: CompetitorSharePoint[]; coreTerms: number }
  compare: { state: CompetitorSectionState; note: string | null; rows: CompetitorCompareRow[] }
  otherOffers: { state: CompetitorSectionState; note: string | null; observedAt: string | null; items: CompetitorOfferView[] }
  rating: { state: 'NO_OFFICIAL_SOURCE'; note: string }
  freshness: InventoryFreshness | null
  basis: string
}

export interface CompetitorAddResult {
  id: string
  asin: string
  ownAsin: string | null
  storeId: string
  reason: CompetitorReason
  /** 新关注的竞品要等下一次同步才有数据。 */
  note: string
}
