import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'
import type { BridgeDirection, BridgeKey, ProfitBasis, ProfitFlag } from './profit.js'
import type { ProfitDictionaryView } from './profit-items.js'
import type { MetricVersionsInUse, ProfitFormulaResult, ProfitNetSalesResult } from './metric-versions-view.js'

// 利润分析页（P2b-10，07 章 7.9）的响应类型与常量。纯类型与常量，不含 zod：请求校验在 profit-query.ts。
// 数据全部来自利润日表（P2b-09 派生）：金额是店铺币种（美元），不同币种从不相加；没有数据的项是 null（页面写“尚无记录”或“尚未接入”），不是 0。

export const PROFIT_FIELD_PROFIT = 'field.profit'
export const PROFIT_FIELD_COST = 'field.cost'
/** 没有选日期范围时默认看最近多少天（含今天）。 */
export const PROFIT_DEFAULT_DAYS = 30
/** 一次汇总最多读多少个分组（店铺 × SKU × ASIN）；超过只取前面的并提示不完整。 */
export const PROFIT_GROUP_LIMIT = 20000
/** 最新生效的成本版本距今超过这么多天算“成本版本过期”。这是我们定的数，不是亚马逊或会计准则的规定。 */
export const COST_STALE_DAYS = 180
/** 利润分析页关心的数据新鲜度来源：订单、财务交易、结算报告。 */
export const PROFIT_FRESHNESS_KEYS = ['orders.api', 'finance.transactions', 'rpt.settlement'] as const

export const PROFIT_DIMENSIONS = ['SKU', 'ASIN', 'PARENT'] as const
export type ProfitDimension = (typeof PROFIT_DIMENSIONS)[number]
export const PROFIT_DIMENSION_LABEL: Readonly<Record<ProfitDimension, string>> = { SKU: '按 SKU', ASIN: '按 ASIN', PARENT: '按父体' }

export const PROFIT_SORTS = ['revenue', 'profit', 'margin', 'units'] as const
export type ProfitSort = (typeof PROFIT_SORTS)[number]
export const PROFIT_SORT_LABEL: Readonly<Record<ProfitSort, string>> = { revenue: '销售额', profit: '净利润', margin: '利润率', units: '销量' }

export interface ProfitRange {
  from: string
  to: string
  days: number
  /** 没有选日期范围，用了默认的最近 30 天。 */
  defaulted: boolean
}

/** 利润桥项目的状态：OK 有数；NO_DATA 范围内没有这一项的数据；NOT_CONNECTED 没有数据来源；RESTRICTED 没有成本字段权限。 */
export type ProfitItemState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'RESTRICTED'

export interface ProfitBridgeItem {
  key: BridgeKey
  label: string
  direction: BridgeDirection
  /** 项目合计（花费与收入都是正数）；没有数据来源、没有权限时为 null。 */
  value: number | null
  /** 对净利润的带符号贡献（收入为正，花费为负）。 */
  contribution: number | null
  state: ProfitItemState
  note: string | null
}

export interface ProfitBridgeView {
  items: ProfitBridgeItem[]
  /** 净利润：范围内只要有一行因缺成本算不出，就整体不给（null），不拿部分数字冒充。 */
  netProfit: number | null
  /** 已能算出利润的行的利润合计（只是部分，不代表整体）。 */
  coveredProfit: number | null
  incompleteRows: number
  rows: number
}

export interface ProfitSummary {
  revenue: number | null
  units: number
  netProfit: number | null
  /** 净利润 ÷ 销售额；净利润算不出或销售额为 0 时为 null。 */
  margin: number | null
  coveredProfit: number | null
  incompleteRows: number
  rows: number
  /** 已计成本件数 ÷ 销售件数；需要 field.cost；没有销售件数为 null。 */
  costCoverage?: number | null
}

export interface ProfitFlagCount {
  flag: ProfitFlag
  label: string
  severity: 'WARN' | 'INFO'
  note: string
  /** 带这个标记的利润日表行数（店铺 × SKU × 日）。 */
  rows: number
}

export interface ProfitTrendPoint {
  date: string
  revenue: number
  /** 当天净利润；当天有一行因缺成本算不出时为 null。 */
  profit: number | null
  coveredProfit: number | null
}

interface ProfitCommon {
  state: 'OK' | 'NO_DATA'
  note: string | null
  recognition: ProfitBasis
  basisLabel: string
  basisNote: string
  currency: string
  range: ProfitRange
  freshness: InventoryFreshness
}

