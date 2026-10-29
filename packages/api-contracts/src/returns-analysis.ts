import type { InventoryFreshness } from './inventory.js'
import type { ReturnAsinRow, ReturnBucket, ReturnDispositionGroup, ReturnTrendPoint } from './returns.js'

// 退货分析（P6-13，16 章第 6 节；freeze/api.md `/returns/analysis/*`；指标 M-700 至 M-704）。零 zod，前后端共用。
// 与退货率（M-310，按退货发生日）、退款率（M-126）是三个不同的指标，名称不得混用。
// 请求体与查询校验在 returns-analysis-query.ts（带 zod，前端不引用）；纯计算在 returns-analysis-math.ts。

export const RETURN_ANALYSIS_PERMISSION = 'returns.read'

/** 时间口径：按退货发生日期，或按下单日期（同一批订单）。 */
export const RETURN_TIME_BASES = ['return', 'order'] as const
export type ReturnTimeBasis = (typeof RETURN_TIME_BASES)[number]
export const RETURN_TIME_BASIS_LABEL: Readonly<Record<ReturnTimeBasis, string>> = { return: '按退货时间', order: '按下单时间' }
export const DEFAULT_TIME_BASIS: ReturnTimeBasis = 'return'

/** 退货周期的起点：下单日期（默认）或发货日期。 */
export const RETURN_CYCLE_ANCHORS = ['order', 'ship'] as const
export type ReturnCycleAnchor = (typeof RETURN_CYCLE_ANCHORS)[number]
export const RETURN_CYCLE_ANCHOR_LABEL: Readonly<Record<ReturnCycleAnchor, string>> = { order: '下单日期', ship: '发货日期' }

/** 退货周期可以按哪个维度切片（none 是只看整体）。 */
export const RETURN_CYCLE_DIMENSIONS = ['none', 'asin', 'reason', 'disposition'] as const
export type ReturnCycleDimension = (typeof RETURN_CYCLE_DIMENSIONS)[number]
export const RETURN_CYCLE_DIMENSION_LABEL: Readonly<Record<ReturnCycleDimension, string>> = { none: '整体', asin: '按 ASIN', reason: '按原因', disposition: '按处置结果' }

/** 默认的天数段上界：0–7、8–14、15–30、31–60、61–90、90 天以上。 */
export const RETURN_CYCLE_DEFAULT_BOUNDS: readonly number[] = [7, 14, 30, 60, 90]
export const RETURN_CYCLE_MAX_BOUNDS = 10
export const RETURN_CYCLE_MAX_DAYS = 1095
/** 切片行最多显示多少行（其余并入“其他”）。 */
export const RETURN_SLICE_ROWS = 15
/** 趋势、周期、跨月、队列的明细读取上限（超出标 truncated）。 */
export const RETURN_ANALYSIS_ROW_CAP = 20_000
/** 下单月 × 退货月矩阵最多显示的月数。 */
export const RETURN_MATRIX_MONTHS = 12
/** 跨月退货的退款金额占比最多核对多少个订单（取最近的订单，超出标“部分”）。 */
export const RETURN_REFUND_ORDER_CAP = 500
/** 异常榜、改善榜每榜最多多少行，以及入榜的最少件数（太少的波动没有意义）。 */
export const RETURN_RANK_ROWS = 10
export const RETURN_RANK_MIN_UNITS = 3
/** 退货窗口还没结束的下单月：下单后多少天内的订单，退货仍在增加（用于提示队列退货率会继续上升）。 */
export const RETURN_COHORT_OPEN_DAYS = 90

