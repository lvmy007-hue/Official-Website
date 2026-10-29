import { z } from 'zod'

// 目标与预算契约（P2a-04，04 章 4.4；freeze/models.md 第七节 BusinessTarget）。
// 目标按店铺 × 期间设置；整店目标 dimension=STORE、dimensionRef 固定为 'ALL'；
// 细化目标 dimension=ASIN（dimensionRef 为逗号分隔的 ASIN 列表，即“ASIN 组”）或 CATEGORY（dimensionRef 为类目路径）。
// 达成进度与预测达成公式见 freeze/metrics.md M-013、M-014：
//   M-013 本期实际 ÷ 目标；节奏线两种——按天均摊（目标 ÷ 天数 × 已过天数）、历史季节曲线（近 2 年同期日占比累计，缺历史退化为按天均摊并提示）；
//   M-014 本期已实际 + 剩余天数销量预测（取中位值与区间，模型估算）；缺口 = 目标 − 预测中位值。

export const TARGET_METRICS = ['SALES', 'ORDERS', 'UNITS', 'PROFIT', 'ADS_SPEND'] as const
export type TargetMetric = (typeof TARGET_METRICS)[number]
export const TARGET_METRIC_LABEL: Record<TargetMetric, string> = {
  SALES: '销售额',
  ORDERS: '订单数',
  UNITS: '件数',
  PROFIT: '净利润',
  ADS_SPEND: '广告花费',
}

export const TARGET_DIMENSIONS = ['STORE', 'CATEGORY', 'ASIN'] as const
export type TargetDimension = (typeof TARGET_DIMENSIONS)[number]
export const TARGET_DIMENSION_LABEL: Record<TargetDimension, string> = { STORE: '整店', CATEGORY: '类目', ASIN: 'ASIN 组' }
/** 整店目标固定使用这个 dimensionRef。 */
export const STORE_DIMENSION_REF = 'ALL'

export const TARGET_PERIOD_KINDS = ['MONTH', 'QUARTER', 'YEAR'] as const
export type TargetPeriodKind = (typeof TARGET_PERIOD_KINDS)[number]
export const TARGET_PERIOD_KIND_LABEL: Record<TargetPeriodKind, string> = { MONTH: '月', QUARTER: '季', YEAR: '年' }

export const TARGET_PACE_MODES = ['LINEAR', 'SEASONAL'] as const
export type TargetPaceMode = (typeof TARGET_PACE_MODES)[number]
export const TARGET_PACE_MODE_LABEL: Record<TargetPaceMode, string> = { LINEAR: '按天均摊', SEASONAL: '历史季节曲线' }

/** 历史季节曲线取近几年同期（同月）作为基线；不足时退化为按天均摊。 */
export const TARGET_SEASONAL_LOOKBACK_YEARS = 2

const periodStartShape = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')

/** periodStart 必须落在 periodKind 对应的期初（月初 / 季初 / 年初）。 */
export function isValidPeriodStart(periodKind: TargetPeriodKind, periodStart: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return false
  const month = Number(periodStart.slice(5, 7))
  const day = periodStart.slice(8, 10)
  if (day !== '01') return false
  if (periodKind === 'YEAR') return month === 1
  if (periodKind === 'QUARTER') return [1, 4, 7, 10].includes(month)
  return true // MONTH：任意月份的 01 号
}

const PeriodFields = {
  periodKind: z.enum(TARGET_PERIOD_KINDS).default('MONTH'),
  periodStart: periodStartShape,
}

export const TargetListQuerySchema = z
  .object({ sellerAccountId: z.string().min(1), ...PeriodFields })
  .refine(value => isValidPeriodStart(value.periodKind, value.periodStart), { message: '期间起始日期应为该周期粒度的期初（月初 / 季初 / 年初）', path: ['periodStart'] })
export type TargetListQuery = z.infer<typeof TargetListQuerySchema>

