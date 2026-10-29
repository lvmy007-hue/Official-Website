import { describe, expect, it } from 'vitest'
import { TODAY } from '../inventory/inventory-fixtures.test-helper'
import { simulateTrend, type TrendInput } from './replenishment-simulate'

const base: TrendInput = { today: TODAY, sellable: 100, inboundCounted: 0, inboundArrivalDays: 14, dailyDemand: 10, recommended: [], recommendedNote: null, custom: null }

describe('库存走势模拟（90 天）', () => {
  it('没有销量记录：无数据，不画曲线', () => {
    expect(simulateTrend({ ...base, dailyDemand: null })).toMatchObject({ state: 'NO_DATA', points: [], dailyDemand: null })
  })

  it('不补货：库存按日销下降，见底后缺口连续一段', () => {
    const result = simulateTrend(base)
    expect(result.points).toHaveLength(91)
    expect(result.points[0]).toMatchObject({ day: 0, date: TODAY, none: 100 })
    expect(result.points[5].none).toBe(50)
    expect(result.points[10].none).toBe(0)
    expect(result.points[90].none).toBe(0)
    // 第 11 天起每天缺 10 件，到第 90 天共 80 天
    expect(result.stockouts.none).toEqual([{ from: '2026-11-02', to: '2027-01-20', days: 80, shortage: 800 }])
    expect(result.stockouts.recommended).toEqual([])
    expect(result.points[3].recommended).toBeNull()
  })

  it('在途按假设天数一次性到仓，并在假设里写明', () => {
    const result = simulateTrend({ ...base, inboundCounted: 500 })
    // 第 10 天卖光，第 14 天到仓 500
    expect(result.points[13].none).toBe(0)
    expect(result.points[14].none).toBe(490)
    expect(result.assumptions[0]).toContain('14 天后一次性到仓')
    expect(result.stockouts.none[0]).toMatchObject({ from: '2026-11-02', to: '2026-11-04', days: 3, shortage: 30 })
  })

  it('按建议补货：补货批次到仓后断货区间缩短；备注为空', () => {
    const result = simulateTrend({ ...base, recommended: [{ day: 20, qty: 1000 }] })
    // 第 11 天起缺货，第 20 天补货到仓当天即可售，缺货 11–19 天共 9 天
    expect(result.stockouts.recommended).toEqual([{ from: '2026-11-02', to: '2026-11-10', days: 9, shortage: 90 }])
    expect(result.points[20].recommended).toBe(990)
    expect(result.note).toBeNull()
  })

  it('没有可执行建议时备注写明原因，只画不补货曲线', () => {
    const result = simulateTrend({ ...base, recommendedNote: '库存位置已达到目标' })
    expect(result.note).toBe('库存位置已达到目标')
    expect(result.points.every(point => point.recommended === null)).toBe(true)
  })

  it('自定义补货：独立一条曲线与断货区间；超出 90 天的到仓不计', () => {
    const result = simulateTrend({ ...base, custom: { day: 30, qty: 2000 } })
    expect(result.points[30].custom).toBe(1990)
    expect(result.stockouts.custom).toEqual([{ from: '2026-11-02', to: '2026-11-20', days: 19, shortage: 190 }])
    const late = simulateTrend({ ...base, custom: { day: 120, qty: 2000 } })
    expect(late.stockouts.custom).toEqual(late.stockouts.none)
  })

  it('库存一直够用时没有断货区间', () => {
    const result = simulateTrend({ ...base, sellable: 5000 })
    expect(result.stockouts.none).toEqual([])
    expect(result.points[90].none).toBe(4100)
  })

  it('缺货分成两段：到仓前后各一段', () => {
    const result = simulateTrend({
      ...base,
      sellable: 50,
      recommended: [
        { day: 20, qty: 100 },
        { day: 60, qty: 100 },
      ],
    })
    expect(result.stockouts.recommended.length).toBeGreaterThanOrEqual(2)
    expect(result.stockouts.recommended[0].to < result.stockouts.recommended[1].from).toBe(true)
  })
})
