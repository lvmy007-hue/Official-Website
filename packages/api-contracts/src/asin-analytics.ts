import type { BrCommon } from './business-reports.js'
import type { DashState } from './dashboard.js'
import type { InventoryRiskLevel } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// ASIN 与父体分析（P4-03，04 章 4.6，freeze/api.md `GET /analytics/asins`、`GET /analytics/parents/:parentAsin/*`）。
// 只放常量、标签与响应类型（没有 zod，请求校验在 asin-analytics-query.ts）。销售与流量只读 P4-01 的 `SalesTrafficAsinDaily`（子体粒度，数据中心优先），
// 只统计美元；官方没给的值是 null（页面写“尚无记录”），不是 0。一个父体的数字 = 它名下各子体（ASIN）逐日相加。

export const ASIN_ANALYTICS_READ = 'analytics.read'
/** 对比模式最多并排几个对象。 */
export const ASIN_COMPARE_MAX = 5
export const ASIN_TREE_PAGE_SIZE = 20
/** 读商品目录的上限（Prisma 单次读取上限 20000，多读一行判断被截断）。 */
export const ASIN_PRODUCT_LIMIT = 19_999
/** 一个父体最多处理多少个子体 ASIN；超过的按销售额从高到低保留。 */
export const ASIN_MEMBER_LIMIT = 300
/** 子体趋势图最多叠加几个子体，其余合并成“其他”。 */
export const ASIN_TREND_TOP = 10

export const ASIN_METRIC_KEYS = ['sales', 'units', 'sessions', 'pageViews', 'conversion', 'price', 'buyBox', 'adsSales', 'organicSales', 'returnRate', 'daysOfSupply', 'salesRank'] as const
export type AsinMetricKey = (typeof ASIN_METRIC_KEYS)[number]

export interface AsinMetricInfo {
  label: string
  format: 'money' | 'number' | 'percent' | 'days' | 'rank'
  basis: string
}
export const ASIN_METRIC_INFO: Readonly<Record<AsinMetricKey, AsinMetricInfo>> = {
  sales: { label: '销售额', format: 'money', basis: '官方订购口径的销售额（下单时计），只含美元；父体 = 名下子体相加' },
  units: { label: '订购件数', format: 'number', basis: '下单的商品件数' },
  sessions: { label: '会话数', format: 'number', basis: '买家访问商品详情页的会话；父体 = 名下子体相加（官方没有逐日的父体行）' },
  pageViews: { label: '页面浏览量', format: 'number', basis: '商品详情页被浏览的次数' },
  conversion: { label: '转化率', format: 'percent', basis: '订购件数 ÷ 会话数，只用两者同一行都有值的数据相除' },
  price: { label: '价格', format: 'money', basis: '平均售价 = 销售额 ÷ 订购件数（订购口径的成交均价，不是当前标价）' },
  buyBox: { label: '购物车获得率', format: 'percent', basis: '按页面浏览量加权的平均；没有页面浏览量时为简单平均' },
  adsSales: { label: '广告销售', format: 'money', basis: '被推广商品日报表的广告销售额（只含美元；广告账户须绑定店铺）；按广告归因窗口计，不是下单日' },
  organicSales: { label: '自然销售', format: 'money', basis: '销售额 − 广告销售额；两者统计时点不同，只是估算，广告大于销售额的那天不给自然销售' },
  returnRate: { label: '退货率', format: 'percent', basis: '近 7 天滚动：退货件数（按退货日）÷ 订购件数（按下单日）；两者时点不同，只是估算' },
  daysOfSupply: { label: '可售天数', format: 'days', basis: '当天可售库存 ÷ 近 7 天日均订购件数（ASIN 日汇总口径，范围开头不足 7 天时用已有的天数）；近 7 天没有销量时不给' },
  salesRank: { label: '销售排名', format: 'rank', basis: '商品目录同步的销售排名（同一天有多个分类时取名次最靠前的）；父体没有自己的排名' },
}

/** 一组指标；null = 没有记录或来源没给（不是 0）。 */
export type AsinValues = Record<AsinMetricKey, number | null>
export interface AsinPoint extends AsinValues {
  date: string
}

export const ASIN_SELECT_KINDS = ['parent', 'asin'] as const
export type AsinSelectKind = (typeof ASIN_SELECT_KINDS)[number]
export interface AsinSelectRef {
  kind: AsinSelectKind
  asin: string
}
/** 地址栏与接口里选中对象的写法：`parent:B0XXXXXXXX` 或 `asin:B0XXXXXXXX`。 */
export const asinSelectKey = (ref: AsinSelectRef) => `${ref.kind}:${ref.asin}`

