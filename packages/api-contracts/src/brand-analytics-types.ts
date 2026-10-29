import type { BrStoreStatus } from './business-reports.js'
import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'
import type { BaBasketAdvice, BaBreakpoint, BaPeriod, BaQuadrant, BaTermGroup } from './brand-analytics.js'

// 品牌分析的响应形状、排序与筛选枚举（P4-04）。常量与规则在 brand-analytics.ts，纯计算在 brand-analytics-math.ts。

// ---- 响应 ----

export type BaState = 'OK' | 'NO_DATA'

export interface BaPeriodInfo {
  kind: BaPeriod
  /** 选中的周期起止日；这一种周期还没有任何数据时为 null。 */
  start: string | null
  end: string | null
  previousStart: string | null
  /** 已有数据的周期起始日，最近的在前，最多 BA_PERIOD_OPTIONS_LIMIT 个。 */
  available: string[]
  /** 没传周期起始日，用了最近一个有数据的周期。 */
  defaulted: boolean
}

export interface BaCommon {
  state: BaState
  note: string | null
  period: BaPeriodInfo
  stores: BrStoreStatus[]
  /** 读到 BA_ROW_LIMIT 行上限，统计只含已读到的部分。 */
  truncated: boolean
  basis: string
  freshness: InventoryFreshness
}

export interface BaShareSet {
  impression: number | null
  click: number | null
  cartAdd: number | null
  purchase: number | null
}

export const BA_FUNNEL_STAGES = ['impressions', 'clicks', 'cartAdds', 'purchases'] as const
export type BaFunnelKey = (typeof BA_FUNNEL_STAGES)[number]
export const BA_FUNNEL_LABEL: Readonly<Record<BaFunnelKey, string>> = { impressions: '展示', clicks: '点击', cartAdds: '加购', purchases: '购买' }

export interface BaFunnelStage {
  key: BaFunnelKey
  label: string
  market: number | null
  own: number | null
  share: number | null
  previousShare: number | null
  /** 份额变化（百分点，0.012 = +1.2 个百分点）；任一期没有份额为 null。 */
  shareChange: number | null
}

export interface BaTrendPoint {
  periodStart: string
  volume: number | null
  shares: BaShareSet
}

export interface BaPriceRow {
  stage: 'click' | 'cartAdd' | 'purchase'
  label: string
  own: number | null
  market: number | null
  /** 我方相对市场的价差比例（0.1 = 贵 10%）；任一方没有为 null。 */
  gap: number | null
}

export const BA_SHIPPING_SPEEDS = ['SAME_DAY', 'ONE_DAY', 'TWO_DAY'] as const
export type BaShippingSpeed = (typeof BA_SHIPPING_SPEEDS)[number]
export const BA_SHIPPING_LABEL: Readonly<Record<BaShippingSpeed, string>> = { SAME_DAY: '当日达', ONE_DAY: '次日达', TWO_DAY: '两日达' }
export interface BaShippingRow {
  speed: BaShippingSpeed
  label: string
  own: number | null
  market: number | null
  share: number | null
}

export type BaAdvertising = 'ADVERTISED' | 'PAUSED' | 'NONE' | 'NOT_CONNECTED'
export const BA_ADVERTISING_LABEL: Readonly<Record<BaAdvertising, string>> = { ADVERTISED: '已投放', PAUSED: '已暂停', NONE: '未投放', NOT_CONNECTED: '尚未接入' }

export interface BaQueryRow {
  key: string
  searchQuery: string
  searchVolume: number | null
  searchScore: number | null
  shares: BaShareSet
  /** 与上一周期的份额变化（百分点）；上一周期没有这个词或份额为 null。 */
  changes: BaShareSet
  ownPurchases: number | null
  marketPurchases: number | null
  advertising: BaAdvertising
  quadrant: BaQuadrant | null
  breakpoint: BaBreakpoint | null
}

export interface BaQuadrantPoint {
  searchQuery: string
  volume: number
  purchaseShare: number
  quadrant: BaQuadrant
}
export interface BaQuadrantSummary {
  state: 'OK' | 'INSUFFICIENT'
  note: string
  medians: { volume: number; purchaseShare: number } | null
  counts: Record<BaQuadrant, number>
  points: BaQuadrantPoint[]
}
export interface BaBreakpointExample {
  searchQuery: string
  searchVolume: number | null
  shares: BaShareSet
}
export interface BaBreakpointSummary {
  state: 'OK' | 'INSUFFICIENT'
  note: string
  medians: BaShareSet | null
  counts: Record<BaBreakpoint, number>
  /** 每种断点按搜索量取前几个词做例子。 */
  examples: Record<BaBreakpoint, BaBreakpointExample[]>
}

