import type { BrCommon } from './business-reports.js'

// 商品表现宽表（P6-22，16 章第 2.1 节，freeze/api.md `/analytics/product-performance/*`）：零 zod（前端引用）；请求校验在 product-performance-query.ts。
// 同一套指标按所选维度重新聚合；每个指标有本期、上期、涨跌三个值；利润、成本、广告、库存列按权限降级，没有权限的列在响应里不返回（键根本不存在）。

export const PP_DIMENSIONS = ['asin', 'parentAsin', 'sku', 'store', 'owner', 'brand', 'category'] as const
export type PpDimension = (typeof PP_DIMENSIONS)[number]
export const PP_DIMENSION_LABEL: Record<PpDimension, string> = {
  asin: 'ASIN',
  parentAsin: '父 ASIN',
  sku: 'SKU',
  store: '店铺',
  owner: '负责人',
  brand: '品牌',
  category: '品类',
}

export const PP_GROUPS = ['sales', 'traffic', 'ads', 'profit', 'inventory', 'aftersales'] as const
export type PpGroup = (typeof PP_GROUPS)[number]
export const PP_GROUP_LABEL: Record<PpGroup, string> = { sales: '销售', traffic: '流量', ads: '广告', profit: '利润', inventory: '库存', aftersales: '售后' }

/** 看这一列需要的权限：profit = 利润读取 + 利润字段；cost = 在利润之上再要成本字段；ads、inventory = 对应读取权限。 */
export type PpRequirement = 'profit' | 'cost' | 'ads' | 'inventory' | null
export type PpFormat = 'money' | 'number' | 'percent' | 'decimal'

export interface PpMetricInfo {
  label: string
  group: PpGroup
  format: PpFormat
  goodWhen?: 'up' | 'down'
  require: PpRequirement
  /** 指标字典编号：列头问号从字典取口径。 */
  metric?: string
  /** 慢指标：主数据返回后按可见行批量取（async-columns），不在 query 的行里。 */
  slow?: true
  /** 没有来源、永远没有值的指标：写原因，不估算也不显示成 0。 */
  gap?: string
}

const NO_AD_DETAIL = '广告商品级的点击与订单还没有接入汇总，暂不计算'

export const PP_METRICS = {
  units: { label: '销量', group: 'sales', format: 'number', require: null, metric: 'M-003' },
  orders: { label: '订单量', group: 'sales', format: 'number', require: null, metric: 'M-004' },
  sales: { label: '销售额', group: 'sales', format: 'money', require: null, metric: 'M-001' },
  netSales: { label: '净销售额', group: 'sales', format: 'money', require: 'profit' },
  avgPrice: { label: '均价', group: 'sales', format: 'money', require: null },
  b2bSales: { label: 'B2B 销售额', group: 'sales', format: 'money', require: null },
  sessions: { label: 'Sessions', group: 'traffic', format: 'number', require: null, metric: 'M-120' },
  pageViews: { label: 'PV', group: 'traffic', format: 'number', require: null, metric: 'M-121' },
  conversion: { label: '转化率', group: 'traffic', format: 'percent', require: null, metric: 'M-122' },
  buyBox: { label: '购物车赢得率', group: 'traffic', format: 'percent', require: null, metric: 'M-124' },
  adSpend: { label: '广告花费', group: 'ads', format: 'money', goodWhen: 'down', require: 'ads', metric: 'M-007' },
  adSales: { label: '广告销售额', group: 'ads', format: 'money', require: 'ads', metric: 'M-500' },
  acos: { label: 'ACOS', group: 'ads', format: 'percent', goodWhen: 'down', require: 'ads', metric: 'M-501' },
  tacos: { label: 'TACOS', group: 'ads', format: 'percent', goodWhen: 'down', require: 'ads' },
  acoas: { label: 'ACoAS', group: 'ads', format: 'percent', goodWhen: 'down', require: 'ads', gap: NO_AD_DETAIL },
  asoas: { label: 'ASoAS', group: 'ads', format: 'percent', require: 'ads', gap: NO_AD_DETAIL },
  cpc: { label: 'CPC', group: 'ads', format: 'money', goodWhen: 'down', require: 'ads', gap: NO_AD_DETAIL },
  adOrderShare: { label: '广告订单占比', group: 'ads', format: 'percent', require: 'ads', gap: NO_AD_DETAIL },
  grossProfit: { label: '毛利', group: 'profit', format: 'money', require: 'profit', metric: 'M-402' },
  margin: { label: '毛利率', group: 'profit', format: 'percent', require: 'profit' },
  roi: { label: 'ROI', group: 'profit', format: 'percent', require: 'cost' },
  fbaAvailable: { label: 'FBA 可售', group: 'inventory', format: 'number', require: 'inventory', slow: true, metric: 'M-200' },
  inbound: { label: '在途', group: 'inventory', format: 'number', require: 'inventory', slow: true, metric: 'M-201' },
  daysOfSupply: { label: '可售天数', group: 'inventory', format: 'decimal', require: 'inventory', slow: true, metric: 'M-206' },
  returnRate: { label: '退货率', group: 'aftersales', format: 'percent', goodWhen: 'down', require: null, slow: true, metric: 'M-310' },
  refundRate: { label: '退款率', group: 'aftersales', format: 'percent', goodWhen: 'down', require: 'profit', slow: true, metric: 'M-126' },
  rating: { label: '评分', group: 'aftersales', format: 'decimal', require: null, slow: true, metric: 'M-305' },
} as const satisfies Record<string, PpMetricInfo>

