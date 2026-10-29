import { describe, expect, it } from 'vitest'
import type { AdsTotals } from '@nova/api-contracts'
import { buildAdsCards, NOTE_NEVER, type CardInput } from './ads-overview-cards'
import { mixPoints, productRows } from './ads-overview-series'

const totals = (patch: Partial<AdsTotals> = {}): AdsTotals => ({ impressions: 1000, clicks: 50, spend: 25, sales: 100, orders: 5, ...patch })
const days = ['2026-10-01', '2026-10-02']

const input = (patch: Partial<CardInput> = {}): CardInput => ({
  everHadData: true,
  hasRows: true,
  current: totals(),
  previous: totals({ spend: 20, sales: 100 }),
  previousHasRows: true,
  days,
  daily: new Map([['2026-10-01', totals()]]),
  store: { hasRows: true, current: { sales: 500, adsSpend: 25, adsSales: 100 }, previous: null, previousHasRows: false, daily: new Map() },
  budget: { state: 'NO_DATA', note: '没有带日预算的活动记录', utilization: null },
  anomalyCount: 2,
  anomalyState: 'OK',
  anomalyNote: null,
  unboundSpend: null,
  ...patch,
})
const find = (cards: ReturnType<typeof buildAdsCards>, key: string) => cards.find(card => card.key === key)!

describe('广告控制台指标卡', () => {
  it('变化：金额类用比率，百分比类用百分点差；趋势里没有行的日子为空', () => {
    const cards = buildAdsCards(input())
    expect(find(cards, 'spend')).toMatchObject({ value: 25, compareValue: 20, change: 0.25, changeKind: 'ratio' })
    expect(find(cards, 'acos')).toMatchObject({ value: 0.25, compareValue: 0.2, changeKind: 'points' })
    expect(find(cards, 'acos').change).toBeCloseTo(0.05, 9)
    expect(find(cards, 'spend').trend).toEqual([25, null])
  })

  it('没有对比期汇总行：不给变化', () => {
    const cards = buildAdsCards(input({ previousHasRows: false }))
    expect(find(cards, 'spend')).toMatchObject({ compareValue: null, change: null })
  })

  it('没有广告销售额：ACoS 是 OK 但值为空并写原因（不是 0）', () => {
    const cards = buildAdsCards(input({ current: totals({ sales: 0, orders: 0 }) }))
    expect(find(cards, 'acos')).toMatchObject({ state: 'OK', value: null, note: expect.stringContaining('没有广告销售额') })
    expect(find(cards, 'roas')).toMatchObject({ state: 'OK', value: 0 })
  })

  it('从来没有广告数据：全部广告指标尚未接入，写同一句原因', () => {
    const cards = buildAdsCards(input({ everHadData: false, hasRows: false }))
    for (const key of ['spend', 'sales', 'acos', 'roas', 'ctr', 'cpc', 'cvr']) expect(find(cards, key), key).toMatchObject({ state: 'NOT_CONNECTED', value: null, note: NOTE_NEVER })
    expect(find(cards, 'haloSales').state).toBe('NOT_CONNECTED')
  })

  it('广告归因销售额大于店铺销售额：自然销售额不推算（不出现负数）', () => {
    const cards = buildAdsCards(input({ store: { hasRows: true, current: { sales: 80, adsSpend: 25, adsSales: 100 }, previous: null, previousHasRows: false, daily: new Map() } }))
    expect(find(cards, 'organicSales')).toMatchObject({ state: 'OK', value: null })
    expect(find(cards, 'organicSales').note).toContain('无法推算')
    expect(find(cards, 'adsShare').value).toBeCloseTo(25 / 80, 9)
  })

  it('已绑定店铺没有广告花费记录：广告占总销售比与自然销售额都“尚无记录”', () => {
    const cards = buildAdsCards(input({ store: { hasRows: true, current: { sales: 500, adsSpend: null, adsSales: null }, previous: null, previousHasRows: false, daily: new Map() } }))
    expect(find(cards, 'adsShare')).toMatchObject({ state: 'NO_DATA', value: null })
    expect(find(cards, 'organicSales')).toMatchObject({ state: 'NO_DATA', value: null })
  })

  it('预算与异常：沿用各自区域的状态', () => {
    const cards = buildAdsCards(input({ budget: { state: 'OK', note: '估算', utilization: 0.8 } }))
    expect(find(cards, 'budgetUtilization')).toMatchObject({ state: 'OK', value: 0.8, note: '估算' })
    expect(find(cards, 'anomalies')).toMatchObject({ state: 'OK', value: 2 })
  })
})

describe('广告控制台序列装配', () => {
  it('广告产品结构：未识别类型并入“其他”，占比按花费合计', () => {
    const rows = productRows([
      { date: '2026-10-01', adProduct: 'SPONSORED_PRODUCTS', totals: totals({ spend: 30 }) },
      { date: '2026-10-01', adProduct: 'UNKNOWN', totals: totals({ spend: 10 }) },
    ])
    expect(rows.map(row => row.adProduct)).toEqual(['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY', 'SPONSORED_TELEVISION', 'OTHER'])
    expect(rows[0]).toMatchObject({ spend: 30, spendShare: 0.75 })
    expect(rows[4]).toMatchObject({ state: 'OK', label: '其他（未识别类型）', spendShare: 0.25 })
  })

  it('总销售拆分：广告归因大于总销售时自然销售额为空；没有花费时广告占比为空', () => {
    const points = mixPoints(
      days,
      new Map([
        ['2026-10-01', { sales: 80, adsSpend: 10, adsSales: 100 }],
        ['2026-10-02', { sales: 50, adsSpend: null, adsSales: null }],
      ]),
      'day',
    )
    expect(points).toEqual([
      { key: '2026-10-01', totalSales: 80, adSales: 100, organicSales: null, adSpend: 10, adsShare: 0.125 },
      { key: '2026-10-02', totalSales: 50, adSales: null, organicSales: null, adSpend: null, adsShare: null },
    ])
  })
})
