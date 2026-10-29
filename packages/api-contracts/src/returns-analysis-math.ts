import {
  RETURN_COHORT_OPEN_DAYS,
  RETURN_CYCLE_DEFAULT_BOUNDS,
  RETURN_CYCLE_MAX_BOUNDS,
  RETURN_CYCLE_MAX_DAYS,
  RETURN_RANK_MIN_UNITS,
  RETURN_RANK_ROWS,
  type ReturnCycleBucketRow,
} from './returns-analysis.js'

// 退货分析的纯计算（P6-13）：天数差、天数段分桶、按件数加权的中位数、月份、三期对比与榜单。接口与页面共用，不依赖任何运行时。
// 日期一律是 YYYY-MM-DD 文本（企业时区的整天），不碰时间戳，避免时区在这里再算一次。

const DAY_MS = 86_400_000
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const dayText = (value: number) => new Date(value).toISOString().slice(0, 10)

/** to 比 from 晚几整天（同一天为 0，to 更早为负数）。 */
export function returnDaysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS)
}

export const returnAddDays = (day: string, days: number) => dayText(dayMs(day) + days * DAY_MS)
export const round4 = (value: number) => Math.round(value * 10_000) / 10_000
export const shareOf = (units: number, total: number) => (total > 0 ? round4(units / total) : 0)

// ---- 天数段 ----

/**
 * 解析天数段上界，例如 `7,14,30,60,90`：必须是严格递增的正整数，最多 10 个，每个不超过 1095。
 * 没写（或写空）用默认的一套；写错返回原因，不悄悄改成默认值。
 */
export function parseBounds(raw: string | null | undefined): { bounds: number[]; error: string | null } {
  const fallback = [...RETURN_CYCLE_DEFAULT_BOUNDS]
  if (raw === undefined || raw === null || raw.trim() === '') return { bounds: fallback, error: null }
  const parts = raw.split(',').map(part => part.trim())
  const bounds = parts.map(part => (/^\d{1,4}$/.test(part) ? Number(part) : Number.NaN))
  if (bounds.length > RETURN_CYCLE_MAX_BOUNDS) return { bounds: fallback, error: `天数段最多 ${RETURN_CYCLE_MAX_BOUNDS} 个分界点` }
  if (bounds.some(value => !Number.isInteger(value) || value < 1 || value > RETURN_CYCLE_MAX_DAYS)) return { bounds: fallback, error: `分界点必须是 1 到 ${RETURN_CYCLE_MAX_DAYS} 之间的整数` }
  for (let index = 1; index < bounds.length; index += 1) if (bounds[index]! <= bounds[index - 1]!) return { bounds: fallback, error: '分界点必须从小到大、不能重复' }
  return { bounds, error: null }
}

/** 天数段：上界 [7,14,30,60,90] → 0–7、8–14、15–30、31–60、61–90、90 天以上。 */
export function cycleBucketsOf(bounds: readonly number[]): Array<Pick<ReturnCycleBucketRow, 'key' | 'label' | 'min' | 'max'>> {
  const rows: Array<Pick<ReturnCycleBucketRow, 'key' | 'label' | 'min' | 'max'>> = []
  let min = 0
  for (const upper of bounds) {
    rows.push({ key: `${min}-${upper}`, label: `${min}–${upper} 天`, min, max: upper })
    min = upper + 1
  }
  const last = bounds[bounds.length - 1] ?? 0
  rows.push({ key: `${min}+`, label: `${last} 天以上`, min, max: null })
  return rows
}

/** 天数落在第几段（下标与 cycleBucketsOf 一致）；负数（起点晚于退货，数据异常）返回 -1。 */
export function cycleBucketIndex(days: number, bounds: readonly number[]): number {
  if (!Number.isFinite(days) || days < 0) return -1
  const index = bounds.findIndex(upper => days <= upper)
  return index === -1 ? bounds.length : index
}

// ---- 中位数 ----

/** 按件数加权的中位数：一条记录 2 件按 2 个同样的值算；件数为偶数时取中间两个的平均；没有样本返回 null。 */
export function weightedMedian(entries: ReadonlyArray<{ value: number; weight: number }>): number | null {
  const sorted = entries.filter(entry => entry.weight > 0 && Number.isFinite(entry.value)).sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0)
  if (total === 0) return null
  const at = (position: number) => {
    let seen = 0
    for (const entry of sorted) {
      seen += entry.weight
      if (position <= seen) return entry.value
    }
    return sorted[sorted.length - 1]!.value
  }
  return total % 2 === 1 ? at((total + 1) / 2) : (at(total / 2) + at(total / 2 + 1)) / 2
}

