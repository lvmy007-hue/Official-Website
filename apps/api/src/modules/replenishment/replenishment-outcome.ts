import { daysBetween } from '../inventory'

// 结果回看（06 章 6.2 批次详情）：建议到仓之后，用实际销量对照当时冻结的预测，算预测误差、断货天数与多余库存。
// 窗口 = 批次计算日 到 评估日前一天（含）；窗口里订单汇总的覆盖天数不足 80% 时不评估（返回 null，不拿残缺数据算误差）。

export interface DailyPoint {
  date: string
  units: number
  /** 当日库存可售量；没有记录为 null。 */
  inventoryAvailable: number | null
}

export interface OutcomeInput {
  /** 批次计算时冻结的日销（中档，件/天）。 */
  forecastRate: number
  windowStart: string
  windowEnd: string
  daily: readonly DailyPoint[]
  /** 评估日的可售数量；没有库存记录为 null。 */
  sellableNow: number | null
  coverageDays: number
}

export interface OutcomeCalc {
  forecastQty: number
  actualQty: number
  errorPct: number | null
  stockoutDays: number
  excessUnits: number | null
  windowDays: number
}

export const MIN_COVERAGE_RATIO = 0.8

export function evaluateOutcome(input: OutcomeInput): OutcomeCalc | null {
  const windowDays = daysBetween(input.windowStart, input.windowEnd) + 1
  if (windowDays < 1) return null
  const inside = input.daily.filter(point => point.date >= input.windowStart && point.date <= input.windowEnd)
  if (inside.length < windowDays * MIN_COVERAGE_RATIO) return null
  const actual = inside.reduce((total, point) => total + point.units, 0)
  const forecast = Math.round(input.forecastRate * windowDays)
  const actualRate = actual / inside.length
  return {
    forecastQty: forecast,
    actualQty: actual,
    errorPct: actual > 0 ? Math.round(((forecast - actual) / actual) * 10_000) / 10_000 : null,
    stockoutDays: inside.filter(point => point.inventoryAvailable === 0).length,
    excessUnits: input.sellableNow === null ? null : Math.max(0, Math.floor(input.sellableNow - actualRate * input.coverageDays)),
    windowDays,
  }
}
