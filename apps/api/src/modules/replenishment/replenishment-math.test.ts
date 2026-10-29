import { describe, expect, it } from 'vitest'
import { demand, TODAY } from '../inventory/inventory-fixtures.test-helper'
import { adjustDemand, periodRates, roundUpTo, splitTransport, stddev, zScore, type ModeLead } from './replenishment-math'

describe('服务水平系数 z', () => {
  it('常用服务水平对应标准正态分位数', () => {
    expect(zScore(0.5)).toBeCloseTo(0, 6)
    expect(zScore(0.9)).toBeCloseTo(1.2816, 3)
    expect(zScore(0.95)).toBeCloseTo(1.6449, 3)
    expect(zScore(0.99)).toBeCloseTo(2.3263, 3)
    expect(zScore(0.05)).toBeCloseTo(-1.6449, 3)
  })

  it('服务水平必须在 0 与 1 之间', () => {
    expect(() => zScore(1)).toThrow(RangeError)
    expect(() => zScore(0)).toThrow(RangeError)
  })
})

describe('日销波动', () => {
  it('四个时段日均的总体标准差；空数组为 0', () => {
    expect(stddev([10, 10, 10, 10])).toBe(0)
    expect(stddev([8, 12])).toBe(2)
    expect(stddev([])).toBe(0)
  })

  it('历史满 90 天给四个时段；历史不足的时段不算，少于 3 个时段返回 null', () => {
    expect(periodRates(demand())).toEqual([10, 230 / 23, 10, 10])
    expect(periodRates(demand({ historyDays: 45 }))).toBeNull()
    expect(periodRates(demand({ historyDays: 60 }))).toHaveLength(3)
    expect(periodRates(demand({ units7: null }))).toBeNull()
  })

  it('亚马逊报告来源按历史充足处理', () => {
    expect(periodRates(demand({ source: 'AMAZON_REPORT', historyDays: null }))).toHaveLength(4)
  })
})

describe('第 1 步：需求调整', () => {
  const sub = { forecastNext30: 90, shippedUnitsPrevMonth: 60, prevMonthDays: 30, snapshotDate: TODAY, eligibility: 'ELIGIBLE' }

  it('没有日销预测时无法调整', () => {
    expect(adjustDemand(demand({ mid: null }), null, TODAY)).toBeNull()
  })

  it('近 7 天与近 30 天持平：趋势系数 1，数值不变', () => {
    const result = adjustDemand(demand(), null, TODAY)
    expect(result).toMatchObject({ low: 8, mid: 10, high: 12, trendFactor: 1, subscribe: { used: false } })
    expect(result?.notes.join('')).toContain('尚无订阅省数据')
  })

  it('趋势系数 = 1 + 0.5 ×（比值 − 1），限制在 0.8–1.25', () => {
    expect(adjustDemand(demand({ units7: 140, units30: 300 }), null, TODAY)?.trendFactor).toBe(1.25)
    expect(adjustDemand(demand({ units7: 7, units30: 300 }), null, TODAY)?.trendFactor).toBe(0.8)
    expect(adjustDemand(demand({ units7: 84, units30: 300 }), null, TODAY)?.trendFactor).toBe(1.1)
  })

  it('订单历史不足 30 天不做趋势调整', () => {
    const result = adjustDemand(demand({ historyDays: 20, units7: 140 }), null, TODAY)
    expect(result?.trendFactor).toBe(1)
    expect(result?.notes.join('')).toContain('不做趋势调整')
  })

  it('订阅省：扣掉上月订阅日均，再加未来 30 天订阅日均', () => {
    const result = adjustDemand(demand(), sub, TODAY)
    // 历史日销 10 − 上月订阅日均 2 + 未来订阅日均 3 = 11
    expect(result).toMatchObject({ mid: 11, low: 9, high: 13, subscribe: { used: true, subRate: 3, histRate: 2 } })
  })

  it.each([
    ['快照超过 7 天', { ...sub, snapshotDate: '2026-10-10' }, '已超过 7 天'],
    ['报价不可订阅', { ...sub, eligibility: 'INELIGIBLE' }, '不可订阅'],
    ['缺少未来预测', { ...sub, forecastNext30: null }, '没有给出未来 30 天'],
    ['缺少上月出货', { ...sub, shippedUnitsPrevMonth: null }, '缺少上月订阅出货'],
  ])('订阅省不叠加：%s，并写明原因', (_name, input, text) => {
    const result = adjustDemand(demand(), input, TODAY)
    expect(result?.subscribe.used).toBe(false)
    expect(result?.mid).toBe(10)
    expect(result?.notes.join('')).toContain(text)
  })

  it('扣除后不会出现负日销', () => {
    expect(adjustDemand(demand({ low: 1, mid: 1, high: 1 }), { ...sub, forecastNext30: 0, shippedUnitsPrevMonth: 300, prevMonthDays: 30 }, TODAY)?.mid).toBe(0)
  })
})

