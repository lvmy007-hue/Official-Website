import type { DashGranularity, DashPeriod, DashState } from './dashboard'
import type { CursorPageInfo } from './query'

// 广告指标（自由分析）契约（P3-15，08 章 8.13）：只有常量与类型，没有 zod（请求校验在 ads-metrics-query.ts，纯函数在 ads-metrics-math.ts）。
// “自由组合维度与指标”只在本系统已经入库的数据集里做：每个数据集对应一张指标表，能用的维度与指标由该表的列决定（不跨数据集拼接）。
// 数据集里没有行就是“尚无记录”（没有报告任务写入过）；指标表里来源没给的金额是空，不当 0；不同币种不相加，只看美元行。

export const ADS_METRICS_DATASET_KEYS = ['CAMPAIGN', 'AD_GROUP', 'TARGET', 'SEARCH_TERM', 'ADVERTISED_PRODUCT', 'PLACEMENT', 'CONVERTED_PRODUCT', 'HOURLY'] as const
export type AdsMetricsDatasetKey = (typeof ADS_METRICS_DATASET_KEYS)[number]

export const ADS_METRICS_DIMENSION_KEYS = ['date', 'hour', 'adProduct', 'campaign', 'adGroup', 'target', 'matchType', 'searchTerm', 'placement', 'advertisedAsin', 'purchasedAsin', 'halo'] as const
export type AdsMetricsDimension = (typeof ADS_METRICS_DIMENSION_KEYS)[number]
export const ADS_METRICS_DIMENSION_LABEL: Record<AdsMetricsDimension, string> = {
  date: '日期',
  hour: '小时',
  adProduct: '广告产品',
  campaign: '广告活动',
  adGroup: '广告组',
  target: '投放对象',
  matchType: '匹配方式',
  searchTerm: '搜索词',
  placement: '广告位',
  advertisedAsin: '被推广 ASIN',
  purchasedAsin: '被购买 ASIN',
  halo: '光环销售',
}

/** 基础指标（可以求和）与派生指标（由基础指标相除，分母为 0 或没有就是空）。 */
export const ADS_METRICS_BASE_KEYS = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'] as const
export type AdsMetricsBase = (typeof ADS_METRICS_BASE_KEYS)[number]
export const ADS_METRICS_DERIVED_KEYS = ['ctr', 'cpc', 'cvr', 'acos', 'roas'] as const
export type AdsMetricsDerived = (typeof ADS_METRICS_DERIVED_KEYS)[number]
export const ADS_METRICS_KEYS = [...ADS_METRICS_BASE_KEYS, ...ADS_METRICS_DERIVED_KEYS] as const
export type AdsMetricsKey = (typeof ADS_METRICS_KEYS)[number]

export type AdsMetricsFormat = 'count' | 'money' | 'percent' | 'ratio'
export interface AdsMetricsInfo {
  label: string
  format: AdsMetricsFormat
  /** 派生指标的口径（页面提示用）。 */
  formula?: string
}
export const ADS_METRICS_INFO: Record<AdsMetricsKey, AdsMetricsInfo> = {
  impressions: { label: '曝光', format: 'count' },
  clicks: { label: '点击', format: 'count' },
  spend: { label: '花费', format: 'money' },
  sales: { label: '广告销售额', format: 'money' },
  orders: { label: '订单', format: 'count' },
  units: { label: '件数', format: 'count' },
  ctr: { label: '点击率', format: 'percent', formula: '点击 ÷ 曝光' },
  cpc: { label: '单次点击成本', format: 'money', formula: '花费 ÷ 点击' },
  cvr: { label: '转化率', format: 'percent', formula: '订单 ÷ 点击' },
  acos: { label: '广告成本销售比', format: 'percent', formula: '花费 ÷ 广告销售额' },
  roas: { label: '广告投入产出比', format: 'ratio', formula: '广告销售额 ÷ 花费' },
}

const RATIOS: readonly AdsMetricsDerived[] = ADS_METRICS_DERIVED_KEYS
const BASE_AND_RATIOS: readonly AdsMetricsKey[] = ['impressions', 'clicks', 'spend', 'sales', 'orders', ...RATIOS]

export interface AdsMetricsDataset {
  key: AdsMetricsDatasetKey
  label: string
  description: string
  dimensions: readonly AdsMetricsDimension[]
  metrics: readonly AdsMetricsKey[]
  /** 默认选中的维度与指标。 */
  defaultDimensions: readonly AdsMetricsDimension[]
  defaultMetrics: readonly AdsMetricsKey[]
  /** 表里有没有“广告产品”列（决定广告产品筛选是否可用）。 */
  hasAdProduct: boolean
  /** 日期维度的含义：日、小时（小时数据集没有日粒度，按“小时”维度）。 */
  hasDate: boolean
}

