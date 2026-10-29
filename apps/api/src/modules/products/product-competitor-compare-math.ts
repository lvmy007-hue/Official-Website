import type { Asin360CompareSeriesPoint } from '@nova/api-contracts'

// ASIN 360 竞品对比（P6-21）的纯计算：把带时间的取值收成“每天一个值”（同一天取最后一条），再按日期合并成并列的序列。

export interface Timed {
  at: Date
  value: number
}

const dayOf = (at: Date) => at.toISOString().slice(0, 10)

/** 同一天取最后一条；入参必须按时间从早到晚排列。 */
export function lastPerDay(items: readonly Timed[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const item of items) result.set(dayOf(item.at), item.value)
  return result
}

export interface SeriesInput {
  price: ReadonlyMap<string, number>
  rank: ReadonlyMap<string, number>
  rating: ReadonlyMap<string, number>
  ratingCount: ReadonlyMap<string, number>
}

/** 只保留至少有一项取值的日期，日期从早到晚。 */
export function mergeSeries(input: SeriesInput): Asin360CompareSeriesPoint[] {
  const dates = new Set<string>([...input.price.keys(), ...input.rank.keys(), ...input.rating.keys(), ...input.ratingCount.keys()])
  return [...dates].sort().map(date => ({
    date,
    price: input.price.get(date) ?? null,
    rank: input.rank.get(date) ?? null,
    rating: input.rating.get(date) ?? null,
    ratingCount: input.ratingCount.get(date) ?? null,
  }))
}

/** 每项各自取最近一个有值的日期的值（不要求同一天）。 */
export function latestOfSeries(points: readonly Asin360CompareSeriesPoint[]): { price: number | null; rank: number | null; rating: number | null; ratingCount: number | null } {
  const last = <K extends 'price' | 'rank' | 'rating' | 'ratingCount'>(key: K) => {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const value = points[index]?.[key]
      if (value !== null && value !== undefined) return value
    }
    return null
  }
  return { price: last('price'), rank: last('rank'), rating: last('rating'), ratingCount: last('ratingCount') }
}

/** 并列比较的名次必须属于同一个分类：取竞品快照里出现最多的分类（并列时取编号小的），没有竞品名次才用我方的。 */
export function pickClassification(competitor: readonly (string | null)[], own: readonly string[]): string | null {
  const count = (list: readonly (string | null)[]) => {
    const map = new Map<string, number>()
    for (const id of list) if (id) map.set(id, (map.get(id) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  }
  return count(competitor) ?? count(own)
}
