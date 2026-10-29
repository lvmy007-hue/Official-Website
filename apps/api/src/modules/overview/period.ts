import { weekStartOf, type DashCompare, type DashGranularity, type DashPeriod, type WeekStartDay } from '@nova/api-contracts'

// 经营控制台的日期口径（纯函数）：日期一律用 YYYY-MM-DD 字符串，汇总表的日期是企业数据口径时区的日历日。
// 默认范围：近 30 天（含今天），没有显式选择时间范围时对比上一期。

const DAY_MS = 86_400_000
export const DEFAULT_RANGE_DAYS = 30
/** 逐日展开的上限，防止异常范围拖慢接口（与全局范围的 1100 天上限一致）。 */
export const MAX_EXPAND_DAYS = 1100

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)
const fromMs = (value: number) => new Date(value).toISOString().slice(0, 10)

export const addDays = (date: string, days: number) => fromMs(ms(date) + days * DAY_MS)
/** 含首尾的天数 */
export const spanDays = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY_MS) + 1
export const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
export const dateText = (value: Date) => value.toISOString().slice(0, 10)

export const DEFAULT_ZONE = 'America/Los_Angeles'

/** 企业设置的时区无效时回退到美国太平洋时区（与日汇总一致）。 */
export function validZone(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_ZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return DEFAULT_ZONE
  }
}

/** 此刻在指定时区的日历日；时区无效时回退到美国太平洋时区。 */
export function todayIn(zone: string, now: Date = new Date()): string {
  const format = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  try {
    return format(zone)
  } catch {
    return format('America/Los_Angeles')
  }
}

/** 某个时刻在指定时区的日历日（事件落日用）。 */
export function localDate(value: Date, zone: string): string {
  return todayIn(zone, value)
}

/** 指定时区某个日历日零点对应的 UTC 时刻（用来把“本地日范围”换成时间列上的范围）。 */
export function zonedDayStart(date: string, zone: string): Date {
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant))
    const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0)
    return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second')) - Math.floor(instant / 1000) * 1000
  }
  const guess = Date.parse(`${date}T00:00:00Z`)
  const first = guess - offsetAt(guess)
  return new Date(guess - offsetAt(first))
}

export const eachDay = (from: string, to: string): string[] => {
  const days = Math.min(spanDays(from, to), MAX_EXPAND_DAYS)
  return Array.from({ length: Math.max(days, 0) }, (_, index) => addDays(from, index))
}

export const period = (from: string, to: string): DashPeriod => ({ from, to, days: spanDays(from, to) })

export function previousPeriod(current: DashPeriod): DashCompare {
  return { mode: 'previous', from: addDays(current.from, -current.days), to: addDays(current.from, -1), days: current.days }
}

/** 去年同期：整体回退一年（2 月 29 日回退到 2 月 28 日）。 */
export function yoyPeriod(current: DashPeriod): DashCompare {
  const shift = (date: string) => {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number]
    const candidate = new Date(Date.UTC(year - 1, month - 1, day))
    return candidate.getUTCMonth() !== month - 1 ? `${year - 1}-02-28` : fromMs(candidate.getTime())
  }
  const from = shift(current.from)
  const to = shift(current.to)
  return { mode: 'yoy', from, to, days: spanDays(from, to) }
}

export interface ScopeDates {
  from?: string
  to?: string
  compare?: 'none' | 'previous' | 'yoy' | 'custom'
  compareFrom?: string
  compareTo?: string
}

export interface ResolvedPeriods {
  period: DashPeriod
  /** 页面选择的对比期；没有为 null */
  compare: DashCompare | null
  /** 趋势图上固定叠加的环比、同比 */
  previous: DashCompare
  yoy: DashCompare
  defaulted: boolean
}

export function resolvePeriods(scope: ScopeDates, today: string): ResolvedPeriods {
  const defaulted = !scope.from || !scope.to
  const current = defaulted ? period(addDays(today, 1 - DEFAULT_RANGE_DAYS), today) : period(scope.from!, scope.to!)
  const previous = previousPeriod(current)
  const yoy = yoyPeriod(current)
  let compare: DashCompare | null = null
  if (defaulted) compare = previous
  else if (scope.compare === 'previous') compare = previous
  else if (scope.compare === 'yoy') compare = yoy
  else if (scope.compare === 'custom' && scope.compareFrom && scope.compareTo) compare = { mode: 'custom', ...period(scope.compareFrom, scope.compareTo) }
  return { period: current, compare, previous, yoy, defaulted }
}

// ---- 周、月分桶 ----
/** 一周的开始日由企业的业务口径决定（P6-31），默认周一 */
export function weekStart(date: string, day: WeekStartDay = 'MON'): string {
  return weekStartOf(date, day)
}
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`
export function monthEnd(date: string): string {
  const [year, month] = date.split('-').map(Number) as [number, number]
  return fromMs(Date.UTC(year, month, 0))
}

export function bucketKey(date: string, granularity: DashGranularity, weekDay: WeekStartDay = 'MON'): string {
  if (granularity === 'week') return weekStart(date, weekDay)
  if (granularity === 'month') return monthStart(date)
  return date
}

/** 包含某天的桶的起止日 */
export function bucketBounds(date: string, granularity: DashGranularity, weekDay: WeekStartDay = 'MON'): { from: string; to: string } {
  if (granularity === 'week') {
    const from = weekStart(date, weekDay)
    return { from, to: addDays(from, 6) }
  }
  if (granularity === 'month') return { from: monthStart(date), to: monthEnd(date) }
  return { from: date, to: date }
}

/** 紧邻其前的同类桶的起止日 */
export function previousBucket(date: string, granularity: DashGranularity, weekDay: WeekStartDay = 'MON'): { from: string; to: string } {
  const current = bucketBounds(date, granularity, weekDay)
  return bucketBounds(addDays(current.from, -1), granularity, weekDay)
}
