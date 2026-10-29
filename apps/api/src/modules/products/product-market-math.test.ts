import { describe, expect, it } from 'vitest'
import type { HotTermRow } from './product-traffic-load'
import { averagePrice, competitorRows, pricingPoints } from './product-market-math'

describe('定价：成交均价与推荐报价获得率', () => {
  const traffic = new Map([['2026-10-02', { date: '2026-10-02', source: 'DATA_KIOSK', sessions: 10, pageViews: 10, units: 1, sales: 1, buyBoxPct: 0.8, unitSessionPct: null }]])

  it('没有记录的日子全是 null；有记录但没卖出的日子件数是 0、均价为空', () => {
    const points = pricingPoints(
      ['2026-10-01', '2026-10-02', '2026-10-03'],
      new Map([
        ['2026-10-02', { units: 4, sales: 80 }],
        ['2026-10-03', { units: 0, sales: 0 }],
      ]),
      traffic,
    )
    expect(points[0]).toEqual({ date: '2026-10-01', units: null, sales: null, avgPrice: null, buyBoxPct: null })
    expect(points[1]).toEqual({ date: '2026-10-02', units: 4, sales: 80, avgPrice: 20, buyBoxPct: 0.8 })
    expect(points[2]).toEqual({ date: '2026-10-03', units: 0, sales: 0, avgPrice: null, buyBoxPct: null })
  })

  it('范围均价 = 销售额合计 ÷ 件数合计，只含有件数的日子；一件没卖出为 null', () => {
    const points = pricingPoints(
      ['2026-10-01', '2026-10-02', '2026-10-03'],
      new Map([
        ['2026-10-01', { units: 1, sales: 10 }],
        ['2026-10-02', { units: 3, sales: 60 }],
        ['2026-10-03', { units: 0, sales: 0 }],
      ]),
      new Map(),
    )
    expect(averagePrice(points)).toBe(17.5)
    expect(averagePrice(pricingPoints(['2026-10-01'], new Map(), new Map()))).toBeNull()
    expect(averagePrice(pricingPoints(['2026-10-03'], new Map([['2026-10-03', { units: 0, sales: 0 }]]), new Map()))).toBeNull()
  })
})

const hot = (searchTerm: string, frequencyRank: number | null, asins: Array<string | null>): HotTermRow => ({
  searchTerm,
  frequencyRank,
  slots: asins.map((asin, index) => ({ asin, title: asin ? `商品 ${asin}` : null, clickShare: asin ? 0.3 - index * 0.1 : null, conversionShare: asin ? 0.2 : null })),
})

describe('竞品：热门搜索词点击份额前三', () => {
  it('标出这个 ASIN、企业里的其他商品与外部商品；只列热门搜索词报告里有的核心词，顺序按核心词', () => {
    const rows = competitorRows(
      ['yoga mat', 'yoga block', 'unknown'],
      [hot('yoga block', 80, ['B0OTH', 'B0SELF', 'B0OWN']), hot('YOGA MAT', 10, ['b0self', 'B0OWN', 'B0OTH'])],
      'B0SELF',
      new Set(['B0OWN']),
    )
    expect(rows.map(row => row.searchTerm)).toEqual(['YOGA MAT', 'yoga block'])
    expect(rows[0]!.selfRank).toBe(1)
    expect(rows[0]!.slots.map(slot => [slot.rank, slot.isSelf, slot.isOwn])).toEqual([
      [1, true, false],
      [2, false, true],
      [3, false, false],
    ])
    expect(rows[1]).toMatchObject({ frequencyRank: 80, selfRank: 2 })
  })

  it('这个 ASIN 不在前三时名次为空；空的名次位不列出', () => {
    const [row] = competitorRows(['a'], [hot('a', null, ['B0X', null, null])], 'B0SELF', new Set())
    expect(row!.selfRank).toBeNull()
    expect(row!.slots).toHaveLength(1)
    expect(row!.frequencyRank).toBeNull()
  })

  it('同一个词在多个部门时取排在前面的一行', () => {
    const [row] = competitorRows(['a'], [hot('a', 5, ['B0FIRST', null, null]), hot('a', 9, ['B0SECOND', null, null])], 'B0SELF', new Set())
    expect(row!.slots[0]!.asin).toBe('B0FIRST')
  })
})