export const RETURN_ANALYSIS_BASIS: Readonly<Record<'summary' | 'cycle' | 'crossMonth' | 'cohort' | 'matrix', string>> = {
  summary:
    '退货率 = 退货件数 ÷ 销售件数（经营日汇总，按下单日），两者落在同一个时间桶里；退货总是晚于销售，短期退货率会偏离真实水平。' +
    '“按下单时间”只统计能确定下单时间的退货；缺下单时间的退货单独计数（M-704），不并入也不丢弃。',
  cycle:
    '退货周期 = 退货日期 − 起点日期（下单日期或发货日期），按企业时区的整天数；缺起点日期的退货不参与，起点晚于退货日期的异常记录同样不参与，都单独计数“无法计算周期 N 条”（M-704）。' +
    '中位数按件数加权（一条记录 2 件按 2 件算）；天数段可以配置，同一时刻只用一套。',
  crossMonth: '跨月退货占比 = 下单月与退货月不同的退货件数 ÷ 可计算的退货件数（M-702）；月份边界按企业时区；缺下单时间的退货不进分子分母。' + '退款金额取订单口径的财务交易（同一订单只算一次）。',
  cohort:
    '队列退货率（M-703）：分子分母都按同一批订单的下单月统计 = 该下单月的订单产生的退货件数（不论何时退回）÷ 该下单月的销售件数；反映一批订单最终的退货水平，近月的退货窗口尚未结束，数值会随时间上升。' +
    '退货率（M-310）按退货发生日统计，分子分母不是同一批订单，反映当期退货压力；两者用途不同，天然不等。分母暂用经营日汇总的销售件数（按下单日）。',
  matrix: '库存属性是退货件的处置分组（可售、损坏、承运人损坏等，来自退货明细的详细处置），处置结果是报告里的处理状态原文（例如 Unit returned to inventory）。',
}

// ---- 公共部分 ----

export interface ReturnAnalysisCommon {
  state: 'OK' | 'NO_DATA'
  note: string | null
  range: { from: string; to: string; defaulted: boolean }
  timeBasis: ReturnTimeBasis
  /** 缺下单时间、无法落入下单口径（或算不出周期与跨月归属）的退货件数（M-704）。 */
  unknownOrderUnits: number
  /** 同上，按退货记录条数（页面写“无法计算周期 N 条”用它，件数在括号里）。 */
  unknownOrderRows: number
  basis: string
  freshness: InventoryFreshness
}

// ---- 概览 ----

export interface ReturnReasonSummaryRow {
  /** 归并键（大写；没有原因是 UNSPECIFIED）。 */
  code: string
  label: string
  category: string
  /** 是否还是“未分类”（映射表里没有登记或还没补全）。 */
  unclassified: boolean
  units: number
  share: number
}

export interface ReturnCategoryRow {
  category: string
  units: number
  share: number
}

export interface ReturnDispositionRow {
  group: ReturnDispositionGroup
  label: string
  units: number
  share: number
}

export interface ReturnRankPeriod {
  key: 'current' | 'previous' | 'beforePrevious'
  label: string
  from: string
  to: string
}

export interface ReturnRankRow {
  asin: string
  /** 三期的退货件数（本期、上期、上上期）。 */
  current: number
  previous: number
  beforePrevious: number
  /** 本期比上期的变化（件数）。 */
  delta: number
  /** 本期与上期都比各自的前一期多（连续恶化）或都比前一期少（连续改善）。 */
  streak: boolean
  /** 三期各自的退货率；销售件数没有汇总时为 null（不是 0）。 */
  rates: { current: number | null; previous: number | null; beforePrevious: number | null }
  productId: string | null
  title: string | null
}

export interface ReturnRanks {
  periods: ReturnRankPeriod[]
  /** 异常榜：本期退货件数比上期增加最多的 ASIN。 */
  anomalies: ReturnRankRow[]
  /** 改善榜：本期退货件数比上期减少最多的 ASIN。 */
  improvements: ReturnRankRow[]
  /** 某一期的 ASIN 超过读取上限，榜单可能不完整。 */
  truncated: boolean
}

