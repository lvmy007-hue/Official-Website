import { type PriceCompare, type PriceCompareSide } from './pricing.js'

// 调价前后对照的纯计算（P4-11）：把销售与流量日表（ASIN 子体粒度）的若干天折成一侧的汇总。
// 规则：同一天有两个来源时优先数据中心（DATA_KIOSK），不重复相加；日销量只用有销量的天数做分母；转化率只用“销量与会话同一行都有值”的行相除；
// 购物车获得率按会话加权（没有会话的行不参与）；官方没给的值为 null（不是 0），整侧一天数据都没有时返回 null。

export interface TrafficDay {
  /** YYYY-MM-DD */
  date: string
  source: string
  units: number | null
  sessions: number | null
  /** 0 到 1 的小数 */
  buyBoxPct: number | null
}

const PREFERRED_SOURCE = 'DATA_KIOSK'
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

export function compareSideOf(rows: readonly TrafficDay[]): PriceCompareSide | null {
  const byDate = new Map<string, TrafficDay>()
  for (const row of rows) {
    const kept = byDate.get(row.date)
    if (!kept || (kept.source !== PREFERRED_SOURCE && row.source === PREFERRED_SOURCE)) byDate.set(row.date, row)
  }
  const days = [...byDate.values()]
  if (days.length === 0) return null
  const withUnits = days.filter(day => day.units !== null)
  const withSessions = days.filter(day => day.sessions !== null)
  const both = days.filter(day => day.units !== null && day.sessions !== null && day.sessions > 0)
  const bothSessions = both.reduce((sum, day) => sum + (day.sessions ?? 0), 0)
  const weighted = days.filter(day => day.buyBoxPct !== null && (day.sessions ?? 0) > 0)
  const weight = weighted.reduce((sum, day) => sum + (day.sessions ?? 0), 0)
  return {
    days: days.length,
    unitsPerDay: withUnits.length > 0 ? round6(withUnits.reduce((sum, day) => sum + (day.units ?? 0), 0) / withUnits.length) : null,
    sessions: withSessions.length > 0 ? withSessions.reduce((sum, day) => sum + (day.sessions ?? 0), 0) : null,
    conversionPct: bothSessions > 0 ? round6(both.reduce((sum, day) => sum + (day.units ?? 0), 0) / bothSessions) : null,
    buyBoxPct: weight > 0 ? round6(weighted.reduce((sum, day) => sum + (day.buyBoxPct ?? 0) * (day.sessions ?? 0), 0) / weight) : null,
  }
}

/** 调价前后对照：改价后观察期未满给“等待”；两侧都没有数据给“没有数据”。 */
export function priceCompareOf(input: { changedAt: Date; now: Date; observeDays: number; before: PriceCompareSide | null; after: PriceCompareSide | null }): PriceCompare {
  const waitMs = input.observeDays * 86_400_000
  if (input.now.getTime() - input.changedAt.getTime() < waitMs) {
    return { state: 'WAITING', note: `改价后满 ${input.observeDays} 天才能对照（销售与流量数据有延迟）`, before: input.before, after: null }
  }
  if (!input.before && !input.after) return { state: 'NO_DATA', note: '改价前后都没有这个商品的销售与流量数据', before: null, after: null }
  return { state: 'OK', note: null, before: input.before, after: input.after }
}
