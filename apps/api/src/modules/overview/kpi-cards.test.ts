import { describe, expect, it } from 'vitest'
import { ZERO_DAY, type DayValues } from './aggregate'
import { buildKpiCards, type KpiInput } from './kpi-cards'

const day = (patch: Partial<DayValues>): DayValues => ({ ...ZERO_DAY, ...patch })
const input = (patch: Partial<KpiInput> = {}): KpiInput => ({
  current: day({ sales: 1200, orders: 10, units: 12 }),
  currentHasRows: true,
  previous: day({ sales: 1000 }),
  previousHasRows: true,
  daily: new Map([['2026-10-01', day({ sales: 500 })]]),
  days: ['2026-10-01', '2026-10-02'],
  canSeeProfit: true,
  anomalies: { critical: 0, warning: 0, info: 0 },
  ...patch,
})
const byKey = (cards: ReturnType<typeof buildKpiCards>) => Object.fromEntries(cards.map(item => [item.key, item]))

describe('7 个指标卡', () => {
  it('固定 7 张，顺序与名称符合 04 章 4.1', () => {
    expect(buildKpiCards(input()).map(item => item.label)).toEqual(['销售额', '净利润', '利润率', '广告花费', '广告占总销售比', '可售天数风险数', '待处理异常数'])
  })

  it('销售额：数值、对比期变化与逐日走势；缺行的日子按 0', () => {
    const sales = byKey(buildKpiCards(input())).sales!
    expect(sales).toMatchObject({ state: 'OK', value: 1200, compareValue: 1000, changeKind: 'ratio' })
    expect(sales.change).toBeCloseTo(0.2)
    expect(sales.trend).toEqual([500, 0])
  })

  it('没有任何汇总行：销售额是“尚无记录”，值为空而不是 0', () => {
    const sales = byKey(buildKpiCards(input({ current: day({}), currentHasRows: false, daily: new Map() }))).sales!
    expect(sales).toMatchObject({ state: 'NO_DATA', value: null, trend: null })
    expect(sales.note).toContain('没有订单记录')
  })

  it('对比期没有汇总行：不给对比值与变化，并说明', () => {
    const sales = byKey(buildKpiCards(input({ previousHasRows: false, previous: day({}) }))).sales!
    expect(sales).toMatchObject({ state: 'OK', compareValue: null, change: null })
    expect(sales.note).toContain('对比期')
  })

  it('利润、广告、库存尚未接入：状态为“尚未接入”，数值为空，不是 0', () => {
    const cards = byKey(buildKpiCards(input()))
    for (const key of ['profit', 'margin', 'adsSpend', 'adsShare', 'stockRisk'] as const) {
      expect(cards[key], key).toMatchObject({ state: 'NOT_CONNECTED', value: null, change: null, trend: null })
      expect(cards[key]!.note, key).toBeTruthy()
    }
  })

  it('没有“利润”字段权限：净利润与利润率为受限，且不带任何数值（即使库里已有利润）', () => {
    const cards = byKey(buildKpiCards(input({ canSeeProfit: false, current: day({ sales: 100, profit: 30 }), previous: day({ sales: 80, profit: 20 }) })))
    for (const key of ['profit', 'margin'] as const) expect(cards[key], key).toMatchObject({ state: 'RESTRICTED', value: null, compareValue: null, change: null, trend: null })
  })

  it('有利润时：净利润、利润率（百分点差）、广告占总销售比（广告花费 ÷ 销售额）', () => {
    const cards = byKey(
      buildKpiCards(
        input({
          current: day({ sales: 1000, profit: 200, adsSpend: 100 }),
          previous: day({ sales: 800, profit: 120, adsSpend: 120 }),
          daily: new Map([['2026-10-01', day({ sales: 500, profit: 100, adsSpend: 50 })]]),
        }),
      ),
    )
    expect(cards.profit).toMatchObject({ state: 'OK', value: 200, compareValue: 120 })
    expect(cards.profit!.change).toBeCloseTo(0.6667, 3)
    expect(cards.margin).toMatchObject({ state: 'OK', value: 0.2, changeKind: 'points' })
    expect(cards.margin!.change).toBeCloseTo(0.05)
    expect(cards.adsShare!.value).toBeCloseTo(0.1)
    expect(cards.adsShare!.change).toBeCloseTo(0.1 - 0.15)
    expect(cards.margin!.trend).toEqual([0.2, null])
  })

  it('销售额为 0 时利润率与广告占比为空并说明，不显示成 0%', () => {
    const cards = byKey(buildKpiCards(input({ current: day({ sales: 0, profit: 5, adsSpend: 3 }), previous: null })))
    expect(cards.margin).toMatchObject({ state: 'OK', value: null })
    expect(cards.margin!.note).toContain('销售额为 0')
    expect(cards.adsShare).toMatchObject({ value: null })
  })

  it('待处理异常数：真实计数，附严重度构成；为 0 时如实说明', () => {
    expect(byKey(buildKpiCards(input({ anomalies: { critical: 1, warning: 2, info: 3 } }))).anomalies).toMatchObject({ state: 'OK', value: 6, note: '严重 1 · 警告 2 · 提示 3' })
    const none = byKey(buildKpiCards(input())).anomalies!
    expect(none.value).toBe(0)
    expect(none.note).toContain('没有待处理的预警')
  })

  it('每张卡都有下钻目标', () => {
    expect(buildKpiCards(input()).every(item => item.drill.endsWith('Page'))).toBe(true)
  })
})
