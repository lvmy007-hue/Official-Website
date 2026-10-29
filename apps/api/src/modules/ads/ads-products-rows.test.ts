import { describe, expect, it } from 'vitest'
import type { AsinFact, ProfileStore, ReportGroup } from './ads-products-load'
import { aggregateGroups, rowOf } from './ads-products-rows'

// 广告商品行装配（P3-09，纯函数）：同一店铺下多个广告档案合成一行、活动数去重、未绑定店铺不猜、自然销售额与光环销售的空值语义。

const totals = (spend: number | null, sales: number | null, clicks = 10) => ({ impressions: 100, clicks, spend, sales, orders: sales ? 2 : 0 })
const group = (adsProfileId: string, asin: string, campaignId: string, spend: number | null, sales: number | null): ReportGroup => ({ adsProfileId, asin, campaignId, totals: totals(spend, sales) })
const stores = new Map<string, ProfileStore>([
  ['p-us', { storeId: 's1', storeName: '店铺一' }],
  ['p-ca', { storeId: 's1', storeName: '店铺一' }],
  ['p-free', { storeId: null, storeName: null }],
])
const noFacts = { totalSales: new Map<string, number>(), halo: new Map<string, number>(), ads: new Map<string, { enabled: number; total: number }>(), facts: new Map<string, AsinFact>() }

describe('aggregateGroups', () => {
  it('同一店铺的两个广告档案推广同一 ASIN 合成一行；活动数按“档案 × 活动”去重', () => {
    const rows = aggregateGroups([group('p-us', 'B0A', 'c1', 10, 40), group('p-us', 'B0A', 'c2', 5, 0), group('p-ca', 'B0A', 'c1', 3, 9), group('p-us', 'B0A', 'c1', 1, 1)], stores)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 's1|B0A', storeId: 's1', campaigns: 3, totals: { spend: 19, sales: 50, clicks: 40, orders: 6 } })
  })

  it('同一 ASIN 在不同店铺是不同的行；未绑定店铺的档案单独一行（键位用 -）', () => {
    const rows = aggregateGroups([group('p-us', 'B0A', 'c1', 10, 40), group('p-free', 'B0A', 'c9', 7, 7)], stores)
    expect(rows.map(row => row.key).sort()).toEqual(['-|B0A', 's1|B0A'])
    expect(rows.find(row => row.storeId === null)).toMatchObject({ storeName: null, totals: { spend: 7 } })
  })

  it('档案不在映射里（读不到店铺）按未绑定处理，不猜；按花费从高到低、花费为空的在最后、并列按 ASIN', () => {
    const rows = aggregateGroups([group('p-us', 'B0C', 'c1', 5, 1), group('p-us', 'B0B', 'c1', 20, 1), group('p-us', 'B0A', 'c1', 5, 1), group('p-ghost', 'B0Z', 'c1', null, null)], stores)
    expect(rows.map(row => row.asin)).toEqual(['B0B', 'B0A', 'B0C', 'B0Z'])
    expect(rows.at(-1)).toMatchObject({ storeId: null, totals: { spend: null } })
  })
})

describe('rowOf', () => {
  const [row] = aggregateGroups([group('p-us', 'B0A', 'c1', 40, 160)], stores)

  it('配齐全部销售额、光环、广告数与库存：占比、自然销售额、断货', () => {
    const result = rowOf(row!, {
      totalSales: new Map([['s1|B0A', 400]]),
      halo: new Map([['s1|B0A', 25]]),
      ads: new Map([['s1|B0A', { enabled: 2, total: 3 }]]),
      facts: new Map([['s1|B0A', { title: '瑜伽垫', imageUrl: 'https://img/x.png', sellable: 0, snapshotDate: '2026-10-22' }]]),
    })
    expect(result).toMatchObject({
      title: '瑜伽垫',
      totalSales: 400,
      adsShare: 0.1,
      organicSales: 240,
      organicIssue: null,
      haloSales: 25,
      ads: { enabled: 2, total: 3 },
      stock: 'OUT_OF_STOCK',
      sellable: 0,
      snapshotDate: '2026-10-22',
      ratios: { acos: 0.25 },
    })
  })

  it('什么都没有：总销售额、自然销售额、光环、广告数、库存全部为空，不是 0', () => {
    expect(rowOf(row!, noFacts)).toMatchObject({ title: null, totalSales: null, adsShare: null, organicSales: null, organicIssue: null, haloSales: null, ads: null, stock: 'UNKNOWN', sellable: null })
  })

  it('广告销售额大于全部销售额：不给自然销售额并标出原因，占比照算', () => {
    const result = rowOf(row!, { ...noFacts, totalSales: new Map([['s1|B0A', 100]]) })
    expect(result).toMatchObject({ totalSales: 100, adsShare: 0.4, organicSales: null, organicIssue: 'ATTRIBUTION_EXCEEDS_TOTAL' })
  })

  it('未绑定店铺：即使别的店铺有同 ASIN 的销售与库存也不借用', () => {
    const [free] = aggregateGroups([group('p-free', 'B0A', 'c1', 40, 160)], stores)
    const result = rowOf(free!, { ...noFacts, totalSales: new Map([['s1|B0A', 400]]), facts: new Map([['s1|B0A', { title: '别人的', imageUrl: null, sellable: 9, snapshotDate: '2026-10-22' }]]) })
    expect(result).toMatchObject({ storeId: null, title: null, totalSales: null, stock: 'UNKNOWN' })
  })
})
