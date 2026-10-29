import type { AttributionFactor, DashCompare } from './dashboard.js'
import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'
import { SALES_TRAFFIC_ASIN_FRESHNESS_KEY, SALES_TRAFFIC_DATE_FRESHNESS_KEY, SALES_TRAFFIC_REPORT_FRESHNESS_KEY, SALES_TRAFFIC_TRENDS_FRESHNESS_KEY } from './sales-traffic.js'

// 业务报告（P4-02，04 章 4.5，freeze/api.md GET /analytics/sales-traffic/*）：店铺销量与流量的正式入口。
// 只放常量、标签与响应类型（没有 zod，请求校验在 business-reports-query.ts）。数据来自 P4-01 同步的 SalesTrafficDaily、SalesTrafficAsinDaily：
// 数据中心为主、报告补充为辅（同一天同一店铺两边都有时用数据中心），只统计美元。
// 口径约定：
//   - 官方没给的值是 null（页面写“尚无记录”），不是 0；合计时只加有值的行，整段都没有值才是 null；
//   - 转化率 = 订购件数 ÷ 会话，平均售价 = 订购销售额 ÷ 订购件数，退款率 = 退款件数 ÷ 订购件数（官方按发货件数，这里没有发货件数，所以与卖家后台略有差异）；
//     这几个比率都只用“分子分母同一行都有值”的行相除，范围合计不取日比率的平均；
//   - 购物车获得率按页面浏览量加权平均（没有页面浏览量就用简单平均）；按 ASIN 的明细表没有逐日权重，用日值的简单平均。

export const BUSINESS_REPORTS_READ = 'analytics.read'

export const BR_TABS = ['dashboard', 'date', 'sales-traffic', 'detail', 'parent', 'monthly'] as const
export type BrTab = (typeof BR_TABS)[number]
export const BR_TAB_LABEL: Readonly<Record<BrTab, string>> = {
  dashboard: '销售仪表盘',
  date: '按日期',
  'sales-traffic': '销售与流量',
  detail: '详情页销售与流量',
  parent: '父体详情页销售与流量',
  monthly: '月度销售与订单',
}

export const BR_GRANULARITIES = ['DAY', 'WEEK', 'MONTH'] as const
export type BrGranularity = (typeof BR_GRANULARITIES)[number]
export const BR_GRANULARITY_LABEL: Readonly<Record<BrGranularity, string>> = { DAY: '按日', WEEK: '按周', MONTH: '按月' }
/** ASIN 明细的层级：父体、子体（ASIN）、SKU。 */
export const BR_LEVELS = ['PARENT', 'CHILD', 'SKU'] as const
export type BrLevel = (typeof BR_LEVELS)[number]
export const BR_LEVEL_LABEL: Readonly<Record<BrLevel, string>> = { PARENT: '父体', CHILD: '子体（ASIN）', SKU: 'SKU' }

/** 没选日期范围时的默认回看：日 30 天（与对比上一期）、周 12 周、月 12 个月。 */
export const BR_DEFAULT_DAYS = 30
export const BR_DEFAULT_WEEKS = 12
export const BR_DEFAULT_MONTHS = 12
/** 一次最多读多少行日数据 / 多少个 ASIN 分组（Prisma 单次读取上限 20000，多读 1 行判断被截断，所以是 19,999）。 */
export const BR_ROW_LIMIT = 19_999
export const BR_ASIN_GROUP_LIMIT = 19_999

/** 页面与响应用到的新鲜度来源键（数据中心三个数据集加补充报告）。 */
export const BR_FRESHNESS_KEYS = [SALES_TRAFFIC_DATE_FRESHNESS_KEY, SALES_TRAFFIC_ASIN_FRESHNESS_KEY, SALES_TRAFFIC_TRENDS_FRESHNESS_KEY, SALES_TRAFFIC_REPORT_FRESHNESS_KEY] as const

export const BR_METRIC_KEYS = ['orderedSales', 'unitsOrdered', 'ordersCount', 'sessions', 'pageViews', 'unitSessionPct', 'avgPrice', 'buyBoxPct', 'unitsRefunded', 'refundRate'] as const
export type BrMetricKey = (typeof BR_METRIC_KEYS)[number]

