import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// 官方经济数据对账（P2b-11，07 章 7.10，freeze/api.md /finance/economics/*）的常量与响应类型。纯类型与常量，不含 zod：请求校验在 economics-query.ts，
// 纯函数（双源核对、差异分类）在 economics-math.ts。
// 数据来源：亚马逊数据中心 analytics_economics_2024_03_15 的 economics（实际）、economicsPreview（费用预览）、economicsSimulation（情景模拟）。
// 口径：金额都是美元；官方没给的值是 null（页面写“官方未提供”或“尚无记录”），不是 0；币种不是美元的行不核对，也不换算。

export const ECONOMICS_READ = 'finance.read'
export const ECONOMICS_FIELD_PROFIT = 'field.profit'
export const ECONOMICS_FIELD_COST = 'field.cost'

/** 数据中心数据集标识（任务上下文 context.dataset）。 */
export const ECONOMICS_DATASET_DAILY = 'dk.economics'
export const ECONOMICS_DATASET_PREVIEW = 'dk.economics-preview'
export const ECONOMICS_DATASET_SIMULATION = 'dk.economics-simulation'
/** 新鲜度来源键（importers.md D-04、D-05）。 */
export const ECONOMICS_DAILY_FRESHNESS_KEY = 'dk.economics'
export const ECONOMICS_PREVIEW_FRESHNESS_KEY = 'dk.economics.preview'
/** 双源核对页同时展示的新鲜度：官方经济数据、订单、财务交易（我方利润日表由这两者派生）。 */
export const ECONOMICS_PREVIEW_FRESHNESS_KEYS = [ECONOMICS_PREVIEW_FRESHNESS_KEY] as const
export const ECONOMICS_COMPARE_FRESHNESS_KEYS = [ECONOMICS_DAILY_FRESHNESS_KEY, 'orders.api', 'finance.transactions'] as const

/** 我方利润日表只有美元；官方行的币种不是美元时不核对。 */
export const ECONOMICS_OURS_CURRENCY = 'USD'
/** 一行里各项差异不超过它算一致（美元，我们定的数；与结算核对、到账核对同口径）。 */
export const ECONOMICS_TOLERANCE = 0.05
/** 官方数据每天重拉最近多少天（官方会修正近期数据）；店铺第一次拉取时回补多少天。 */
export const ECONOMICS_REFRESH_DAYS = 14
export const ECONOMICS_BACKFILL_DAYS = 90
/** 双源核对一次最多看多少天；每边最多读多少行（Prisma 单次读取上限 20000，超过标记不完整）。 */
export const ECONOMICS_COMPARE_MAX_DAYS = 90
export const ECONOMICS_ROW_LIMIT = 19_999 // 多读一行判断是否被截断，合计 20000 行刚好是平台单次读取的上限
/** 费用预览：官方限制未来最多 120 天；开始日不得早于“今天”，所以查询区间只取 119 天，避免两边时区差一天被拒。 */
export const ECONOMICS_PREVIEW_MAX_DAYS = 120
export const ECONOMICS_PREVIEW_QUERY_DAYS = 119
/** 官方预览查询里要的费用类型（用汇总类型，不同时要“基础”类型，避免重复计入）。 */
export const ECONOMICS_PREVIEW_FEE_TYPES = [
  'FBA_FULFILLMENT_FEES',
  'MONTHLY_INVENTORY_STORAGE_FEES',
  'REFERRAL_FEES',
  'AGED_INVENTORY_SURCHARGE',
  'LOW_INVENTORY_LEVEL_FEE',
  'FBA_INBOUND_PLACEMENT_SERVICE_FEE',
  'HIGH_RETURN_RATE_FEE',
  'RETURN_PROCESSING_FEE',
  'STORAGE_UTILIZATION_SURCHARGE',
  'PER_ITEM_SELLING_FEES',
  'CLOSING_FEES',
] as const
/** 费用预览的数据超过这么多天没有重新查询就不再展示（每日刷新，留 3 天余量）；旧行由定时任务清理。 */
export const ECONOMICS_PREVIEW_STALE_DAYS = 3
export const ECONOMICS_PREVIEW_PURGE_DAYS = 7

