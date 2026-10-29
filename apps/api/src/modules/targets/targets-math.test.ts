import { describe, expect, it } from 'vitest'
import { achievementRatioOf, elapsedDaysOf, forecastOf, linearRatio, periodEndExclusive, seasonalRatio, totalDaysOf } from './targets-math'

describe('targets-math：期间与节奏线（M-013）', () => {
  it('periodEndExclusive / totalDaysOf：月、季、年', () => {
    expect(periodEndExclusive('MONTH', '2026-10-01').toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(totalDaysOf('MONTH', '2026-10-01')).toBe(31)
    expect(periodEndExclusive('QUARTER', '2026-10-01').toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(totalDaysOf('QUARTER', '2026-10-01')).toBe(92)
    expect(periodEndExclusive('YEAR', '2026-01-01').toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(totalDaysOf('YEAR', '2026-01-01')).toBe(365)
  })

  it('elapsedDaysOf：裁剪到 [0, 总天数]', () => {
    expect(elapsedDaysOf('MONTH', '2026-10-01', '2026-09-15')).toBe(0)
    expect(elapsedDaysOf('MONTH', '2026-10-01', '2026-10-01')).toBe(1)
    expect(elapsedDaysOf('MONTH', '2026-10-01', '2026-10-15')).toBe(15)
    expect(elapsedDaysOf('MONTH', '2026-10-01', '2026-12-01')).toBe(31)
  })

  it('linearRatio：按天均摊', () => {
    expect(linearRatio(15, 30)).toBe(0.5)
    expect(linearRatio(0, 30)).toBe(0)
    expect(linearRatio(30, 30)).toBe(1)
    expect(linearRatio(5, 0)).toBe(0)
  })

  it('seasonalRatio：历史月份天数一致时按日占比累计', () => {
    // 两个历史月份都是 4 天，占比分别为 [0.1,0.2,0.3,0.4] 与 [0.2,0.2,0.3,0.3]，平均后累计到第 2 天
    const hist = [
      [10, 20, 30, 40],
      [20, 20, 30, 30],
    ]
    const ratio = seasonalRatio(hist, 2, 4)
    // 月1 占比 [0.1,0.2,0.3,0.4]，月2 占比 [0.2,0.2,0.3,0.3]；平均 [0.15,0.2,0.3,0.35]；累计前 2 天 = 0.35
    expect(ratio).toBeCloseTo(0.35, 10)
  })

  it('seasonalRatio：没有天数匹配或全为 0 的历史月份时返回 null（调用方应退化为按天均摊）', () => {
    expect(seasonalRatio([[1, 2, 3]], 2, 4)).toBeNull() // 天数不匹配
    expect(seasonalRatio([[0, 0, 0, 0]], 2, 4)).toBeNull() // 全为 0
    expect(seasonalRatio([], 2, 4)).toBeNull()
  })

  it('achievementRatioOf：目标为 0 或负数时无法计算', () => {
    expect(achievementRatioOf(50, 100)).toBe(0.5)
    expect(achievementRatioOf(50, 0)).toBeNull()
    expect(achievementRatioOf(50, -10)).toBeNull()
  })
})

describe('targets-math：预测达成（M-014）', () => {
  it('没有最近日数据时无法预测', () => {
    expect(forecastOf(1000, 10, [], 5000)).toBeNull()
  })

  it('期间已结束（剩余天数为 0）：预测即实际，缺口按实际算', () => {
    expect(forecastOf(1000, 0, [100, 200], 900)).toEqual({ median: 1000, low: 1000, high: 1000, gap: -100 })
  })

  it('按最近日均 / 最低 / 最高值 × 剩余天数估算中位值与区间', () => {
    const result = forecastOf(1000, 10, [80, 100, 120], 2200)
    expect(result?.median).toBeCloseTo(1000 + 100 * 10, 6)
    expect(result?.low).toBeCloseTo(1000 + 80 * 10, 6)
    expect(result?.high).toBeCloseTo(1000 + 120 * 10, 6)
    expect(result?.gap).toBeCloseTo(2200 - (1000 + 100 * 10), 6)
  })
})
