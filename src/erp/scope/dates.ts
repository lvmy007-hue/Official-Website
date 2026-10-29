import { MARKETPLACE_TIME_ZONE } from '../format'

// 业务日期工具：全站按亚马逊美国站时区切日（America/Los_Angeles），日期一律用 YYYY-MM-DD 字符串。

const dayMs = 86_400_000

/** 当前时刻在站点时区的业务日期。 */
export function todayInMarketplace(now: Date = new Date(), timeZone = MARKETPLACE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

const toUtcMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const fromUtcMs = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const addDays = (date: string, days: number) => fromUtcMs(toUtcMs(date) + days * dayMs)

/** 含首尾的天数。 */
export const spanDays = (from: string, to: string) => Math.round((toUtcMs(to) - toUtcMs(from)) / dayMs) + 1

export type DateRange = { from: string; to: string }

/** 上一期：与当前范围等长、紧邻其前的区间。 */
export function previousRange(range: DateRange): DateRange {
  const days = spanDays(range.from, range.to)
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) }
}

/** 去年同期：整体回退一年（闰日回退到 2 月 28 日）。 */
export function yearOverYearRange(range: DateRange): DateRange {
  const shift = (date: string) => {
    const [year, month, day] = date.split('-').map(Number)
    const candidate = new Date(Date.UTC(year - 1, month - 1, day))
    // 2 月 29 日回退一年后不存在，Date 会溢出到 3 月 1 日，这里收回到 2 月 28 日
    if (candidate.getUTCMonth() !== month - 1) return `${year - 1}-02-28`
    return fromUtcMs(candidate.getTime())
  }
  return { from: shift(range.from), to: shift(range.to) }
}

export type RangePreset = { key: string; label: string; range: DateRange }

/** 快捷时间范围，以站点今天为基准（含今天）；“自定义”由日期选择器本身提供。 */
export function rangePresets(today: string): RangePreset[] {
  const [year, month] = today.split('-').map(Number)
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const prevMonthEnd = addDays(monthStart, -1)
  const prevMonthStart = `${prevMonthEnd.slice(0, 7)}-01`
  // 本季：1-3、4-6、7-9、10-12 月，从季度第一个月 1 日到今天
  const quarterStart = `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`
  return [
    { key: 'today', label: '今天', range: { from: today, to: today } },
    { key: 'yesterday', label: '昨天', range: { from: addDays(today, -1), to: addDays(today, -1) } },
    { key: 'last7', label: '近 7 天', range: { from: addDays(today, -6), to: today } },
    { key: 'last14', label: '近 14 天', range: { from: addDays(today, -13), to: today } },
    { key: 'last30', label: '近 30 天', range: { from: addDays(today, -29), to: today } },
    { key: 'last90', label: '近 90 天', range: { from: addDays(today, -89), to: today } },
    { key: 'month', label: '本月', range: { from: monthStart, to: today } },
    { key: 'lastMonth', label: '上月', range: { from: prevMonthStart, to: prevMonthEnd } },
    { key: 'quarter', label: '本季', range: { from: quarterStart, to: today } },
    { key: 'year', label: '本年', range: { from: `${year}-01-01`, to: today } },
  ]
}

/** 对比方式（环比 / 同比 / 自定义区间）推出的对比区间；没有时间范围或自定义没给区间返回 null。 */
export function compareRangeOf(range: DateRange | null, mode: 'none' | 'previous' | 'yoy' | 'custom', custom: DateRange | null = null): DateRange | null {
  if (!range || mode === 'none') return null
  if (mode === 'previous') return previousRange(range)
  if (mode === 'yoy') return yearOverYearRange(range)
  return custom
}
