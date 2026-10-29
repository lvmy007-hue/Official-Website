import { PROMOTION_BASELINE_MIN_DAYS, type PromotionBaselineInfo } from './promotions.js'

// 促销效果的估算口径（P4-05，D-06 基线法，M-160 促销投入回报率）：全部是纯函数，API 与测试共用。
// 基线 = 活动开始前 28 天里“有效日”的日均，按星期对齐（周几对周几）；有效日 = 没有被同期其他促销占用、且这一天有数据。
// 估算不是事实：有效日不足时不给数字，页面写明原因，不用 0 或零星几天硬凑。

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000
const DAY_MS = 86_400_000

/** 日期（YYYY-MM-DD）是星期几，0 为周日。 */
export const promoWeekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay()
export const promoShiftDate = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

export interface BaselineDay {
  date: string
  /** 这一天的指标值；没有数据为 null（与 0 区分）。 */
  value: number | null
  /** 被同期其他促销占用，不能作为基线。 */
  excluded: boolean
}

export interface BaselineResult {
  info: Omit<PromotionBaselineInfo, 'from' | 'to'>
  /** 活动期间每一天的基线期望值；基线不足时为空。 */
  perDate: Map<string, number>
  total: number | null
}

/**
 * 基线估算：每个星期取有效日均值（该星期没有有效日时用全部有效日的总均值），再对到活动期间的每一天。
 * 有效日少于 `minDays` 时 state=INSUFFICIENT，一个有效日也没有 state=NONE，都不给数字。
 */
export function baselineExpectation(days: readonly BaselineDay[], windowDates: readonly string[], minDays = PROMOTION_BASELINE_MIN_DAYS): BaselineResult {
  const valid = days.filter(day => !day.excluded && day.value !== null) as Array<BaselineDay & { value: number }>
  const info = { usedDays: valid.length, excludedDays: days.length - valid.length }
  if (valid.length === 0) return { info: { ...info, state: 'NONE' }, perDate: new Map(), total: null }
  if (valid.length < minDays) return { info: { ...info, state: 'INSUFFICIENT' }, perDate: new Map(), total: null }
  const overall = valid.reduce((sum, day) => sum + day.value, 0) / valid.length
  const byWeekday = new Map<number, number[]>()
  for (const day of valid) byWeekday.set(promoWeekdayOf(day.date), [...(byWeekday.get(promoWeekdayOf(day.date)) ?? []), day.value])
  const perDate = new Map<string, number>()
  for (const date of windowDates) {
    const same = byWeekday.get(promoWeekdayOf(date))
    perDate.set(date, round6(same ? same.reduce((sum, value) => sum + value, 0) / same.length : overall))
  }
  const total = round6([...perDate.values()].reduce((sum, value) => sum + value, 0))
  return { info: { ...info, state: 'OK' }, perDate, total }
}

/** 实际 − 基线期望；任一为 null 则不给。提升幅度 = 增量 ÷ 基线，基线为 0 时不给（除零没有意义）。 */
export function promoIncrementOf(actual: number | null, expected: number | null): { value: number | null; liftPct: number | null } {
  if (actual === null || expected === null) return { value: null, liftPct: null }
  const value = round6(actual - expected)
  return { value, liftPct: expected > 0 ? round6((value / expected) * 100) : null }
}

/** 促销投入回报率 = 增量毛利 ÷（折扣成本 + 平台费用）；分母必须大于 0，增量毛利缺失时不给。 */
export function promotionRoi(incrementalProfit: number | null, discountCost: number | null, platformFee: number | null): { value: number | null; denominator: number | null } {
  if (discountCost === null || platformFee === null) return { value: null, denominator: null }
  const denominator = round6(discountCost + platformFee)
  if (incrementalProfit === null || denominator <= 0) return { value: null, denominator }
  return { value: round6(incrementalProfit / denominator), denominator }
}

export interface PromotionSpan {
  startDate: string
  endDate: string | null
}

/** 活动期间（含首尾日）截至今天；还没开始返回 null。结束日为空按“持续到今天”算。 */
export function effectWindow(span: PromotionSpan, today: string): { from: string; to: string; days: number } | null {
  if (span.startDate > today) return null
  const to = span.endDate && span.endDate < today ? span.endDate : today
  if (to < span.startDate) return null
  return { from: span.startDate, to, days: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${span.startDate}T00:00:00Z`)) / DAY_MS) + 1 }
}

/** 基线取数的日期范围：活动开始前 N 天（不含开始日）。 */
export function baselineRange(startDate: string, days: number): { from: string; to: string } {
  return { from: promoShiftDate(startDate, -days), to: promoShiftDate(startDate, -1) }
}

/** 两个日期区间（含首尾）是否重叠；endDate 为空表示一直持续。 */
export function promoOverlaps(a: { from: string; to: string | null }, b: { from: string; to: string | null }): boolean {
  return a.from <= (b.to ?? '9999-12-31') && b.from <= (a.to ?? '9999-12-31')
}