export interface BaRootRow {
  root: string
  forms: string[]
  terms: number
  marketClicks: number
  ownClicks: number
  clickShare: number | null
  marketPurchases: number
  ownPurchases: number
  purchaseShare: number | null
}
export interface BaOverview {
  state: 'OK' | 'NO_DATA'
  note: string
  rows: BaRootRow[]
}

export interface BaAsinOption {
  asin: string
  title: string | null
  brand: string | null
  terms: number
}

export type BaDimension = 'ASIN' | 'BRAND'
export interface BaSearchQueryResponse extends BaCommon {
  dimension: BaDimension
  selection: { asin: string | null; brand: string | null }
  asinOptions: BaAsinOption[]
  brandOptions: string[]
  funnel: BaFunnelStage[]
  trend: BaTrendPoint[]
  trendNote: string
  price: BaPriceRow[]
  priceNote: string
  shipping: BaShippingRow[]
  quadrant: BaQuadrantSummary
  breakpoints: BaBreakpointSummary
  overview: BaOverview
  items: BaQueryRow[]
  pageInfo: CursorPageInfo
}

export const BA_SQP_SORTS = ['searchVolume', 'impressionShare', 'clickShare', 'cartAddShare', 'purchaseShare', 'purchaseShareChange', 'ownPurchases'] as const
export type BaSqpSort = (typeof BA_SQP_SORTS)[number]
export const BA_SQP_SORT_LABEL: Readonly<Record<BaSqpSort, string>> = {
  searchVolume: '搜索量',
  impressionShare: '展示份额',
  clickShare: '点击份额',
  cartAddShare: '加购份额',
  purchaseShare: '购买份额',
  purchaseShareChange: '购买份额变化',
  ownPurchases: '我方购买次数',
}

// 目录表现

export interface BaCatalogFunnel {
  impressions: number | null
  clicks: number | null
  cartAdds: number | null
  purchases: number | null
  /** 各步转化：点击率 = 点击 ÷ 展示，加购率 = 加购 ÷ 点击，购买率 = 购买 ÷ 加购。 */
  clickRate: number | null
  cartAddRate: number | null
  purchaseRate: number | null
  searchTrafficSales: number | null
}
export interface BaCatalogRow extends BaCatalogFunnel {
  key: string
  asin: string
  title: string | null
  productId: string | null
  brand: string | null
  previous: { clickRate: number | null; cartAddRate: number | null; purchaseRate: number | null } | null
  /** 与业务报告对照（同周期同 ASIN）：订购销售额、会话；没有业务报告数据为 null。 */
  allSales: number | null
  sessions: number | null
  /** 搜索带来的销售额 ÷ 订购销售额（同为美元口径，可对照）。 */
  searchSalesShare: number | null
  /** 搜索点击 ÷ 会话，只是量级参照：点击与会话不是同一口径。 */
  clicksPerSession: number | null
}
export interface BaCatalogResponse extends BaCommon {
  summary: BaCatalogFunnel
  items: BaCatalogRow[]
  pageInfo: CursorPageInfo
  compareNote: string
}
export const BA_CATALOG_SORTS = ['impressions', 'clicks', 'cartAdds', 'purchases', 'searchTrafficSales', 'clickRate', 'purchaseRate'] as const
export type BaCatalogSort = (typeof BA_CATALOG_SORTS)[number]
export const BA_CATALOG_SORT_LABEL: Readonly<Record<BaCatalogSort, string>> = {
  impressions: '展示',
  clicks: '点击',
  cartAdds: '加购',
  purchases: '购买',
  searchTrafficSales: '搜索带来的销售额',
  clickRate: '点击率',
  purchaseRate: '购买率',
}

// 热门搜索词