export interface ProfitOverviewResponse extends ProfitCommon {
  summary: ProfitSummary
  bridge: ProfitBridgeView
  trend: ProfitTrendPoint[]
  flags: ProfitFlagCount[]
  /** 利润日表最近一次刷新时间；没有数据为 null。 */
  refreshedAt: string | null
  metricVersion: string
  /** 页面要原样显示的口径说明（关税、汇兑损益、广告未分摊等）。 */
  notes: string[]
  /** 按利润项目字典拆开的明细（P6-18）；还没有字典时为 null。 */
  dictionary?: ProfitDictionaryView | null
  /** 毛利润与毛利率（P6-31，按生效的利润公式）。 */
  formula?: ProfitFormulaResult
  /** 净销售额（P6-31，按生效的业务口径）。 */
  netSales?: ProfitNetSalesResult
  /** 本次计算读取的口径版本（P6-31）。 */
  metricVersions?: MetricVersionsInUse
}

export interface ProfitStoreRow {
  sellerAccountId: string
  storeName: string
  units: number
  revenue: number | null
  netProfit: number | null
  margin: number | null
  bridge: ProfitBridgeView
}
export interface ProfitStoresResponse extends ProfitCommon {
  items: ProfitStoreRow[]
}

/** 成本折算明细：同一行里不同成本币种、汇率来源分开列；原币金额、折算美元、汇率与来源一起给。需要 field.cost。 */
export interface ProfitCostDetail {
  currency: string | null
  rate: number | null
  /** 汇率来源（手工覆盖或系统获取）；没有汇率为 null。 */
  source: string | null
  /** 其中有沿用前值汇率的行数。 */
  fallbackRows: number
  productOriginal: number | null
  productConverted: number | null
  firstMileOriginal: number | null
  firstMileConverted: number | null
}

export interface ProfitPerUnit {
  revenue: number | null
  fees: number | null
  productCost?: number | null
  profit: number | null
}

export interface ProfitGroupRow {
  /** 稳定的行键：SKU 视图是 店铺|SKU，ASIN 视图是 ASIN，父体视图是父 ASIN。 */
  key: string
  dimension: ProfitDimension
  asin: string | null
  sku: string | null
  parentAsin: string | null
  title: string | null
  storeName: string | null
  /** 商品编号（FbaProduct.id），有对应商品时才有，用来链到 ASIN 360。 */
  productId: string | null
  units: number
  revenue: number
  refunds: number
  /** 6 项平台费用合计。 */
  fees: number
  promotion: number
  reimbursement: number
  /** 分摊到本行的广告花费（P3-16：先按广告商品报表归属到 ASIN，剩余按规则分摊）；范围内没有分摊结果（广告未接入）时是 null。 */
  adsAllocated: number | null
  /** 以下三项与成本覆盖率、折算明细需要 field.cost。 */
  productCost?: number | null
  firstMileCost?: number | null
  otherCost?: number | null
  costCoverage?: number | null
  costDetail?: ProfitCostDetail[]
  /** 本行净利润（已扣分摊到本行的广告，不含店铺级行里没分出去的广告）；有一行缺成本就是 null。 */
  profit: number | null
  margin: number | null
  incompleteRows: number
  rows: number
  perUnit: ProfitPerUnit | null
  /** 与官方单品经济的净收益对照：本表暂不并排对照（P2b-11 的官方数据在“官方经济数据对账”页逐 SKU 逐日核对），note 指向那一页。 */
  official: { state: 'NOT_CONNECTED'; note: string }
}

export interface ProfitGroupsResponse extends ProfitCommon {
  dimension: ProfitDimension
  items: ProfitGroupRow[]
  pageInfo: CursorPageInfo
  /** 没有 SKU 的费用与没能分摊到商品的广告花费落在店铺级行，不属于任何 SKU；合计 = 各行合计 + 店铺级行。 */
  storeLevel: ProfitBridgeView | null
  /** 分组数超过读取上限，列表不完整。 */
  truncated: boolean
}

export type ProfitAdsVerdict = 'PROFIT_AFTER_ADS' | 'LOSS_AFTER_ADS' | 'NOT_ALLOCATED' | 'NO_COST'
export const PROFIT_ADS_VERDICT_LABEL: Readonly<Record<ProfitAdsVerdict, string>> = {
  PROFIT_AFTER_ADS: '广告后仍盈利',
  LOSS_AFTER_ADS: '广告后亏损',
  NOT_ALLOCATED: '广告尚未分摊',
  NO_COST: '缺成本，无法判断',
}

export interface ProfitAdsStoreRow {
  sellerAccountId: string
  storeName: string
  revenue: number | null
  /** 店铺的广告花费合计（含已分摊与未分摊）；没有绑定广告账户或没有花费记录为 null。 */
  adsSpend: number | null
  /** 广告花费 ÷ 销售额。 */
  adsShare: number | null
  /** 不含广告的净利润（净利润 + 广告花费）；净利润算不出为 null。 */
  profitBeforeAds: number | null
  netProfit: number | null
}

