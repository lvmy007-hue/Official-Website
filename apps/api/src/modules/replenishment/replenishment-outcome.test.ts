import { describe, expect, it } from 'vitest'
import { evaluateOutcome, type DailyPoint } from './replenishment-outcome'

const days = (from: number, to: number, units: number, available: number | null = 100): DailyPoint[] =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ date: `2026-10-${String(from + index).padStart(2, '0')}`, units, inventoryAvailable: available }))

const base = { forecastRate: 10, windowStart: '2026-10-01', windowEnd: '2026-10-10', coverageDays: 30, sellableNow: 500 }

describe('结果回看', () => {
  it('预测误差 = (预测 − 实际) ÷ 实际；预测 100 件、实际 80 件 → +25%', () => {
    const result = evaluateOutcome({ ...base, daily: days(1, 10, 8) })
    expect(result).toMatchObject({ forecastQty: 100, actualQty: 80, errorPct: 0.25, windowDays: 10 })
  })

  it('预测偏低时误差为负', () => {
    expect(evaluateOutcome({ ...base, daily: days(1, 10, 12.5) })?.errorPct).toBe(-0.2)
  })

  it('实际为 0：误差为 null，不除以 0', () => {
    expect(evaluateOutcome({ ...base, daily: days(1, 10, 0) })).toMatchObject({ actualQty: 0, errorPct: null })
  })

  it('断货天数 = 可售恰为 0 的天数；没有库存记录的天不算断货', () => {
    const daily = [...days(1, 6, 8), ...days(7, 9, 8, 0), ...days(10, 10, 8, null)]
    expect(evaluateOutcome({ ...base, daily })?.stockoutDays).toBe(3)
  })

  it('多余库存 = 评估日可售 −（实际日销 × 目标覆盖天数）；不足为 0；没有库存数量为 null', () => {
    expect(evaluateOutcome({ ...base, daily: days(1, 10, 8) })?.excessUnits).toBe(260)
    expect(evaluateOutcome({ ...base, sellableNow: 100, daily: days(1, 10, 8) })?.excessUnits).toBe(0)
    expect(evaluateOutcome({ ...base, sellableNow: null, daily: days(1, 10, 8) })?.excessUnits).toBeNull()
  })

  it('窗口内销量汇总覆盖不足 80% 时不评估', () => {
    expect(evaluateOutcome({ ...base, daily: days(1, 7, 8) })).toBeNull()
    expect(evaluateOutcome({ ...base, daily: days(1, 8, 8) })).not.toBeNull()
  })

  it('只统计窗口内的日期；窗口无效返回 null', () => {
    expect(evaluateOutcome({ ...base, daily: [...days(1, 10, 8), ...days(11, 20, 100)] })?.actualQty).toBe(80)
    expect(evaluateOutcome({ ...base, windowEnd: '2026-09-30', daily: days(1, 10, 8) })).toBeNull()
  })
})
