import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// 刊登表现（P4-09，05 章 5.3；freeze/api.md `GET /listings/performance`）：一行 = 一个店铺 × SKU（FbaProduct）。
// 本文件只放常量、标签、响应类型（没有 zod，前端会引用）；请求校验在 listing-performance-query.ts，纯函数在 listing-performance-math.ts。
// 销售与流量只读 P4-01 同步的 `SalesTrafficAsinDaily`（子体粒度，数据中心优先于报告）与订单口径的 ASIN 日汇总，只统计美元；
// 官方没给的值是 null（页面写“尚无记录”），没有权限写“无权限”，来源还没建好写“尚未接入”，永远不拿 0 代替。

export const LISTING_PERF_READ = 'listing.read'
/** 保存视图用的页面标识（走已有的 /views 接口）。 */
export const LISTING_PERF_VIEW_PAGE_KEY = 'listing-performance'
/** 读取上限：Prisma 单次最多 20000 行，多读一行判断是否被截断。 */
export const LISTING_PERF_LIMIT = 19_999
/** 对比模式一次选几个对象（与海量表格的约定一致）。 */
export const LISTING_COMPARE_MIN = 2
export const LISTING_COMPARE_MAX = 5
/** 可售天数用的“近 N 天日均订购件数”。 */
export const LISTING_DEMAND_DAYS = 7

/** 转化率骤降的判定：本期与上一周期的会话都不少于这个数，且转化率较上一周期下降不少于下面的比例（相对值）。 */
export const LISTING_MIN_SESSIONS = 100
export const LISTING_CONVERSION_DROP_RATIO = 0.3

export const LISTING_PERF_SORTS = ['sales', 'units', 'sessions', 'pageViews', 'conversion', 'buyBox', 'price', 'adsSales', 'returnRate', 'daysOfSupply', 'asin', 'sku'] as const
export type ListingPerfSort = (typeof LISTING_PERF_SORTS)[number]
export const LISTING_PERF_SORT_LABEL: Readonly<Record<ListingPerfSort, string>> = {
  sales: '销售额',
  units: '销量',
  sessions: '会话',
  pageViews: '浏览量',
  conversion: '转化率',
  buyBox: '购物车获得率',
  price: '价格',
  adsSales: '广告销售',
  returnRate: '退货率',
  daysOfSupply: '可售天数',
  asin: 'ASIN',
  sku: '卖家 SKU',
}

export const LISTING_TREND_METRICS = ['sessions', 'pageViews', 'units', 'sales', 'conversion', 'buyBox'] as const
export type ListingTrendMetric = (typeof LISTING_TREND_METRICS)[number]
export const LISTING_TREND_LABEL: Readonly<Record<ListingTrendMetric, string>> = {
  sessions: '会话',
  pageViews: '浏览量',
  units: '销量',
  sales: '销售额',
  conversion: '转化率',
  buyBox: '购物车获得率',
}

/** 数据状态：有、没记录、没权限、来源还没接入。 */
export type ListingDataState = 'OK' | 'NO_DATA' | 'RESTRICTED' | 'NOT_CONNECTED'
export interface ListingGate {
  state: ListingDataState
  note: string | null
}

// ---- 异常分布 ----

export const LISTING_ANOMALY_KINDS = ['CONVERSION_DROP', 'OFFER_LOST', 'ISSUE_NEW', 'SUPPRESSED'] as const
export type ListingAnomalyKind = (typeof LISTING_ANOMALY_KINDS)[number]
/** 现在算得出来的异常（可以作为筛选条件）。 */
export const LISTING_LIVE_ANOMALIES = ['CONVERSION_DROP'] as const
export type ListingLiveAnomaly = (typeof LISTING_LIVE_ANOMALIES)[number]

export interface ListingAnomalyInfo {
  label: string
  /** 数据来源还没有交付时由哪个工作包负责；已经算得出来的为 null。 */
  pendingWorkPackage: string | null
  basis: string
}
export const LISTING_ANOMALY_INFO: Readonly<Record<ListingAnomalyKind, ListingAnomalyInfo>> = {
  CONVERSION_DROP: {
    label: '转化率骤降',
    pendingWorkPackage: null,
    basis: `所选范围与上一周期（同长度、紧邻的前一段）的会话都不少于 ${LISTING_MIN_SESSIONS}，且转化率（件数 ÷ 会话）较上一周期下降不少于 ${Math.round(LISTING_CONVERSION_DROP_RATIO * 100)}%（相对值）`,
  },
  OFFER_LOST: { label: '推荐报价丢失', pendingWorkPackage: 'P4-11', basis: '需要定价同步器写入推荐报价（购物车）状态与“失去推荐报价”事件，定价与购物车上线后接入' },
  ISSUE_NEW: { label: '刊登问题新增', pendingWorkPackage: 'P4-10', basis: '需要刊登问题同步器写入问题清单，刊登质量与合规上线后接入' },
  SUPPRESSED: { label: '被搜索抑制', pendingWorkPackage: 'P4-10', basis: '需要“被搜索抑制的商品”报告同步器，刊登质量与合规上线后接入' },
}

export interface ListingAnomalySummary {
  kind: ListingAnomalyKind
  label: string
  /** OK = 算得出来；NOT_CONNECTED = 来源还没交付（count 为 null，不是 0）；NO_DATA = 算得出来但缺少可比数据。 */
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  count: number | null
  note: string
}

