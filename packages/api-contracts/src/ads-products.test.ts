import { describe, expect, it } from 'vitest'
import { ADS_ASIN_SORTS, ADS_ASIN_WRITE_PENDING, type AdsAsinRow } from './ads-products'
import { adsAsinKey, compareAsinRows, mergeTotals, organicOf, asinAdsShare, asinMatches, summarizeAsins } from './ads-products-math'
import { AdsAsinListQuerySchema } from './ads-products-query'

const row = (patch: Partial<AdsAsinRow> = {}): AdsAsinRow => ({
  key: adsAsinKey('s1', 'B0AAA'),
  asin: 'B0AAA',
  title: '瑜伽垫 加厚',
  imageUrl: null,
  storeId: 's1',
  storeName: '店铺一',
  totals: { impressions: 1000, clicks: 50, spend: 40, sales: 160, orders: 5 },
  ratios: { acos: 0.25, roas: 4, ctr: 0.05, cpc: 0.8, cvr: 0.1 },
  totalSales: 400,
  adsShare: 0.1,
  organicSales: 240,
  organicIssue: null,
  haloSales: null,
  campaigns: 2,
  ads: null,
  stock: 'IN_STOCK',
  sellable: 12,
  snapshotDate: '2026-10-22',
  ...patch,
})

describe('广告商品纯函数', () => {
  it('行键：未绑定店铺的广告账户用 - 占位，同一 ASIN 在不同店铺是不同的行', () => {
    expect(adsAsinKey('s1', 'B0AAA')).toBe('s1|B0AAA')
    expect(adsAsinKey(null, 'B0AAA')).toBe('-|B0AAA')
    expect(adsAsinKey('s2', 'B0AAA')).not.toBe(adsAsinKey('s1', 'B0AAA'))
  })

  it('自然销售额：全部销售额减广告销售额；缺任一项不给；广告销售额更大时不给数并标出原因，不夹成 0', () => {
    expect(organicOf(400, 160)).toEqual({ value: 240, issue: null })
    expect(organicOf(0.3, 0.1)).toEqual({ value: 0.2, issue: null })
    expect(organicOf(null, 160)).toEqual({ value: null, issue: null })
    expect(organicOf(400, null)).toEqual({ value: null, issue: null })
    expect(organicOf(100, 160)).toEqual({ value: null, issue: 'ATTRIBUTION_EXCEEDS_TOTAL' })
    expect(organicOf(100, 100)).toEqual({ value: 0, issue: null })
  })

  it('广告销售占比：总销售额缺失或不为正时为空', () => {
    expect(asinAdsShare(40, 400)).toBeCloseTo(0.1)
    expect(asinAdsShare(null, 400)).toBeNull()
    expect(asinAdsShare(40, null)).toBeNull()
    expect(asinAdsShare(40, 0)).toBeNull()
  })

  it('合计相加：花费与销售额只要有一边给了就算已知，全空仍是空', () => {
    const empty = { impressions: 1, clicks: 1, spend: null, sales: null, orders: 0 }
    expect(mergeTotals(empty, empty)).toEqual({ impressions: 2, clicks: 2, spend: null, sales: null, orders: 0 })
    expect(mergeTotals(empty, { impressions: 4, clicks: 2, spend: 5, sales: 9, orders: 1 })).toEqual({ impressions: 5, clicks: 3, spend: 5, sales: 9, orders: 1 })
  })

  it('关键字匹配 ASIN 或商品名称，不分大小写；没有关键字全部通过', () => {
    expect(asinMatches(row(), undefined)).toBe(true)
    expect(asinMatches(row(), 'b0aaa')).toBe(true)
    expect(asinMatches(row(), '瑜伽')).toBe(true)
    expect(asinMatches(row({ title: null }), '瑜伽')).toBe(false)
  })

  it('排序：空值不论升降序都在最后，并列按 ASIN 再按行键', () => {
    const a = row({ asin: 'B0A', key: 'k-a', adsShare: 0.2 })
    const b = row({ asin: 'B0B', key: 'k-b', adsShare: null })
    const c = row({ asin: 'B0C', key: 'k-c', adsShare: 0.2 })
    const d = row({ asin: 'B0C', key: 'k-d', adsShare: 0.1 })
    for (const dir of ['asc', 'desc'] as const) {
      const sorted = [c, b, d, a].sort((x, y) => compareAsinRows(x, y, 'adsShare', dir))
      expect(sorted.at(-1)).toBe(b)
    }
    expect([c, d, a].sort((x, y) => compareAsinRows(x, y, 'adsShare', 'desc')).map(item => item.key)).toEqual(['k-a', 'k-c', 'k-d'])
    expect([c, a].sort((x, y) => compareAsinRows(x, y, 'asin', 'asc')).map(item => item.key)).toEqual(['k-a', 'k-c'])
    // 每个排序字段都能比较（比率类取 ratios）
    for (const field of ADS_ASIN_SORTS) expect(typeof compareAsinRows(a, c, field, 'desc')).toBe('number')
    expect(compareAsinRows(row({ ratios: { acos: 0.1, roas: 1, ctr: 0, cpc: 0, cvr: 0 } }), row({ ratios: { acos: 0.3, roas: 1, ctr: 0, cpc: 0, cvr: 0 } }), 'acos', 'asc')).toBeLessThan(0)
  })

  it('汇总：断货只认库存已知且可售为 0 的商品；花费全空时合计为空', () => {
    const rows = [
      row(),
      row({ asin: 'B0B', key: 's1|B0B', stock: 'OUT_OF_STOCK', totals: { impressions: 1, clicks: 1, spend: 12, sales: 0, orders: 0 } }),
      row({ asin: 'B0C', key: 's1|B0C', stock: 'UNKNOWN' }),
    ]
    expect(summarizeAsins(rows)).toEqual({ products: 3, spend: 92, sales: 320, outOfStock: { products: 1, spend: 12 } })
    const blank = row({ totals: { impressions: 0, clicks: 0, spend: null, sales: null, orders: 0 } })
    expect(summarizeAsins([blank])).toEqual({ products: 1, spend: null, sales: null, outOfStock: { products: 0, spend: null } })
    expect(summarizeAsins([])).toEqual({ products: 0, spend: null, sales: null, outOfStock: { products: 0, spend: null } })
  })

  it('按 ASIN 的批量写入暂未提供入口：说明里写明去向', () => {
    expect(ADS_ASIN_WRITE_PENDING.state).toBe('NOT_CONNECTED')
    expect(ADS_ASIN_WRITE_PENDING.note).toContain('批量入口暂未提供')
    expect(ADS_ASIN_WRITE_PENDING.note).not.toContain('P3-17')
  })
})

describe('广告商品查询参数', () => {
  it('默认按花费从高到低；排序字段与库存筛选走白名单；未知参数被拒绝', () => {
    expect(AdsAsinListQuerySchema.parse({}).sort).toEqual({ field: 'spend', dir: 'desc' })
    expect(AdsAsinListQuerySchema.parse({ sort: 'organicSales:asc', stock: 'OUT_OF_STOCK', q: 'B0' })).toMatchObject({ sort: { field: 'organicSales', dir: 'asc' }, stock: 'OUT_OF_STOCK', q: 'B0' })
    expect(AdsAsinListQuerySchema.safeParse({ sort: 'profit:desc' }).success).toBe(false)
    expect(AdsAsinListQuerySchema.safeParse({ stock: 'LOW' }).success).toBe(false)
    expect(AdsAsinListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
  })
})
