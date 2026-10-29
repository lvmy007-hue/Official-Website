import { EVENT_TYPES, type EventItem, type EventType } from '@nova/api-contracts'

// 事件带的纯函数（P6-06）：把事件落到图的横轴类目上，同一类型同一类目的事件合并成一个点。
// 契约里只取 events.ts 的类型与常量（不带 zod）。

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS)

/** 图的横轴是不是按天递增的日期（事件带只配日期轴；周、月起始日也是日期，按桶归并）。 */
export function eventRange(categories: readonly string[]): { from: string; to: string } | null {
  const first = categories[0]
  const last = categories[categories.length - 1]
  if (!first || !last || !DAY.test(first) || !DAY.test(last) || first > last) return null
  return { from: first, to: last }
}

/** 相邻类目之间的天数中位数：日图是 1，周图是 7，月图约 30。 */
function stepDays(categories: readonly string[]): number {
  const gaps: number[] = []
  for (let i = 1; i < categories.length; i++) {
    const a = categories[i - 1]!
    const b = categories[i]!
    if (DAY.test(a) && DAY.test(b)) gaps.push(dayNumber(b) - dayNumber(a))
  }
  if (gaps.length === 0) return 1
  gaps.sort((x, y) => x - y)
  return Math.max(1, gaps[Math.floor(gaps.length / 2)]!)
}

/** 事件的日期落在哪个类目：日图必须同一天；周图、月图落在“开始日不晚于事件日”的最后一个桶，超出最后一个桶的范围就不画。 */
export function categoryIndexOfDay(categories: readonly string[], day: string, step = stepDays(categories)): number {
  const exact = categories.indexOf(day)
  if (exact >= 0) return exact
  if (step <= 1 || !DAY.test(day)) return -1
  let found = -1
  for (const [index, category] of categories.entries()) {
    if (category <= day) found = index
    else break
  }
  const last = categories[categories.length - 1]
  if (found < 0 || !last || !DAY.test(last)) return -1
  return dayNumber(day) < dayNumber(last) + step ? found : -1
}

export interface BandPoint {
  type: EventType
  index: number
  category: string
  items: EventItem[]
  /** 圆点上显示的数字：同一点只有一个事件时为 null。 */
  count: number | null
  /** 无障碍名称与悬停提示：一个事件显示标题，多个显示“N 个事件”。 */
  label: string
}

/** 按类型与类目合并事件；隐藏的类型不出现；图上画不下的（日期不在横轴范围内）单独计数。 */
export function placeEvents(categories: readonly string[], items: readonly EventItem[], hidden: ReadonlySet<EventType>): { points: BandPoint[]; outside: number } {
  const step = stepDays(categories)
  const map = new Map<string, BandPoint>()
  let outside = 0
  for (const item of items) {
    if (hidden.has(item.type)) continue
    const index = categoryIndexOfDay(categories, item.day, step)
    if (index < 0) {
      outside += 1
      continue
    }
    const key = `${item.type}|${index}`
    const point = map.get(key)
    if (point) point.items.push(item)
    else map.set(key, { type: item.type, index, category: categories[index]!, items: [item], count: null, label: item.title })
  }
  const points = [...map.values()].map(point => {
    const many = point.items.length > 1
    return {
      ...point,
      items: [...point.items].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0)),
      count: many ? point.items.length : null,
      label: many ? `${point.items.length} 个事件` : point.label,
    }
  })
  points.sort((a, b) => EVENT_TYPES.indexOf(a.type) - EVENT_TYPES.indexOf(b.type) || a.index - b.index)
  return { points, outside }
}

/** 圆点在事件带上的水平位置（百分比）：折线图留白时点在格子中间，贴边时从 0 排到 100。 */
export function bandPosition(index: number, count: number, boundaryGap: boolean): number {
  if (count <= 1) return 50
  return boundaryGap ? ((index + 0.5) / count) * 100 : (index / (count - 1)) * 100
}
