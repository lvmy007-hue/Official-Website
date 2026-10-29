import { describe, expect, it } from 'vitest'
import { bandOf, detectAnomalies, hourKey, predictStockout, sameWeekdayHourSamples, sumUntil, type HourPoint } from './today-math'

const h = (iso: string, units: number, pageViews: number | null = null, salesAmount = units * 10): HourPoint => ({
  hourStart: new Date(iso),
  units,
  salesAmount,
  pageViews,
})

describe('今日实时计算', () => {
  it('同星期几同小时样本与区间带', () => {
    const target = new Date('2026-10-22T15:00:00Z') // 周四
    const history = [h('2026-10-15T15:00:00Z', 10, 100), h('2026-10-08T15:00:00Z', 4, 40), h('2026-10-01T15:00:00Z', 8, 80), h('2026-09-24T15:00:00Z', 6, 60), h('2026-10-15T14:00:00Z', 99, 999)]
    const samples = sameWeekdayHourSamples(history, target)
    expect(samples.map(s => s.units).sort((a, b) => a - b)).toEqual([4, 6, 8, 10])
    expect(bandOf(samples)).toEqual({ unitsMin: 4, unitsMax: 10, pageViewsMin: 40, pageViewsMax: 100 })
  })

  it('低于区间下限标为异常', () => {
    const hour = new Date('2026-10-22T15:00:00Z')
    const byAsin = new Map([[hourKey('B1', hour), h(hour.toISOString(), 2, 10)]])
    const history = new Map([['B1', [h('2026-10-15T15:00:00Z', 10, 100), h('2026-10-08T15:00:00Z', 8, 80), h('2026-10-01T15:00:00Z', 9, 90), h('2026-09-24T15:00:00Z', 7, 70)]]])
    const hits = detectAnomalies(byAsin, history)
    expect(hits.some(hit => hit.metric === 'sales' && hit.value === 2)).toBe(true)
    expect(hits.some(hit => hit.metric === 'traffic')).toBe(true)
  })

  it('断货外推：库存不足以覆盖剩余小时预计销量时返回时刻', () => {
    const hourlyAvg = new Map([
      [16, 5],
      [17, 5],
      [18, 5],
    ])
    const at = predictStockout({
      availableQty: 8,
      now: new Date('2026-10-22T15:30:00Z'),
      dayEndExclusive: new Date('2026-10-23T00:00:00Z'),
      hourlyAvgUnits: hourlyAvg,
    })
    expect(at?.toISOString()).toBe('2026-10-22T17:00:00.000Z')
    expect(predictStockout({ availableQty: 100, now: new Date('2026-10-22T15:30:00Z'), dayEndExclusive: new Date('2026-10-23T00:00:00Z'), hourlyAvgUnits: hourlyAvg })).toBeNull()
  })

  it('累计截至某时刻', () => {
    const points = [h('2026-10-22T10:00:00Z', 1, null, 10), h('2026-10-22T11:00:00Z', 2, null, 20), h('2026-10-22T12:00:00Z', 3, null, 30)]
    expect(sumUntil(points, new Date('2026-10-22T12:00:00Z'))).toEqual({ units: 3, salesAmount: 30 })
  })
})