export interface ReturnSummaryResponse extends ReturnAnalysisCommon {
  bucket: ReturnBucket
  totals: { returnedUnits: number; soldUnits: number | null; rate: number | null }
  trend: ReturnTrendPoint[]
  byAsin: ReturnAsinRow[]
  byReason: ReturnReasonSummaryRow[]
  byCategory: ReturnCategoryRow[]
  byDisposition: ReturnDispositionRow[]
  ranks: ReturnRanks
  /** 范围内出现、但映射表里还没有补全的原因代码（提醒去补全）。 */
  unclassified: { codes: string[]; units: number }
  /** 趋势用的明细触到读取上限时为真；排行与汇总是精确的。 */
  truncated: boolean
}

// ---- 退货周期 ----

export interface ReturnCycleBucketRow {
  key: string
  label: string
  /** 天数段下界与上界（含）；最后一段没有上界。 */
  min: number
  max: number | null
  units: number
  share: number | null
}

export interface ReturnCycleSliceRow {
  key: string
  label: string
  units: number
  median: number | null
  /** 与 buckets 同序的各段件数。 */
  buckets: number[]
}

export interface ReturnCycleResponse extends ReturnAnalysisCommon {
  anchor: ReturnCycleAnchor
  bounds: number[]
  buckets: ReturnCycleBucketRow[]
  totals: { units: number; median: number | null }
  dimension: ReturnCycleDimension
  slices: ReturnCycleSliceRow[]
  truncated: boolean
}

// ---- 跨月退货与队列退货率 ----

export interface ReturnCrossMonthRefund {
  state: 'OK' | 'NO_DATA' | 'PARTIAL' | 'MIXED_CURRENCY'
  currency: string | null
  crossMonthAmount: number | null
  totalAmount: number | null
  share: number | null
  /** 实际核对了多少个订单的退款（最多 RETURN_REFUND_ORDER_CAP 个，取最近的）。 */
  sampledOrders: number
  note: string | null
}

export interface ReturnMatrix {
  /** 下单月（行）与退货月（列），YYYY-MM，升序，最多 RETURN_MATRIX_MONTHS 个。 */
  orderMonths: string[]
  returnMonths: string[]
  /** cells[行][列] 是该下单月在该退货月退回的件数。 */
  cells: number[][]
  /** 落在显示月份之外的件数。 */
  hiddenUnits: number
}

export interface ReturnCrossMonthResponse extends ReturnAnalysisCommon {
  totals: { computableUnits: number; crossMonthUnits: number; share: number | null }
  refund: ReturnCrossMonthRefund
  matrix: ReturnMatrix
  truncated: boolean
}

export interface ReturnCohortRow {
  month: string
  /** 该月的销售件数（经营日汇总，按下单日）；没有汇总为 null。 */
  soldUnits: number | null
  /** 该下单月的订单产生的退货件数（不论何时退回）。 */
  cohortReturnedUnits: number
  /** 队列退货率（M-703）。 */
  cohortRate: number | null
  /** 该月内发生的退货件数（按退货日）。 */
  returnedInMonthUnits: number
  /** 退货率（M-310，按退货日）。 */
  returnDateRate: number | null
  /** 退货窗口是否还没结束（月底距今不足 RETURN_COHORT_OPEN_DAYS 天）。 */
  windowOpen: boolean
}

export interface ReturnCohortResponse extends ReturnAnalysisCommon {
  months: ReturnCohortRow[]
  truncated: boolean
}

// ---- 库存属性 × 处置结果 ----

export interface ReturnMatrixAxis {
  key: string
  label: string
}

export interface ReturnDispositionMatrixResponse extends ReturnAnalysisCommon {
  /** 库存属性（处置分组）。 */
  rows: Array<ReturnMatrixAxis & { group: ReturnDispositionGroup }>
  /** 处置结果（报告处理状态原文，最多 8 种，其余并入“其他状态”；没有的是“未提供”）。 */
  columns: ReturnMatrixAxis[]
  cells: number[][]
  totals: { units: number }
}
