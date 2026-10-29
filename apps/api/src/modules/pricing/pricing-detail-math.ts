import { PRICING_LIMITS, priceText, type PricingEventRow, type PricingHistoryPoint } from '@nova/api-contracts'

// 定价详情的纯计算（P4-11）：逐日价格曲线（价格类快照只在变化或每天写一次，当天没有新行就是“没变”，按上一值向后延续）与事件列表。

export interface Stamped {
  at: Date
  value: number | null
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10)
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999Z`).getTime()

/** 从第一条观察所在的那天（不早于 historyDays 天前）到今天，每天一个点；某条序列在它第一次被观察之前的日子为 null。 */
export function historyOf(series: { own: readonly Stamped[]; featured: readonly Stamped[]; lowest: readonly Stamped[]; expected: readonly Stamped[] }, now: Date): PricingHistoryPoint[] {
  const all = [...series.own, ...series.featured, ...series.lowest, ...series.expected]
  if (all.length === 0) return []
  const floor = now.getTime() - PRICING_LIMITS.historyDays * 86_400_000
  const first = Math.max(Math.min(...all.map(item => item.at.getTime())), floor)
  const days: string[] = []
  for (let time = Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth(), new Date(first).getUTCDate()); time <= now.getTime(); time += 86_400_000) days.push(dayOf(new Date(time)))
  const cursors = { own: 0, featured: 0, lowest: 0, expected: 0 }
  const last: Record<keyof typeof cursors, number | null> = { own: null, featured: null, lowest: null, expected: null }
  return days.map(day => {
    for (const key of Object.keys(cursors) as Array<keyof typeof cursors>) {
      const rows = series[key]
      while (cursors[key] < rows.length && rows[cursors[key]]!.at.getTime() <= endOfDay(day)) {
        last[key] = rows[cursors[key]]!.value
        cursors[key] += 1
      }
    }
    return { at: day, ownPrice: last.own, featuredPrice: last.featured, lowestPrice: last.lowest, expectedPrice: last.expected }
  })
}

export interface PriceRowLite {
  at: Date
  price: number
  source: string
}
export interface BoxRowLite {
  at: Date
  ownIsFeatured: boolean | null
  source: string
  lostReason: string | null
}

/** 事件：价格变化、改价提交、获得与失去推荐报价、价格健康通知；新的在前，最多 eventsMax 条。 */
export function eventsOf(prices: readonly PriceRowLite[], boxes: readonly BoxRowLite[]): PricingEventRow[] {
  const events: PricingEventRow[] = []
  for (let index = 0; index < prices.length; index += 1) {
    const row = prices[index]!
    const before = prices[index - 1]
    if (row.source === 'WRITE_SUBMITTED')
      events.push({ at: row.at.toISOString(), kind: 'PRICE_WRITE', title: `已提交改价到 ${priceText(row.price)}`, detail: before ? `提交前 ${priceText(before.price)}` : null })
    else if (before && Math.abs(before.price - row.price) >= 0.005)
      events.push({ at: row.at.toISOString(), kind: 'PRICE_CHANGE', title: `价格 ${priceText(before.price)} → ${priceText(row.price)}`, detail: null })
  }
  let featured: boolean | null = null
  for (const row of boxes) {
    if (row.source !== 'SYNC') {
      if (row.lostReason === 'PRICE') events.push({ at: row.at.toISOString(), kind: 'PRICING_HEALTH', title: '因价格失去推荐报价资格', detail: null })
      continue
    }
    if (row.ownIsFeatured === null) continue
    if (featured !== null && row.ownIsFeatured !== featured)
      events.push({ at: row.at.toISOString(), kind: row.ownIsFeatured ? 'FEATURED_GAINED' : 'FEATURED_LOST', title: row.ownIsFeatured ? '获得推荐报价' : '失去推荐报价', detail: null })
    featured = row.ownIsFeatured
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, PRICING_LIMITS.eventsMax)
}

/** 每天的价格与销量点（价格取当天的延续值），供弹性估算；只留两者都有的天。 */
export function priceUnitsPoints(history: readonly PricingHistoryPoint[], units: ReadonlyMap<string, number>): Array<{ price: number; units: number }> {
  return history.flatMap(point => {
    const sold = units.get(point.at)
    return point.ownPrice !== null && sold !== undefined ? [{ price: point.ownPrice, units: sold }] : []
  })
}