export interface BaTermSlot {
  rank: number
  asin: string | null
  title: string | null
  clickShare: number | null
  conversionShare: number | null
  own: boolean
}
export interface BaTermRow {
  key: string
  department: string
  searchTerm: string
  rank: number | null
  previousRank: number | null
  /** 排名变化（正数 = 排名数字变小 = 热度上升）；任一期没有排名为 null。 */
  rankChange: number | null
  slots: BaTermSlot[]
  /** 我方是否进入前三（点击份额前三里有我方 ASIN）。 */
  inTop3: boolean
  group: BaTermGroup | null
}
export interface BaTermHistoryPoint {
  periodStart: string
  rank: number | null
  ownBestClickShare: number | null
  inTop3: boolean
}
export interface BaTermsResponse extends BaCommon {
  groupCounts: Record<BaTermGroup, number> & { top3: number }
  groupBasis: string
  competitorNote: string
  items: BaTermRow[]
  pageInfo: CursorPageInfo
  history: { term: string; points: BaTermHistoryPoint[] } | null
  /** 我方 ASIN 数；为 0 时没法判断“是否进入前三”。 */
  ownAsinCount: number
}
export const BA_TERM_FILTERS = ['ALL', 'OPPORTUNITY', 'RISK', 'TOP3'] as const
export type BaTermFilter = (typeof BA_TERM_FILTERS)[number]
export const BA_TERM_FILTER_LABEL: Readonly<Record<BaTermFilter, string>> = { ALL: '全部', OPPORTUNITY: '机会词', RISK: '风险词', TOP3: '我方进前三' }

// 购物篮

export interface BaBasketRow {
  key: string
  asin: string
  asinTitle: string | null
  asinProductId: string | null
  pairedAsin: string
  pairedTitle: string | null
  pairedOwn: boolean
  combinationPct: number | null
  previousPct: number | null
  /** 同篮率变化（百分点）。 */
  change: number | null
  purchaseRank: number | null
  advice: BaBasketAdvice | null
}
export interface BaMatrix {
  rows: string[]
  columns: string[]
  /** 与 rows × columns 一一对应；没有这一对为 null。 */
  cells: Array<Array<number | null>>
  max: number | null
}
export interface BaBasketResponse extends BaCommon {
  matrix: BaMatrix
  adviceBasis: string
  adviceCounts: Record<BaBasketAdvice, number>
  items: BaBasketRow[]
  pageInfo: CursorPageInfo
}
export const BA_BASKET_SORTS = ['combinationPct', 'change', 'purchaseRank'] as const
export type BaBasketSort = (typeof BA_BASKET_SORTS)[number]
export const BA_BASKET_SORT_LABEL: Readonly<Record<BaBasketSort, string>> = { combinationPct: '同篮率', change: '同篮率变化', purchaseRank: '同篮排名' }

// 重复购买

export interface BaRepeatFigures {
  orders: number | null
  uniqueCustomers: number | null
  repeatCustomersPct: number | null
  repeatRevenue: number | null
  repeatRevenuePct: number | null
}
export interface BaRepeatRow extends BaRepeatFigures {
  key: string
  /** ASIN 维度是 ASIN，品牌维度是品牌名（没有品牌的商品归“未登记品牌”）。 */
  label: string
  asin: string | null
  title: string | null
  productId: string | null
  asins: number
  previousRepeatCustomersPct: number | null
  repeatCustomersChange: number | null
}
export interface BaRepeatTrendPoint extends BaRepeatFigures {
  periodStart: string
}
export interface BaRepeatResponse extends BaCommon {
  dimension: BaDimension
  summary: BaRepeatFigures
  trend: BaRepeatTrendPoint[]
  items: BaRepeatRow[]
  pageInfo: CursorPageInfo
  repeatNote: string
}
export const BA_REPEAT_SORTS = ['orders', 'uniqueCustomers', 'repeatCustomersPct', 'repeatRevenue', 'repeatRevenuePct', 'repeatCustomersChange'] as const
export type BaRepeatSort = (typeof BA_REPEAT_SORTS)[number]
export const BA_REPEAT_SORT_LABEL: Readonly<Record<BaRepeatSort, string>> = {
  orders: '订单数',
  uniqueCustomers: '独立买家数',
  repeatCustomersPct: '复购买家占比',
  repeatRevenue: '复购销售额',
  repeatRevenuePct: '复购销售额占比',
  repeatCustomersChange: '复购买家占比变化',
}
export const BA_REPEAT_NOTE =
  '官方重复购买报告给的是“复购买家占比”（重复购买的买家 ÷ 独立买家）与“复购销售额占比”，没有复购订单数，所以本页写“复购买家占比”，不把它当成复购订单占比；汇总的复购买家占比按独立买家数加权'
export const BA_NO_BRAND_LABEL = '未登记品牌'