// ---- 表格里没有数据来源的列 ----

export interface ListingPendingColumn {
  key: 'rating' | 'ratingCount' | 'issueCount' | 'qualityScore'
  label: string
  workPackage: string
  note: string
}
export const LISTING_PENDING_COLUMNS: readonly ListingPendingColumn[] = [
  { key: 'rating', label: '评分', workPackage: 'P4-13', note: '评分与评分数要标注来源（客户反馈接口或人工导入），评价与反馈上线后接入；这里不显示任何估算' },
  { key: 'ratingCount', label: '评分数', workPackage: 'P4-13', note: '同评分：来源标注随评价与反馈一起交付' },
  { key: 'issueCount', label: '刊登问题数', workPackage: 'P4-10', note: '需要刊登问题同步器，刊登质量与合规上线后接入' },
  { key: 'qualityScore', label: '刊登质量分', workPackage: 'P4-10', note: '质量分是本系统按属性完整度等规则计算并标注版本的，刊登质量与合规上线后接入' },
]

// ---- 行与响应 ----

export interface ListingPerfRow {
  id: string
  sellerAccountId: string
  storeName: string
  asin: string
  sku: string
  title: string
  imageUrl: string | null
  brand: string | null
  listingStatus: string
  fulfillmentChannel: string
  /** 当前标价（商品目录最近一次同步值）。 */
  price: number | null
  currency: string
  /** 所选范围的合计（官方订购口径、美元、店铺 × ASIN）；没有记录为 null。 */
  sessions: number | null
  pageViews: number | null
  units: number | null
  sales: number | null
  /** 件数 ÷ 会话（0 到 1 的小数）。 */
  conversion: number | null
  /** 购物车获得率：日值的简单平均（0 到 1 的小数）。 */
  buyBox: number | null
  /** 上一周期的会话与转化率（异常判断与对比用）。 */
  sessionsPrev: number | null
  conversionPrev: number | null
  /** 广告销售额（被推广商品日报表口径，已绑定店铺）；没有 ads.read 或没有数据为 null，原因见响应的 gates.ads。 */
  adsSales: number | null
  /** 退货率：范围内退货件数 ÷ 订购件数（估算）；没有 returns.read 或没有退货记录为 null。 */
  returnRate: number | null
  /** 可售天数：可售数量 ÷ 范围最后 7 天日均订购件数；没有 inventory.read、没有库存记录或近 7 天没销量为 null。 */
  daysOfSupply: number | null
  /** 同店同 ASIN 在清单里不止一个 SKU：上面的流量与销售数字是共用的。 */
  salesShared: boolean
  anomalies: ListingAnomalyKind[]
  ownerUserId: string | null
  ownerName: string | null
  updatedAt: string
}

export interface ListingTrendPoint {
  date: string
  sessions: number | null
  pageViews: number | null
  units: number | null
  sales: number | null
  conversion: number | null
  buyBox: number | null
}

export interface ListingFilterOptions {
  brands: string[]
  categories: string[]
  statuses: string[]
  owners: Array<{ id: string; name: string }>
}

export interface ListingPerfRange {
  from: string
  to: string
  days: number
}

export interface ListingPerfResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: ListingPerfRow[]
  pageInfo: CursorPageInfo
  range: ListingPerfRange & { defaulted: boolean }
  previousRange: ListingPerfRange
  currency: 'USD'
  trend: { state: 'OK' | 'NO_DATA'; note: string | null; points: ListingTrendPoint[] }
  anomalies: ListingAnomalySummary[]
  gates: { traffic: ListingGate; ads: ListingGate; returns: ListingGate; stock: ListingGate }
  pending: readonly ListingPendingColumn[]
  filterOptions: ListingFilterOptions
  /** 商品数超过读取上限，只处理了前一部分。 */
  truncated: boolean
  freshness: InventoryFreshness
  basis: string
}

export const LISTING_PERF_BASIS =
  '一行是一个店铺 × SKU。会话、浏览量、销量、销售额取官方订购口径（数据中心为主、报告补充为辅，只统计美元），按“店铺 × ASIN”汇总：同店同 ASIN 的多个 SKU 看到的是同一份数字（行上标“同 ASIN 共用”）；' +
  '转化率 = 件数 ÷ 会话，购物车获得率是日值的简单平均；价格是商品目录最近一次同步的标价；广告销售按广告归因窗口计、不是下单日；退货率与可售天数是估算（口径见列头说明）。' +
  '日期是亚马逊美国站（太平洋时区）的日历日。没有记录的值显示“尚无记录”，不当 0。'

export const LISTING_METRIC_NOTES: Readonly<Record<string, string>> = {
  conversion: '件数 ÷ 会话（同一范围合计相除）',
  buyBox: '日值的简单平均',
  price: '商品目录最近一次同步的标价，不是成交均价',
  adsSales: '被推广商品日报表的广告销售额（已绑定店铺、只含美元），按广告归因窗口计，不是下单日',
  returnRate: '范围内退货件数（按退货日）÷ 订购件数（按下单日），两者时点不同，只是估算',
  daysOfSupply: `库存接口最近一次同步的可售数量 ÷ 范围最后 ${LISTING_DEMAND_DAYS} 天的日均订购件数；这段时间没有销量时不给`,
}