export const ASIN_RISK_FILTER_NOTE = '库存风险筛选需要库存读取权限，口径与库存健康页一致（按当前生效的补货策略计算）；没有库存记录的 ASIN 不会被任何风险等级选中'
export const ASIN_ISSUE_OPTIONS = [
  { value: 'INACTIVE', label: '刊登非在售' },
  { value: 'NOT_FOUND', label: '目录待核实' },
] as const
export type AsinIssueFilter = (typeof ASIN_ISSUE_OPTIONS)[number]['value']
export const ASIN_ISSUE_NOTE = '这里只能按商品资料里已有的刊登状态与目录核对状态筛选；刊登质量与合规问题要等“刊登质量与合规”（P4-10）上线后才有'
export const ASIN_RANK_PARENT_NOTE = '父体没有自己的销售排名'
export const ASIN_NO_ADS_NOTE = '这些店铺还没有绑定广告账户，或被推广商品日报表还没有同步，所以没有广告销售与自然销售'
export const ASIN_NO_REVIEWS_NOTE = '评价与反馈数据（客户反馈主题）还没有同步，评论主题要等“评价与反馈”（P4-13）上线后才有；这里不显示任何估算'
export const ASIN_TREE_NOTE = '左侧按商品目录里的父子关系分组（没有父体的 ASIN 单独成一项）；销售额与会话是所选日期范围内的合计，筛选后只统计符合条件的子体'

export interface AsinTreeChild {
  asin: string
  title: string | null
  productId: string | null
  sales: number | null
  sessions: number | null
}
export interface AsinTreeNode {
  /** `parent:ASIN` 或 `asin:ASIN`，同时是选中对象的写法。 */
  key: string
  kind: AsinSelectKind
  asin: string
  title: string | null
  brand: string | null
  childCount: number
  sales: number | null
  sessions: number | null
  children: AsinTreeChild[]
}

export interface AsinFilterOptions {
  brands: string[]
  categories: string[]
  tags: string[]
  owners: Array<{ id: string; name: string }>
}

/** 所选对象的一条趋势：逐日一点，没有记录的日子各项为 null（图上断开）；gaps 写明某个指标整段没有值的原因。 */
export interface AsinSelection {
  key: string
  kind: AsinSelectKind
  asin: string
  title: string | null
  productId: string | null
  memberCount: number
  points: AsinPoint[]
  totals: AsinValues
  gaps: Partial<Record<AsinMetricKey, string>>
}

export interface AsinAnalyticsResponse extends BrCommon {
  filters: AsinFilterOptions
  treeNote: string
  tree: AsinTreeNode[]
  pageInfo: CursorPageInfo
  /** 没有指定选中对象时由服务端选销售额最高的一项。 */
  selectionDefaulted: boolean
  selection: AsinSelection[]
  selectionNote: string | null
  /** 库存风险筛选在无库存权限、无策略时的说明；刊登问题筛选的口径说明。 */
  issueNote: string
}

// ---- 父体详情 ----

export const PARENT_TABS = ['matrix', 'trend', 'traffic', 'inventory', 'ads', 'reviews', 'changes'] as const
export type ParentTab = (typeof PARENT_TABS)[number]
export const PARENT_TAB_LABEL: Readonly<Record<ParentTab, string>> = {
  matrix: '子体贡献矩阵',
  trend: '子体趋势',
  traffic: '流量分布',
  inventory: '库存与补货',
  ads: '广告覆盖',
  reviews: '评论主题',
  changes: '变体结构变更历史',
}

export interface ParentFigure {
  state: DashState
  value: number | null
  note: string | null
}

export interface ParentIdentityResponse extends BrCommon {
  parentAsin: string
  /** 父体自己在商品目录里有记录时的标题与图片；没有就为 null（父体通常不是在售商品）。 */
  title: string | null
  imageUrl: string | null
  brand: string | null
  category: string | null
  variationTheme: string | null
  childCount: number
  storeNames: string[]
  sales: number | null
  conversion: number | null
  netProfit: ParentFigure
  riskChildren: ParentFigure
  /** 名下子体里在售商品被截断（超过 ASIN_MEMBER_LIMIT）。 */
  membersTruncated: boolean
}

export const MATRIX_METRICS = ['sales', 'conversion', 'risk'] as const
export type MatrixMetric = (typeof MATRIX_METRICS)[number]
export const MATRIX_METRIC_LABEL: Readonly<Record<MatrixMetric, string>> = { sales: '销售额', conversion: '转化率', risk: '库存风险' }
export const MATRIX_RISK_RANK: Readonly<Record<InventoryRiskLevel, number>> = { HIGH: 3, MEDIUM: 2, EXCESS: 1, NORMAL: 0 }