export const TargetHistoryQuerySchema = TargetListQuerySchema
export type TargetHistoryQuery = z.infer<typeof TargetHistoryQuerySchema>

/** ASIN 组：逗号分隔，去空白、去重、转大写（ASIN 本身即大写）。 */
export function normalizeAsinGroup(raw: string): string {
  const asins = [
    ...new Set(
      raw
        .split(',')
        .map(item => item.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]
  return asins.join(',')
}

export const TargetUpsertBodySchema = z
  .object({
    sellerAccountId: z.string().min(1),
    ...PeriodFields,
    dimension: z.enum(TARGET_DIMENSIONS).default('STORE'),
    dimensionRef: z.string().trim().min(1).max(500).default(STORE_DIMENSION_REF),
    metric: z.enum(TARGET_METRICS),
    targetValue: z.coerce.number().finite().min(0).max(1e15),
    paceMode: z.enum(TARGET_PACE_MODES).default('LINEAR'),
    note: z.string().trim().max(500).optional(),
    /** 0 表示“按没有记录创建”；否则必须与当前版本一致，不一致返回 409。 */
    version: z.coerce.number().int().min(0),
  })
  .refine(value => isValidPeriodStart(value.periodKind, value.periodStart), { message: '期间起始日期应为该周期粒度的期初（月初 / 季初 / 年初）', path: ['periodStart'] })
  .transform(value => ({
    ...value,
    dimensionRef: value.dimension === 'STORE' ? STORE_DIMENSION_REF : value.dimension === 'ASIN' ? normalizeAsinGroup(value.dimensionRef) : value.dimensionRef,
  }))
export type TargetUpsertBody = z.infer<typeof TargetUpsertBodySchema>

export type TargetProgressState = 'NOT_SET' | 'RESTRICTED' | 'NOT_CONNECTED' | 'OK'

export interface TargetForecast {
  /** 预测中位值（本期已实际 + 剩余天数预测，模型估算）。 */
  median: number
  low: number
  high: number
  /** 目标 − 预测中位值；正数表示预计不达标的缺口，负数表示预计超出目标。 */
  gap: number
}

export interface TargetProgress {
  state: TargetProgressState
  note: string | null
  /** 截至时刻（企业数据口径时区的日历日）。 */
  asOf: string | null
  actualToDate: number | null
  /** 节奏线下“到今天应该完成多少”；periodKind 不是 MONTH 时为 null（暂不支持节奏线，只有整期合计）。 */
  expectedToDate: number | null
  achievementRatio: number | null
  elapsedDays: number | null
  totalDays: number | null
  /** 选了历史季节曲线但历史数据不足，已退化为按天均摊。 */
  paceFallback: boolean
  forecast: TargetForecast | null
}

export interface TargetRow {
  id: string | null
  dimension: TargetDimension
  dimensionRef: string
  metric: TargetMetric
  targetValue: number | null
  paceMode: TargetPaceMode
  note: string | null
  version: number
  updatedAt: string | null
  updatedBy: string | null
  progress: TargetProgress
}

export interface TargetGridResponse {
  sellerAccountId: string
  periodKind: TargetPeriodKind
  periodStart: string
  periodEnd: string
  currency: 'USD'
  /** 整店目标：TARGET_METRICS 的每个指标固定一行，没设置过的行 targetValue 为 null。 */
  storeRows: TargetRow[]
  /** 细化目标（类目 / ASIN 组）：只返回已创建的行。 */
  customRows: TargetRow[]
  metrics: Array<{ key: TargetMetric; label: string }>
}

export interface TargetUpsertResponse {
  row: TargetRow
}

export interface TargetHistoryItem {
  id: string
  at: string
  dimension: TargetDimension
  dimensionRef: string
  metric: TargetMetric
  title: string
  actor: string | null
}
export interface TargetHistoryResponse {
  items: TargetHistoryItem[]
}