/** 情景模拟：官方支持的动作、最多模拟天数、数量上限。 */
export const ECONOMICS_SIM_ACTIONS = ['AWD', 'SIPP'] as const
export type EconomicsSimAction = (typeof ECONOMICS_SIM_ACTIONS)[number]
export const ECONOMICS_SIM_ACTION_LABEL: Readonly<Record<EconomicsSimAction, string>> = { AWD: '发往上游仓储（AWD）', SIPP: '原包装发货（SIPP）' }
export const ECONOMICS_SIM_MAX_DAYS = 90
export const ECONOMICS_SIM_MAX_QUANTITY = 10_000_000
export const ECONOMICS_SIM_MAX_PRICE = 100_000

// ---- 差异分类 ----

/** 差异来源：成本口径、广告口径、时间口径、未解释（07 章 7.10 第 1 个页签）。 */
export const DIFF_CLASSES = ['COST', 'ADS', 'TIME', 'UNEXPLAINED'] as const
export type DiffClass = (typeof DIFF_CLASSES)[number]
export const DIFF_CLASS_LABEL: Readonly<Record<DiffClass, string>> = { COST: '成本口径', ADS: '广告口径', TIME: '时间口径', UNEXPLAINED: '未解释' }
export const DIFF_CLASS_NOTE: Readonly<Record<DiffClass, string>> = {
  COST: '官方用卖家在亚马逊后台填的单件成本乘以净销量；我方用成本版本按存货计价规则算的采购成本与头程。两边都有成本时的差额归这一类。',
  ADS: '官方把广告扣款算到商品上；我方按广告商品报表归属并按规则分摊到商品（P3-16），两边的广告差额归这一类。',
  TIME: '销售额与费用在两边落在不同的日期（例如官方退款按退款申请时间、我方按下单日），按所选区间合计后互相抵消的部分。',
  UNEXPLAINED: '按区间合计后仍然存在的销售额与费用差额，没有已知原因，需要人工核对（例如费用类型归并、官方统计范围不同）。',
}

/** 一行的结论：一致、归入某一类差异（取绝对值最大的一类），或无法核对。 */
export type CompareVerdict = 'MATCH' | DiffClass | 'NOT_COMPARABLE'
export const VERDICT_LABEL: Readonly<Record<CompareVerdict, string>> = { MATCH: '一致', ...DIFF_CLASS_LABEL, NOT_COMPARABLE: '无法核对' }

export const NOT_COMPARABLE_REASONS = ['OURS_NO_RECORD', 'OFFICIAL_NO_RECORD', 'CURRENCY_MISMATCH'] as const
export type NotComparableReason = (typeof NOT_COMPARABLE_REASONS)[number]
export const NOT_COMPARABLE_LABEL: Readonly<Record<NotComparableReason, string>> = {
  OURS_NO_RECORD: '我方利润日表在所选区间没有这个 SKU 的记录',
  OFFICIAL_NO_RECORD: '官方经济数据在所选区间没有这个 SKU 的记录',
  CURRENCY_MISMATCH: '官方币种不是美元，不换算、不核对',
}

export const COMPARE_FILTERS = ['ALL', 'DIFF', 'MATCH', 'NOT_COMPARABLE', ...DIFF_CLASSES] as const
export type CompareFilter = (typeof COMPARE_FILTERS)[number]
export const COMPARE_SORTS = ['diff', 'date'] as const
export type CompareSort = (typeof COMPARE_SORTS)[number]
export const COMPARE_SORT_LABEL: Readonly<Record<CompareSort, string>> = { diff: '差异绝对值', date: '日期' }

// ---- 双源核对 ----

/** 官方一天的数（美元）。cost 是官方单件成本 × 净销量，卖家没填成本为 null。 */
export interface EconomicsOfficialView {
  sales: number
  orderedSales: number
  refundedSales: number
  units: number
  fees: number
  ads: number
  costPerUnit: number | null
  cost: number | null
  netProceeds: number | null
  currency: string
}

/** 我方一天的数（来自利润日表，所选收入确认口径）。ads 为 null 表示广告尚未分摊到商品；cost 为 null 表示没有成本；没有记录时 state 为 NO_RECORD、数值全为 null。 */
export interface EconomicsOursView {
  state: 'OK' | 'NO_RECORD'
  sales: number | null
  fees: number | null
  ads: number | null
  cost: number | null
  units: number | null
  /** 与官方同口径的净收益：销售净额 − 费用 − 广告(未分摊算 0) − 成本（仅在两边都有成本时扣）。 */
  netComparable: number | null
  profit: number | null
}

/** 各项对“官方净收益 − 我方可比净收益”的带符号影响（正数表示官方更高）；合计等于 net。 */
export interface EconomicsImpact {
  sales: number
  fees: number
  ads: number
  /** 官方没填成本、我方没有成本或没有成本字段权限时不核对成本，为 null。 */
  cost: number | null
  net: number
}