export interface BrMetricInfo {
  label: string
  format: 'money' | 'number' | 'percent'
  goodWhen: 'up' | 'down'
  /** 图表与指标卡上显示的口径说明。 */
  basis: string
}
export const BR_METRIC_INFO: Readonly<Record<BrMetricKey, BrMetricInfo>> = {
  orderedSales: { label: '订购商品销售额', format: 'money', goodWhen: 'up', basis: '官方订购口径的销售额（下单时计，含之后取消的订单），不是已发货或已结算收入' },
  unitsOrdered: { label: '订购件数', format: 'number', goodWhen: 'up', basis: '下单的商品件数' },
  ordersCount: { label: '订单商品数', format: 'number', goodWhen: 'up', basis: '官方 totalOrderItems：订单里的商品行数，不是订单数' },
  sessions: { label: '会话数', format: 'number', goodWhen: 'up', basis: '买家访问商品详情页的会话；浏览器与移动应用的拆分尚未接入，只有合计' },
  pageViews: { label: '页面浏览量', format: 'number', goodWhen: 'up', basis: '商品详情页被浏览的次数；浏览器与移动应用的拆分尚未接入，只有合计' },
  unitSessionPct: { label: '单位会话转化率', format: 'percent', goodWhen: 'up', basis: '订购件数 ÷ 会话数，只用两者同一行都有值的数据相除' },
  avgPrice: { label: '平均售价', format: 'money', goodWhen: 'up', basis: '订购商品销售额 ÷ 订购件数，只用两者同一行都有值的数据相除' },
  buyBoxPct: { label: '购物车获得率', format: 'percent', goodWhen: 'up', basis: '页面浏览量加权的平均；ASIN 明细表按日值简单平均' },
  unitsRefunded: { label: '退款件数', format: 'number', goodWhen: 'down', basis: '官方只在店铺日粒度提供；ASIN 明细没有' },
  refundRate: { label: '退款率', format: 'percent', goodWhen: 'down', basis: '退款件数 ÷ 订购件数（官方按发货件数计，这里没有发货件数，数值会略有不同）' },
}

/** 浏览器与移动应用的拆分：数据中心结果里有，但同步（P4-01）只存了合计，没有保存拆分列。 */
export const BR_DEVICE_SPLIT_NOTE = '尚未接入：数据中心的销售与流量按浏览器与移动应用拆分，但同步器目前只保存合计，没有保存拆分列，所以暂时无法对比移动端与桌面端'
/** 品牌分析角色缺失时的前提说明。 */
export const BR_NO_BRAND_NOTE = '数据中心的销售与流量需要卖家有品牌备案并获批“品牌分析”角色；没有这个角色的店铺这里没有数据，报告补充来源也只对已有数据中心数据的店铺申请'
export const BR_NO_DATA_NOTE = '所选范围内尚无销售与流量数据：店铺授权并具备品牌分析角色后，同步任务每天拉取，数据会自动出现；本页不会用订单估算来冒充官方数据'

export type BrState = 'OK' | 'NO_DATA'

/** 一组指标；null = 官方没给（不是 0）。 */
export interface BrFigures {
  orderedSales: number | null
  unitsOrdered: number | null
  ordersCount: number | null
  sessions: number | null
  pageViews: number | null
  unitSessionPct: number | null
  avgPrice: number | null
  buyBoxPct: number | null
  unitsRefunded: number | null
  refundRate: number | null
}

/** 时间序列上的一个点：日粒度是当天，周与月粒度是该周（周日起）或该月第一天。 */
export interface BrPoint extends BrFigures {
  date: string
  /** 这一点用了哪个来源：数据中心优先；null 表示这一天没有任何记录。 */
  source: 'DATA_KIOSK' | 'REPORT' | 'MIXED' | null
}

export interface BrRange {
  from: string
  to: string
  days: number
  defaulted: boolean
}

export const BR_STORE_STATES = ['AVAILABLE', 'NO_BRAND', 'FAILED', 'NO_RECORD'] as const
export type BrStoreState = (typeof BR_STORE_STATES)[number]
export const BR_STORE_STATE_LABEL: Readonly<Record<BrStoreState, string>> = { AVAILABLE: '已同步', NO_BRAND: '未授权', FAILED: '同步失败', NO_RECORD: '尚无记录' }
export interface BrStoreStatus {
  sellerAccountId: string
  storeName: string
  state: BrStoreState
  stateLabel: string
  note: string
  lastSuccessAt: string | null
}