export type PpMetricKey = keyof typeof PP_METRICS
export const PP_METRIC_KEYS = Object.keys(PP_METRICS) as PpMetricKey[]
const infoOf = (key: PpMetricKey): PpMetricInfo => PP_METRICS[key]
export const PP_FAST_KEYS = PP_METRIC_KEYS.filter(key => !infoOf(key).slow)
export const PP_SLOW_KEYS = PP_METRIC_KEYS.filter(key => infoOf(key).slow)
/** 可以排序的列（服务端白名单）：query 里返回的非慢列；排序键 `title` 按名称。 */
export const PP_SORT_FIELDS: readonly string[] = ['title', ...PP_FAST_KEYS.filter(key => !infoOf(key).gap)]
export const PP_DEFAULT_SORT = { field: 'sales', direction: 'desc' } as const

/** 迷你趋势可选的指标（逐日）。 */
export const PP_TREND_METRICS = ['sales', 'units', 'sessions', 'adSpend'] as const
export type PpTrendMetric = (typeof PP_TREND_METRICS)[number]

export const PP_PAGE_SIZE_MAX = 200
/** 一次请求最多取多少个行编号（慢列、迷你趋势）。 */
export const PP_IDS_MAX = 100
/** 一个维度下参与聚合的 店铺 × ASIN 单元上限（Prisma 单次读取上限 20000，多读一个判断是否被截断）。 */
export const PP_UNIT_LIMIT = 19_999
export const PP_PERMISSION = 'analytics.read'
export const PP_ID_SEP = ':'

/** 一个指标的本期、上期与涨跌（涨跌是比例；上期为 0 或没有时为 null）。 */
export interface PpCell {
  value: number | null
  previous: number | null
  change: number | null
}

export interface PpRow {
  /** `维度:键`，例如 `asin:B0ABC12345`；店铺维度的键是店铺编号。 */
  id: string
  dimension: PpDimension
  title: string | null
  subtitle: string | null
  imageUrl: string | null
  asin: string | null
  sku: string | null
  storeName: string | null
  /** 父 ASIN 行下面有子体可以展开。 */
  hasChildren: boolean
  childCount: number | null
  /** 只含有权限看的快指标；没有来源的指标值为 null，原因在 gaps。 */
  metrics: Partial<Record<PpMetricKey, PpCell>>
  gaps: Partial<Record<PpMetricKey, string>>
}

/** 响应里没有给出的列组及原因（没有权限的列整组不返回）。 */
export interface PpRestriction {
  group: PpGroup
  metrics: PpMetricKey[]
  reason: string
}

export interface PpRange {
  from: string
  to: string
  days: number
}

export interface PpMeta {
  dimension: PpDimension
  /** 当前账号能看到的指标（快指标与慢指标）。 */
  allowed: PpMetricKey[]
  restrictions: PpRestriction[]
  /** 整个指标永远没有值的原因（没有来源，不估算）。 */
  gaps: Partial<Record<PpMetricKey, string>>
  /** 对比期；没有选对比期为 null，此时上期与涨跌都是 null。 */
  compare: (PpRange & { mode: string }) | null
  /** 商品或利润数据超过读取上限，只统计了前面的部分。 */
  truncated: boolean
}

export type PpQueryResponse = BrCommon &
  PpMeta & {
    items: PpRow[]
    total: number
    page: number
    pageSize: number
  }

export interface PpSummaryResponse extends PpMeta {
  /** 汇总行：对符合筛选的全部行合计（金额是各行之和，比率按合计重算），不是当前页之和。 */
  totals: Partial<Record<PpMetricKey, number | null>>
  rowCount: number
  currency: 'USD'
}

export interface PpAsyncResponse {
  /** `rows[行编号][指标键]`；没有记录的行或指标不给键。 */
  rows: Record<string, Partial<Record<PpMetricKey, number | null>>>
  /** 没有来源时的原因（例如从没同步过退货记录）。 */
  gaps: Partial<Record<PpMetricKey, string>>
  truncated: boolean
}

export interface PpTrendResponse {
  metric: PpTrendMetric
  days: string[]
  /** `rows[行编号].trend`：与 days 一一对应，当天没有记录为 null。 */
  rows: Record<string, { trend: Array<number | null> }>
  truncated: boolean
}