/** 一组退货的周期统计：每段件数、可计算件数、无法计算件数（起点缺失或晚于退货日）、中位数。 */
export function cycleStats(rows: ReadonlyArray<{ days: number | null; units: number }>, bounds: readonly number[]) {
  const buckets = Array.from({ length: bounds.length + 1 }, () => 0)
  const samples: Array<{ value: number; weight: number }> = []
  let units = 0
  let unknownUnits = 0
  for (const row of rows) {
    const index = row.days === null ? -1 : cycleBucketIndex(row.days, bounds)
    if (index < 0) {
      unknownUnits += row.units
      continue
    }
    buckets[index] = (buckets[index] ?? 0) + row.units
    units += row.units
    samples.push({ value: row.days!, weight: row.units })
  }
  return { buckets, units, unknownUnits, median: weightedMedian(samples) }
}

// ---- 月份 ----

export const monthOf = (day: string) => day.slice(0, 7)

/** 月份集合取最近的 limit 个，升序、去重。 */
export function latestMonths(months: Iterable<string>, limit: number): string[] {
  return [...new Set(months)].sort().slice(-limit)
}

/** 某个月（YYYY-MM）的最后一天。 */
export function monthLastDay(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  return dayText(Date.UTC(year!, mon!, 0))
}

/** 某个月（YYYY-MM）的第一天。 */
export const monthFirstDay = (month: string) => `${month}-01`

/** 该下单月的退货窗口是否还没结束：月底距今天不足 RETURN_COHORT_OPEN_DAYS 天。 */
export function cohortWindowOpen(month: string, today: string): boolean {
  return returnDaysBetween(monthLastDay(month), today) < RETURN_COHORT_OPEN_DAYS
}

// ---- 三期对比与榜单 ----

/** 以 [from, to] 为本期，往前取两段等长的期间（上期、上上期）。 */
export function threePeriods(from: string, to: string) {
  const span = returnDaysBetween(from, to) + 1
  const previousTo = returnAddDays(from, -1)
  const previousFrom = returnAddDays(previousTo, 1 - span)
  const beforeTo = returnAddDays(previousFrom, -1)
  const beforeFrom = returnAddDays(beforeTo, 1 - span)
  return {
    current: { from, to },
    previous: { from: previousFrom, to: previousTo },
    beforePrevious: { from: beforeFrom, to: beforeTo },
  }
}

export interface ReturnMoverInput {
  asin: string
  current: number
  previous: number
  beforePrevious: number
}
export interface ReturnMover extends ReturnMoverInput {
  delta: number
  streak: boolean
}

/**
 * 异常榜与改善榜：异常榜取本期比上期增加最多的（本期至少 RETURN_RANK_MIN_UNITS 件），改善榜取减少最多的（上期至少 RETURN_RANK_MIN_UNITS 件）。
 * 连续两期都在变坏（或变好）标 streak。并列时先看本期件数、再按 ASIN 排，保证每次顺序一样。
 */
export function rankMovers(rows: readonly ReturnMoverInput[], limit: number = RETURN_RANK_ROWS): { anomalies: ReturnMover[]; improvements: ReturnMover[] } {
  const all = rows.map((row): ReturnMover => ({ ...row, delta: row.current - row.previous, streak: false }))
  const anomalies = all
    .filter(row => row.delta > 0 && row.current >= RETURN_RANK_MIN_UNITS)
    .sort((a, b) => b.delta - a.delta || b.current - a.current || a.asin.localeCompare(b.asin))
    .slice(0, limit)
    .map(row => ({ ...row, streak: row.previous > row.beforePrevious }))
  const improvements = all
    .filter(row => row.delta < 0 && row.previous >= RETURN_RANK_MIN_UNITS)
    .sort((a, b) => a.delta - b.delta || b.previous - a.previous || a.asin.localeCompare(b.asin))
    .slice(0, limit)
    .map(row => ({ ...row, streak: row.previous < row.beforePrevious }))
  return { anomalies, improvements }
}