export interface BrCard {
  key: BrMetricKey
  label: string
  format: BrMetricInfo['format']
  goodWhen: 'up' | 'down'
  value: number | null
  compareValue: number | null
  /** 金额与数量用比率（0.12 表示 +12%），百分比类指标用百分点差（0.012 表示 +1.2 个百分点）；没有可比数据为 null。 */
  change: number | null
  changeKind: 'ratio' | 'points'
  basis: string
}

export interface BrFunnelStep {
  key: 'sessions' | 'pageViews' | 'ordersCount' | 'unitsOrdered'
  label: string
  value: number | null
  /** 相对上一步的比值；没有上一步或任一方缺失为 null。 */
  rate: number | null
  /** per：每个上一步对应多少（如每会话页面浏览量）；percent：占上一步的比例。 */
  rateKind: 'per' | 'percent'
  rateLabel: string
}

/** 自然销售与广告销售的拆分：广告销售额来自店铺日汇总（广告报告同步后派生）。 */
export interface BrAdsSplit {
  state: 'OK' | 'NO_DATA' | 'MISMATCH'
  note: string | null
  adsSales: number | null
  organicSales: number | null
  adsShare: number | null
}

export interface BrAttribution {
  mode: 'THREE_FACTOR'
  factors: AttributionFactor[]
  sales: { before: number; after: number }
}

export interface BrCommon {
  state: BrState
  note: string | null
  range: BrRange
  currency: 'USD'
  stores: BrStoreStatus[]
  /** 范围内最新一天有数据的日期；没有为 null。 */
  latestDate: string | null
  /** 读取行数达到上限被截断：合计只含已读到的部分。 */
  truncated: boolean
  basis: string
  freshness: InventoryFreshness
}

export interface BrSummaryResponse extends BrCommon {
  compare: DashCompare | null
  /** 范围内有多少天、其中几天有数据、几天只有报告补充（没有数据中心）。 */
  coverage: { days: number; withData: number; reportOnly: number }
  cards: BrCard[]
  deviceSplit: { state: 'NOT_CONNECTED'; note: string }
  trend: BrPoint[]
  /** 对比期逐日，按位置对齐到本期的第 i 天；没有对比期为 null。 */
  compareTrend: BrPoint[] | null
  funnel: BrFunnelStep[]
  attribution: BrAttribution | null
  attributionNote: string | null
  split: BrAdsSplit
}

export interface BrDateResponse extends BrCommon {
  granularity: BrGranularity
  /** 只有日粒度支持对比期（周、月的桶对不齐）。 */
  compare: DashCompare | null
  compareNote: string | null
  points: BrPoint[]
  comparePoints: BrPoint[] | null
  totals: BrFigures
}

export const BR_ASIN_SORTS = ['orderedSales', 'unitsOrdered', 'sessions', 'pageViews', 'unitSessionPct', 'avgPrice', 'buyBoxPct'] as const
export type BrAsinSort = (typeof BR_ASIN_SORTS)[number]
export const BR_ASIN_SORT_LABEL: Readonly<Record<BrAsinSort, string>> = {
  orderedSales: '订购商品销售额',
  unitsOrdered: '订购件数',
  sessions: '会话数',
  pageViews: '页面浏览量',
  unitSessionPct: '单位会话转化率',
  avgPrice: '平均售价',
  buyBoxPct: '购物车获得率',
}

export type BrAsinFigures = Pick<BrFigures, 'orderedSales' | 'unitsOrdered' | 'ordersCount' | 'sessions' | 'pageViews' | 'unitSessionPct' | 'avgPrice' | 'buyBoxPct'>
export interface BrAsinRow extends BrAsinFigures {
  key: string
  asin: string
  /** SKU 层级才有；其余层级为 null。 */
  sku: string | null
  /** 子体与 SKU 层级的父体编号（来自商品目录，目录没同步到就是 null）。 */
  parentAsin: string | null
  title: string | null
  storeName: string | null
  /** 商品目录里的编号，用来跳到 ASIN 360；父体行或目录里没有时为 null。 */
  productId: string | null
}

export interface BrAsinResponse extends BrCommon {
  level: BrLevel
  items: BrAsinRow[]
  pageInfo: CursorPageInfo
}

export interface BrTrendsResponse extends BrCommon {
  asin: string
  title: string | null
  productId: string | null
  points: BrPoint[]
  totals: BrFigures
}