export interface MatrixRow {
  asin: string
  title: string | null
  productId: string | null
  attributes: Record<string, string>
  sales: number | null
  units: number | null
  sessions: number | null
  conversion: number | null
  /** 销售额占整个父体的比例；父体销售额为空或 0 时为 null。 */
  share: number | null
  risk: InventoryRiskLevel | null
}
export interface MatrixCell {
  row: string
  col: string
  asins: string[]
  sales: number | null
  units: number | null
  sessions: number | null
  conversion: number | null
  risk: InventoryRiskLevel | null
}
export interface MatrixPivot {
  state: DashState
  note: string | null
  dimensions: string[]
  rowDim: string | null
  colDim: string | null
  rowValues: string[]
  colValues: string[]
  cells: MatrixCell[]
}
export interface ParentMatrixResponse extends BrCommon {
  parentAsin: string
  metric: MatrixMetric
  rows: MatrixRow[]
  /** 所选指标的最小与最大值（热力图配色用）；风险没有数值刻度为 null。 */
  scale: { min: number; max: number } | null
  riskState: { state: DashState; note: string | null }
  pivot: MatrixPivot
}

export interface ParentTrendSeries {
  asin: string
  title: string | null
  /** 逐日，与响应里的 dates 一一对应；没有记录的日子为 null。 */
  sales: Array<number | null>
  sessions: Array<number | null>
  units: Array<number | null>
}
export interface ParentTrendResponse extends BrCommon {
  parentAsin: string
  dates: string[]
  series: ParentTrendSeries[]
  /** 超过 ASIN_TREND_TOP 的子体合并成的一条；没有就为 null。 */
  others: { count: number; sales: Array<number | null>; sessions: Array<number | null>; units: Array<number | null> } | null
}

export interface TrafficRow {
  asin: string
  title: string | null
  sessions: number | null
  share: number | null
  compareSessions: number | null
  compareShare: number | null
  /** 占比变化（百分点，0.012 = +1.2 个百分点）；任一期缺失为 null。 */
  shareChange: number | null
}
export interface ParentTrafficResponse extends BrCommon {
  parentAsin: string
  compareRange: { from: string; to: string } | null
  totalSessions: number | null
  compareTotalSessions: number | null
  rows: TrafficRow[]
}

export interface ParentInventoryRow {
  asin: string
  title: string | null
  productId: string | null
  skuCount: number
  sellable: number | null
  inboundCounted: number | null
  daysOfCover: number | null
  stockoutDate: string | null
  risk: InventoryRiskLevel | null
  recommendedQty: number | null
  recommendedDue: string | null
  recommendedChannel: string | null
}
export interface ParentInventoryResponse extends BrCommon {
  parentAsin: string
  policyState: DashState
  policyNote: string | null
  replenishmentState: DashState
  replenishmentNote: string | null
  rows: ParentInventoryRow[]
  truncated: boolean
}

export const COVERAGE_STATES = ['COVERED', 'NO_SPEND', 'NO_ADS'] as const
export type CoverageState = (typeof COVERAGE_STATES)[number]
export const COVERAGE_LABEL: Readonly<Record<CoverageState, string>> = { COVERED: '已覆盖', NO_SPEND: '有广告但范围内无花费', NO_ADS: '无广告（覆盖缺口）' }
export interface ParentAdsRow {
  asin: string
  title: string | null
  coverage: CoverageState
  spend: number | null
  adsSales: number | null
  orders: number | null
  acos: number | null
  totalSales: number | null
  adsShare: number | null
  enabledAds: number | null
  totalAds: number | null
  /** 有销售但没有广告覆盖：值得补投的缺口。 */
  gap: boolean
}
export interface ParentAdsResponse extends BrCommon {
  parentAsin: string
  adsState: DashState
  adsNote: string | null
  coveredCount: number
  gapCount: number
  totalSpend: number | null
  totalAdsSales: number | null
  rows: ParentAdsRow[]
}

export interface ParentReviewsResponse extends BrCommon {
  parentAsin: string
  reviewsState: DashState
  reviewsNote: string
  positive: string[]
  negative: string[]
}

export const PARENT_CHANGE_KIND_LABEL: Readonly<Record<string, string>> = {
  'variation.child_added': '新增子体',
  'variation.child_removed': '移除子体',
  'variation.attribute_change': '变体属性变化',
  'listing.change': '子体换父体',
}
export interface ParentChange {
  id: string
  occurredAt: string
  kind: string
  kindLabel: string
  title: string
  childAsin: string | null
  before: string | null
  after: string | null
  actor: string
}
export interface ParentChangesResponse {
  parentAsin: string
  items: ParentChange[]
  pageInfo: CursorPageInfo
  truncated: boolean
  note: string | null
}