export interface ProfitAdsRow {
  key: string
  asin: string | null
  sku: string | null
  title: string | null
  storeName: string | null
  productId: string | null
  revenue: number
  adsAllocated: number | null
  profitBeforeAds: number | null
  profit: number | null
  adsShare: number | null
  verdict: ProfitAdsVerdict
}

export interface ProfitAdsResponse extends ProfitCommon {
  /** 广告分摊状态：范围内任一商品行有分摊结果为 ALLOCATED；广告未接入或这些日子还没重算时是 NOT_ALLOCATED。 */
  allocation: { state: 'NOT_ALLOCATED' | 'ALLOCATED'; note: string }
  stores: ProfitAdsStoreRow[]
  items: ProfitAdsRow[]
  pageInfo: CursorPageInfo
  truncated: boolean
}

export type ProfitCoverageIssue = 'COST_MISSING' | 'COST_LAYERS_EXHAUSTED' | 'COST_DRAFT_ONLY' | 'FIRST_MILE_MISSING' | 'FX_FALLBACK' | 'FX_MISSING' | 'COST_MIXED_CURRENCY' | 'COST_STALE'
export const PROFIT_COVERAGE_ISSUES: readonly ProfitCoverageIssue[] = [
  'COST_MISSING',
  'COST_LAYERS_EXHAUSTED',
  'COST_DRAFT_ONLY',
  'FIRST_MILE_MISSING',
  'FX_MISSING',
  'FX_FALLBACK',
  'COST_MIXED_CURRENCY',
  'COST_STALE',
]
export const PROFIT_COVERAGE_ISSUE_LABEL: Readonly<Record<ProfitCoverageIssue, string>> = {
  COST_MISSING: '缺少成本',
  COST_LAYERS_EXHAUSTED: '成本批次不够',
  COST_DRAFT_ONLY: '成本仍是草稿',
  FIRST_MILE_MISSING: '头程成本缺失',
  FX_FALLBACK: '汇率沿用前值',
  FX_MISSING: '汇率缺失',
  COST_MIXED_CURRENCY: '成本币种混用',
  COST_STALE: '成本版本过期',
}

export interface ProfitCoverageRow {
  key: string
  sellerAccountId: string
  storeName: string
  sku: string
  asin: string | null
  title: string | null
  productId: string | null
  units: number
  costedUnits: number
  coverage: number | null
  issues: Array<{ issue: ProfitCoverageIssue; label: string; rows: number }>
  /** 该 SKU 最新生效的成本版本的生效日；没有生效版本为 null。成本版本按企业与 SKU 存，不分店铺。 */
  latestCostEffective: string | null
  costAgeDays: number | null
}

export interface ProfitCoverageResponse extends ProfitCommon {
  summary: { skus: number; skusWithIssues: number; staleSkus: number; units: number; costedUnits: number; coverage: number | null }
  /** 广告花费里还没分摊到 SKU 的金额（店铺级行，可以是 0）；广告没接入时 state 是 NOT_CONNECTED，不显示 0。 */
  adsUnallocated: { state: 'OK' | 'NOT_CONNECTED'; total: number | null; stores: Array<{ sellerAccountId: string; storeName: string; amount: number }> }
  fx: { fallbackRows: number; missingRows: number; items: Array<{ currency: string; source: string | null; fallback: boolean; rows: number; rate: number | null }> }
  items: ProfitCoverageRow[]
  pageInfo: CursorPageInfo
  truncated: boolean
  staleDays: number
}

export interface ProfitBridgeCompareRow {
  key: BridgeKey
  label: string
  direction: BridgeDirection
  state: ProfitItemState
  /** 对比期（基准）与当前期的项目合计。 */
  base: number | null
  current: number | null
  /** 对净利润的影响：当前期贡献 − 对比期贡献（正数表示让利润变多）；任一期没有数据为 null。 */
  impact: number | null
}

export interface ProfitBridgeCompareResponse extends ProfitCommon {
  /** `range` 是当前期。 */
  baseRange: ProfitRange
  compareMode: 'previous' | 'yoy' | 'custom'
  base: ProfitSummary
  current: ProfitSummary
  rows: ProfitBridgeCompareRow[]
  /** 净利润变化；任一期净利润算不出为 null，此时 `note` 写明原因，逐项变化仍然给出。 */
  netImpact: number | null
  /** 逐项影响之和与净利润变化之差（舍入、尚未接入项目造成），绝对值很小才是正常。 */
  unexplained: number | null
}