export interface EconomicsCompareRow {
  key: string
  sellerAccountId: string
  storeName: string
  msku: string
  asin: string | null
  date: string
  official: EconomicsOfficialView | null
  ours: EconomicsOursView
  impact: EconomicsImpact | null
  /** 差异按来源拆开，合计等于 impact.net；无法核对的行为 null。 */
  parts: Record<DiffClass, number> | null
  verdict: CompareVerdict
  notComparable: NotComparableReason | null
  /** 这一行需要特别说明的事（官方没填成本、广告没分摊、我方没有成本等）。 */
  notes: string[]
}

export interface EconomicsSideTotals {
  sales: number | null
  fees: number | null
  ads: number | null
  cost: number | null
  netProceeds: number | null
}

export interface EconomicsCompareSummary {
  /** 过滤后的行数、可核对的行数、一致的行数、无法核对的行数。 */
  rows: number
  comparable: number
  matched: number
  notComparable: number
  /** 可核对行里官方与我方的合计（没有可核对行为 null）。 */
  official: EconomicsSideTotals
  ours: EconomicsSideTotals
  /** 可核对行的净差异合计；没有可核对行为 null。 */
  netDiff: number | null
  byClass: Record<DiffClass, { amount: number; rows: number }>
  /** 店铺层面的广告核对：官方各商品广告扣款合计 vs 我方账户级广告（利润日表店铺级行）。 */
  ads: { state: 'OK' | 'NOT_CONNECTED' | 'NO_DATA'; official: number | null; ours: number | null; diff: number | null; note: string }
}

export interface EconomicsRange {
  from: string
  to: string
  days: number
  defaulted: boolean
}

export interface EconomicsCompareResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  recognition: string
  basisLabel: string
  currency: string
  range: EconomicsRange
  summary: EconomicsCompareSummary
  items: EconomicsCompareRow[]
  pageInfo: CursorPageInfo
  /** 官方数据实际覆盖的日期范围（范围内各店铺的最早与最晚一天）；一行都没有为 null。 */
  officialCoverage: { from: string; to: string } | null
  /** 任何一边的行数超过读取上限：结果不完整。 */
  truncated: boolean
  notes: string[]
  freshness: InventoryFreshness
}

// ---- 费用预览 ----

/** impact 的状态：OK 有影响值；NO_CHANGE 官方没有给出费用调整；UNKNOWN_QUANTITY 有调整但官方没给预估数量，算不出影响。 */
export type PreviewImpactState = 'OK' | 'NO_CHANGE' | 'UNKNOWN_QUANTITY'

export interface EconomicsPreviewRow {
  key: string
  sellerAccountId: string
  storeName: string
  msku: string
  asin: string | null
  feeType: string
  rangeStart: string
  rangeEnd: string
  estimatedAmount: number
  quantity: number | null
  amountPerUnit: number | null
  amountPerUnitDelta: number | null
  currency: string
  /** 费用调整对利润的影响 = −单件费用变化 × 预估数量（费用变高为负）。 */
  impact: number | null
  impactState: PreviewImpactState
}

export interface EconomicsPreviewFeeGroup {
  feeType: string
  rows: number
  estimated: number
  impact: number | null
}

export interface EconomicsPreviewResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  currency: string
  /** 范围内各店铺最近一次查询时间里最早的一个；没有数据为 null。 */
  queriedAt: string | null
  horizon: { from: string; to: string } | null
  summary: { products: number; rows: number; changedRows: number; unknownRows: number; totalImpact: number | null; byFeeType: EconomicsPreviewFeeGroup[] }
  items: EconomicsPreviewRow[]
  pageInfo: CursorPageInfo
  notes: string[]
  freshness: InventoryFreshness
}

// ---- 情景模拟 ----

export interface EconomicsSimulationInput {
  sellerAccountId: string
  sku: string
  actionType: EconomicsSimAction
  quantity: number | null
  itemPrice: number | null
  startDate: string
  endDate: string
}

export interface EconomicsSimulationResult {
  currency: string | null
  sales: number | null
  fees: number | null
  netProceeds: number | null
  units: number | null
  rows: number
}

export interface EconomicsSimulation {
  runId: string
  status: 'PENDING' | 'DONE' | 'FAILED'
  note: string | null
  input: EconomicsSimulationInput
  result: EconomicsSimulationResult | null
}