export const ADS_METRICS_DATASETS: Record<AdsMetricsDatasetKey, AdsMetricsDataset> = {
  CAMPAIGN: {
    key: 'CAMPAIGN',
    label: '活动日指标',
    description: '活动 × 日（活动日报写入）。',
    dimensions: ['date', 'adProduct', 'campaign'],
    metrics: BASE_AND_RATIOS,
    defaultDimensions: ['date'],
    defaultMetrics: ['spend', 'sales', 'acos'],
    hasAdProduct: true,
    hasDate: true,
  },
  AD_GROUP: {
    key: 'AD_GROUP',
    label: '广告组日指标',
    description: '广告组 × 日（广告组日报写入）。',
    dimensions: ['date', 'adProduct', 'adGroup'],
    metrics: BASE_AND_RATIOS,
    defaultDimensions: ['adGroup'],
    defaultMetrics: ['spend', 'sales', 'acos'],
    hasAdProduct: true,
    hasDate: true,
  },
  TARGET: {
    key: 'TARGET',
    label: '投放对象日指标',
    description: '关键词与商品定向 × 日（投放对象日报写入）。',
    dimensions: ['date', 'adProduct', 'campaign', 'adGroup', 'target', 'matchType'],
    metrics: BASE_AND_RATIOS,
    defaultDimensions: ['target'],
    defaultMetrics: ['spend', 'sales', 'acos'],
    hasAdProduct: true,
    hasDate: true,
  },
  SEARCH_TERM: {
    key: 'SEARCH_TERM',
    label: '搜索词日指标',
    description: '客户搜索词 × 投放对象 × 日（搜索词日报写入）。',
    dimensions: ['date', 'adProduct', 'campaign', 'adGroup', 'target', 'matchType', 'searchTerm'],
    metrics: BASE_AND_RATIOS,
    defaultDimensions: ['searchTerm'],
    defaultMetrics: ['spend', 'sales', 'orders'],
    hasAdProduct: true,
    hasDate: true,
  },
  ADVERTISED_PRODUCT: {
    key: 'ADVERTISED_PRODUCT',
    label: '广告商品日指标',
    description: '活动 × 被推广 ASIN × 日（广告商品日报写入）。',
    dimensions: ['date', 'campaign', 'advertisedAsin'],
    metrics: [...BASE_AND_RATIOS, 'units'],
    defaultDimensions: ['advertisedAsin'],
    defaultMetrics: ['spend', 'sales', 'acos'],
    hasAdProduct: false,
    hasDate: true,
  },
  PLACEMENT: {
    key: 'PLACEMENT',
    label: '广告位日指标',
    description: '活动 × 广告位 × 日（广告位日报写入）。',
    dimensions: ['date', 'campaign', 'placement'],
    metrics: BASE_AND_RATIOS,
    defaultDimensions: ['placement'],
    defaultMetrics: ['spend', 'sales', 'acos'],
    hasAdProduct: false,
    hasDate: true,
  },
  CONVERTED_PRODUCT: {
    key: 'CONVERTED_PRODUCT',
    label: '转化商品日指标',
    description: '被推广 ASIN × 实际被购买 ASIN × 日（转化商品日报写入）；只有件数与销售额。',
    dimensions: ['date', 'campaign', 'advertisedAsin', 'purchasedAsin', 'halo'],
    metrics: ['units', 'sales'],
    defaultDimensions: ['halo'],
    defaultMetrics: ['units', 'sales'],
    hasAdProduct: false,
    hasDate: true,
  },
  HOURLY: {
    key: 'HOURLY',
    label: '活动小时指标',
    description: '活动 × 小时（活动小时报写入，最多保留 14 天）。',
    dimensions: ['hour', 'campaign'],
    metrics: BASE_AND_RATIOS,
    defaultDimensions: ['hour'],
    defaultMetrics: ['spend', 'sales', 'clicks'],
    hasAdProduct: false,
    hasDate: false,
  },
}

export const ADS_METRICS_LIMITS = {
  /** 一次最多选几个维度。 */
  maxDimensions: 3,
  /** 一次最多选几个指标。 */
  maxMetrics: 6,
  /** 数据库里最多读多少个分组（Prisma 的 take 上限 20000，要多读一行判断是否截断）。 */
  groupLimit: 19_999,
  /** 多对象对比最多选几个对象。 */
  compareMax: 5,
  /** 导出 CSV 最多导出多少行（前端导出当前结果，不走导出中心）。 */
  exportRows: 5000,
} as const

export const ADS_METRICS_EMPTY_NOTE = '这个数据集里所选范围内没有记录：对应的广告报告任务还没有导入过数据（可以去“广告报表”创建任务），或所选日期范围内没有数据'

export type AdsMetricsValues = Partial<Record<AdsMetricsKey, number | null>>

export interface AdsMetricsRow {
  /** 行的稳定键（各维度取值按顺序连接）。 */
  key: string
  /** 各所选维度的显示值（日期是桶起始日；活动用名称，没有名称用编号；光环是“是/否”）。 */
  dims: Partial<Record<AdsMetricsDimension, string>>
  values: AdsMetricsValues
  /** 活动维度能解析成系统里的活动时给详情页地址（/app/advertising/campaigns/:id），否则为空。 */
  link: string | null
}

export interface AdsMetricsProfileOption {
  id: string
  name: string
  storeName: string | null
}

export interface AdsMetricsResponse {
  state: DashState
  note: string | null
  dataset: AdsMetricsDatasetKey
  dimensions: AdsMetricsDimension[]
  metrics: AdsMetricsKey[]
  grain: DashGranularity
  period: DashPeriod
  defaulted: boolean
  /** 全部分组的合计（不受分页影响）；没有任何一行有值的指标是 null。 */
  totals: AdsMetricsValues
  groupCount: number
  /** 数据库分组数碰到上限，合计与排序只覆盖已读到的部分。 */
  truncated: boolean
  items: AdsMetricsRow[]
  profiles: AdsMetricsProfileOption[]
  /** 非美元币种的行数（只看美元，这些行没有计入）。 */
  otherCurrencyRows: number
  pageInfo: CursorPageInfo
}
