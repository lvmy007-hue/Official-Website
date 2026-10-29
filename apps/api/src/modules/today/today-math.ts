// 今日实时纯计算（P2a-03，metrics.md M-100～M-105）：区间带、异常、断货外推。不含数据库。

const HOUR_MS = 3_600_000
const BAND_WEEKS = 4

export type HourPoint = { hourStart: Date; units: number; salesAmount: number; pageViews: number | null }

/** 过去 N 个同星期几、同一小时的样本（不含当天）。 */
export function sameWeekdayHourSamples(history: readonly HourPoint[], target: Date, weeks = BAND_WEEKS): HourPoint[] {
  const targetDow = target.getUTCDay()
  const targetHour = target.getUTCHours()
  const out: HourPoint[] = []
  for (let week = 1; week <= weeks; week += 1) {
    const at = new Date(target.getTime() - week * 7 * 24 * HOUR_MS)
    if (at.getUTCDay() !== targetDow || at.getUTCHours() !== targetHour) continue
    const hit = history.find(row => row.hourStart.getTime() === at.getTime())
    if (hit) out.push(hit)
  }
  return out
}

export function bandOf(samples: readonly HourPoint[]): {
  unitsMin: number
  unitsMax: number
  pageViewsMin: number | null
  pageViewsMax: number | null
} | null {
  if (samples.length === 0) return null
  const units = samples.map(s => s.units)
  const views = samples.map(s => s.pageViews).filter((v): v is number => v != null)
  return {
    unitsMin: Math.min(...units),
    unitsMax: Math.max(...units),
    pageViewsMin: views.length ? Math.min(...views) : null,
    pageViewsMax: views.length ? Math.max(...views) : null,
  }
}

export type AnomalyHit = {
  asin: string
  hourStart: Date
  metric: 'sales' | 'traffic'
  value: number
  bandMin: number
}

/** 当小时销售或流量低于历史同时段区间下限时标红（M-104）。 */
export function detectAnomalies(byAsinHour: ReadonlyMap<string, HourPoint>, historyByAsin: ReadonlyMap<string, HourPoint[]>): AnomalyHit[] {
  const hits: AnomalyHit[] = []
  for (const [key, point] of byAsinHour) {
    const asin = key.slice(0, key.indexOf('|'))
    const history = historyByAsin.get(asin) ?? []
    const samples = sameWeekdayHourSamples(history, point.hourStart)
    const band = bandOf(samples)
    if (!band) continue
    if (point.units < band.unitsMin) {
      hits.push({ asin, hourStart: point.hourStart, metric: 'sales', value: point.units, bandMin: band.unitsMin })
    }
    if (point.pageViews != null && band.pageViewsMin != null && point.pageViews < band.pageViewsMin) {
      hits.push({ asin, hourStart: point.hourStart, metric: 'traffic', value: point.pageViews, bandMin: band.pageViewsMin })
    }
  }
  return hits
}

/**
 * 预计今日断货（M-105）：当前可售 ÷ 当日剩余小时的预计销量（按过去 4 个同星期几同小时分布外推）。
 * 返回预计断货的本地小时起点（UTC Date）；库存充足返回 null。
 */
export function predictStockout(input: {
  availableQty: number
  now: Date
  dayEndExclusive: Date
  /** 过去同星期几各小时的平均销量（key = UTC hour 0-23） */
  hourlyAvgUnits: ReadonlyMap<number, number>
}): Date | null {
  if (input.availableQty <= 0) return input.now
  let remaining = input.availableQty
  const cursor = new Date(input.now)
  cursor.setUTCMinutes(0, 0, 0)
  if (cursor < input.now) cursor.setTime(cursor.getTime() + HOUR_MS)
  while (cursor < input.dayEndExclusive) {
    const avg = input.hourlyAvgUnits.get(cursor.getUTCHours()) ?? 0
    if (avg <= 0) {
      cursor.setTime(cursor.getTime() + HOUR_MS)
      continue
    }
    if (remaining <= avg) return cursor
    remaining -= avg
    cursor.setTime(cursor.getTime() + HOUR_MS)
  }
  return null
}

/** 累加到（不含）某个时刻的 units / sales。 */
export function sumUntil(points: readonly HourPoint[], untilExclusive: Date): { units: number; salesAmount: number } {
  let units = 0
  let salesAmount = 0
  for (const point of points) {
    if (point.hourStart >= untilExclusive) continue
    units += point.units
    salesAmount += point.salesAmount
  }
  return { units, salesAmount }
}

export const hourKey = (asin: string, hourStart: Date) => `${asin}|${hourStart.toISOString()}`
