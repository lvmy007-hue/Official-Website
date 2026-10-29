import { describe, expect, it } from 'vitest'
import { lastPerDay, latestOfSeries, mergeSeries, pickClassification } from './product-competitor-compare-math'
import { buildCompareRows } from './product-compare-math'
import type { ProductDay } from './product-overview-math'

const day = (over: Partial<ProductDay> = {}): ProductDay => ({ units: 10, sales: 200, sessions: 100, adsSpend: 20, adsSales: 60, profit: 50, ...over })

describe('同环比明细', () => {
  it('每个指标输出本期、对比期、变化比率与变化量；利润率的变化量是小数差', () => {
    const rows = buildCompareRows({ current: { total: day(), has: true }, previous: { total: day({ sales: 100, units: 5, profit: 10 }), has: true }, canSeeProfit: true })
    expect(rows.map(row => row.metric)).toEqual(['sales', 'units', 'unitPrice', 'sessions', 'conversion', 'adsSpend', 'adsSales', 'profit', 'margin'])
    expect(rows[0]).toMatchObject({ value: 200, prevValue: 100, changeRate: 1, changeValue: 100 })
    expect(rows[2]).toMatchObject({ value: 20, prevValue: 20, changeRate: 0, changeValue: 0 })
    const margin = rows[8]!
    expect(margin.value).toBeCloseTo(0.25)
    expect(margin.prevValue).toBeCloseTo(0.1)
    expect(margin.changeValue).toBeCloseTo(0.15)
  })

  it('对比期为 0 时没有变化比率；没有选对比期时对比列全空', () => {
    const rows = buildCompareRows({ current: { total: day(), has: true }, previous: { total: day({ profit: 0 }), has: true }, canSeeProfit: true })
    expect(rows[7]).toMatchObject({ value: 50, prevValue: 0, changeRate: null, changeValue: 50 })
    const none = buildCompareRows({ current: { total: day(), has: true }, previous: null, canSeeProfit: true })
    expect(none.every(row => row.prevValue === null && row.changeRate === null && row.changeValue === null)).toBe(true)
    expect(none[0]?.note).toBeNull()
  })

  it('没有接入的列是尚未接入，本期没有订单是没有数据，利润列没有权限是受限；对比期没有记录给出说明', () => {
    const rows = buildCompareRows({ current: { total: day({ sessions: null, adsSpend: null, adsSales: null, profit: null }), has: true }, previous: { total: day(), has: false }, canSeeProfit: true })
    expect(rows.find(row => row.metric === 'sessions')).toMatchObject({ value: null, state: 'NOT_CONNECTED' })
    expect(rows.find(row => row.metric === 'profit')).toMatchObject({ value: null, state: 'NOT_CONNECTED' })
    expect(rows[0]).toMatchObject({ state: 'OK', prevValue: null, note: '对比期没有这项记录，无法计算变化' })
    const empty = buildCompareRows({ current: { total: day(), has: false }, previous: null, canSeeProfit: false })
    expect(empty.find(row => row.metric === 'sales')).toMatchObject({ state: 'NO_DATA', value: null })
    expect(empty.find(row => row.metric === 'profit')?.state).toBe('RESTRICTED')
    expect(empty.find(row => row.metric === 'margin')?.state).toBe('RESTRICTED')
  })
})

describe('竞品对比的序列', () => {
  it('同一天取最后一条，日期合并后从早到晚，只保留有取值的日期', () => {
    const price = lastPerDay([
      { at: new Date('2026-10-01T01:00:00Z'), value: 10 },
      { at: new Date('2026-10-01T23:00:00Z'), value: 11 },
      { at: new Date('2026-10-03T00:00:00Z'), value: 12 },
    ])
    const rank = lastPerDay([{ at: new Date('2026-10-02T00:00:00Z'), value: 5 }])
    const points = mergeSeries({ price, rank, rating: new Map(), ratingCount: new Map() })
    expect(points.map(point => point.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(points[0]).toMatchObject({ price: 11, rank: null })
    expect(latestOfSeries(points)).toEqual({ price: 12, rank: 5, rating: null, ratingCount: null })
  })

  it('名次分类：竞品里出现最多的分类优先，并列取编号小的，没有竞品名次才用我方的', () => {
    expect(pickClassification(['b', 'a', 'b', null], ['z'])).toBe('b')
    expect(pickClassification(['b', 'a'], [])).toBe('a')
    expect(pickClassification([null], ['z', 'z', 'y'])).toBe('z')
    expect(pickClassification([], [])).toBeNull()
  })
})