describe('箱规取整', () => {
  it('向上取整到箱规的整数倍；没有箱规取整到件；非正数为 0', () => {
    expect(roundUpTo(441, 10)).toBe(450)
    expect(roundUpTo(440, 10)).toBe(440)
    expect(roundUpTo(12.2, null)).toBe(13)
    expect(roundUpTo(12.2, 1)).toBe(13)
    expect(roundUpTo(0, 10)).toBe(0)
    expect(roundUpTo(-5, 10)).toBe(0)
  })
})

describe('第 7 步：运输方式拆分', () => {
  const sea: ModeLead = { mode: 'SEA', leadDays: 50, unitCost: 0.5 }
  const air: ModeLead = { mode: 'AIR', leadDays: 25, unitCost: 2 }
  const express: ModeLead = { mode: 'EXPRESS', leadDays: 15, unitCost: 4 }
  const base = { qty: 1000, coverDays: 20, mid: 10, preference: 'AUTO' as const, casePack: null }

  it('没有数量或没有运输选项：不拆分', () => {
    expect(splitTransport({ ...base, qty: 0, modes: [sea] }).parts).toEqual([])
    expect(splitTransport({ ...base, modes: [] }).parts).toEqual([])
  })

  it('只有一种方式或固定偏好：全部走该方式', () => {
    expect(splitTransport({ ...base, modes: [sea] }).parts).toEqual([{ mode: 'SEA', qty: 1000 }])
    expect(splitTransport({ ...base, preference: 'AIR', modes: [sea, air] }).parts).toEqual([{ mode: 'AIR', qty: 1000 }])
  })

  it('成本没设全：无法比较，全部走最快的', () => {
    expect(splitTransport({ ...base, modes: [sea, { ...air, unitCost: null }] }).parts).toEqual([{ mode: 'AIR', qty: 1000 }])
  })

  it('最便宜的方式能在断货前到仓：全部走它', () => {
    expect(splitTransport({ ...base, coverDays: 60, modes: [sea, air] }).parts).toEqual([{ mode: 'SEA', qty: 1000 }])
  })

  it('最便宜的方式来不及：用来得及的更快方式补缺口，其余走最便宜', () => {
    // 海运 50 天，断货 20 天后；空运 25 天仍晚于断货，快递 15 天来得及 → 快递补位
    const result = splitTransport({ ...base, modes: [sea, air, express] })
    // 缺口 = 10 ×（50 − max(20, 15)）= 300
    expect(result.parts).toEqual([
      { mode: 'EXPRESS', qty: 300 },
      { mode: 'SEA', qty: 700 },
    ])
    expect(result.note).toContain('先用EXPRESS补 300 件')
  })

  it('没有任何方式来得及断货前到仓：补位取最快，并说明', () => {
    const result = splitTransport({ ...base, coverDays: 5, modes: [sea, air] })
    expect(result.parts[0]).toMatchObject({ mode: 'AIR' })
    expect(result.note).toContain('补位方式也来不及')
  })

  it('补位数量按箱规取整，且不超过总量', () => {
    const result = splitTransport({ ...base, qty: 200, casePack: 40, modes: [sea, express] })
    expect(result.parts).toEqual([{ mode: 'EXPRESS', qty: 200 }])
  })
})
