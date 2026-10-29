import { STORE_LEVEL_SKU, type AllocationBasis, type ProfitBasis } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { allocateAds, splitMicro, type AllocationInput } from './ads-allocation'
import { assembleProfit, type AssembleInput, type ProfitRow } from './assemble'
import type { AdsAttribution, AdsInfo, SalesRow } from './types'

// 广告分摊（P3-16）：先按广告商品报表归属到 ASIN，剩余按销售额或销量分摊；各 SKU 分摊额之和加未分摊额恰好等于账户总花费。

const micro = (value: number) => Math.round(value * 1_000_000)
const sumOf = (result: ReturnType<typeof allocateAds>) => micro(result.unallocated) + [...result.bySku.values()].reduce((acc, value) => acc + micro(value), 0)
const input = (over: Partial<AllocationInput> = {}): AllocationInput => ({ total: 100, basis: 'BY_SALES', direct: new Map(), rows: [], asinSkus: new Map(), ...over })
const row = (sku: string, asin: string | null, revenue: number, units: number) => ({ sku, asin, revenue, units })

describe('splitMicro：最大余数法，份额之和恰好等于总额', () => {
  it('不能整除时余数按小数部分从大到小补一', () => {
    expect(splitMicro(10, [1, 1, 1])).toEqual([4, 3, 3])
    expect(splitMicro(100, [1, 2])).toEqual([33, 67])
    expect(splitMicro(5, [0, 0])).toEqual([3, 2])
  })
  it('权重为 0 的份额得到 0；空权重返回空数组', () => {
    expect(splitMicro(9, [0, 3, 6])).toEqual([0, 3, 6])
    expect(splitMicro(9, [])).toEqual([])
  })
  it('任意权重下份额之和都等于总额', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const weights = Array.from({ length: (seed % 7) + 1 }, (_, index) => ((seed * 31 + index * 17) % 13) + (index % 3 === 0 ? 0.37 : 0))
      const total = 1_000_003 + seed * 7919
      expect(splitMicro(total, weights).reduce((acc, part) => acc + part, 0)).toBe(total)
    }
  })
})

describe('allocateAds', () => {
  it('没有广告商品报表：全部花费按销售额分摊到当天有销售的 SKU', () => {
    const result = allocateAds(input({ rows: [row('A', 'B0A', 300, 3), row('B', 'B0B', 100, 9)] }))
    expect(result.bySku.get('A')).toBe(75)
    expect(result.bySku.get('B')).toBe(25)
    expect(result.unallocated).toBe(0)
    expect(result.exceeded).toBe(false)
  })

  it('按销量分摊：权重换成件数', () => {
    const result = allocateAds(input({ basis: 'BY_UNITS', rows: [row('A', 'B0A', 300, 3), row('B', 'B0B', 100, 9)] }))
    expect(result.bySku.get('A')).toBe(25)
    expect(result.bySku.get('B')).toBe(75)
  })

  it('先按广告商品报表归属到 ASIN，剩余的再按规则分摊', () => {
    const result = allocateAds(input({ total: 100, direct: new Map([['B0A', 40]]), rows: [row('A', 'B0A', 100, 1), row('B', 'B0B', 100, 1)] }))
    // A 先得 40，剩余 60 两个 SKU 各 30
    expect(result.bySku.get('A')).toBe(70)
    expect(result.bySku.get('B')).toBe(30)
    expect(result.unallocated).toBe(0)
  })

  it('同一个 ASIN 有多个 SKU：归属的花费按规则在它们之间分', () => {
    const result = allocateAds(input({ total: 50, direct: new Map([['B0A', 50]]), rows: [row('A1', 'B0A', 100, 1), row('A2', 'B0A', 300, 3), row('B', 'B0B', 999, 9)] }))
    expect(result.bySku.get('A1')).toBe(12.5)
    expect(result.bySku.get('A2')).toBe(37.5)
    expect(result.bySku.has('B')).toBe(false)
  })

  it('归属的 ASIN 当天没有销售行：用商品目录对照找到 SKU，并标记为新出现的 SKU', () => {
    const result = allocateAds(input({ total: 30, direct: new Map([['B0Z', 30]]), rows: [row('B', 'B0B', 100, 1)], asinSkus: new Map([['B0Z', ['Z2', 'Z1']]]) }))
    expect(result.bySku.get('Z1')).toBe(15)
    expect(result.bySku.get('Z2')).toBe(15)
    expect(result.addedAsins.get('Z1')).toBe('B0Z')
    expect(result.unallocated).toBe(0)
  })

  it('归属的 ASIN 找不到 SKU：并入剩余部分一起分摊，并如实记录金额', () => {
    const result = allocateAds(input({ total: 100, direct: new Map([['B0X', 20]]), rows: [row('B', 'B0B', 100, 1)] }))
    expect(result.bySku.get('B')).toBe(100)
    expect(result.unmapped).toBe(20)
  })

  it('广告商品报表合计超过账户总花费：按比例缩小到总花费，并标记', () => {
    const result = allocateAds(
      input({
        total: 100,
        direct: new Map([
          ['B0A', 90],
          ['B0B', 90],
        ]),
        rows: [row('A', 'B0A', 1, 1), row('B', 'B0B', 1, 1)],
      }),
    )
    expect(result.exceeded).toBe(true)
    expect(result.bySku.get('A')).toBe(50)
    expect(result.bySku.get('B')).toBe(50)
    expect(result.unallocated).toBe(0)
  })

  it('当天没有任何可分摊的销售：花费全部留在“未分摊”，不丢也不凭空分', () => {
    const none = allocateAds(input({ rows: [] }))
    expect(none.bySku.size).toBe(0)
    expect(none.unallocated).toBe(100)
    const zeroSales = allocateAds(input({ rows: [row('A', 'B0A', 0, 0)] }))
    expect(zeroSales.unallocated).toBe(100)
  })

  it('销售额为 0 的行不分摊（按销量时看件数）', () => {
    expect(allocateAds(input({ rows: [row('A', 'B0A', 0, 5), row('B', 'B0B', 10, 1)] })).bySku.has('A')).toBe(false)
    expect(allocateAds(input({ basis: 'BY_UNITS', rows: [row('A', 'B0A', 0, 5), row('B', 'B0B', 10, 0)] })).bySku.get('A')).toBe(100)
  })

  it('验收：各 SKU 分摊额之和 + 未分摊额 = 账户总花费（含除不尽的金额、各种口径与归属组合）', () => {
    const cases: AllocationInput[] = []
    for (const basis of ['BY_SALES', 'BY_UNITS'] as AllocationBasis[]) {
      for (const total of [0.01, 1, 33.333333, 100, 1234.56789, 99999.999999]) {
        for (const direct of [
          new Map<string, number>(),
          new Map([['B0A', total / 3]]),
          new Map([
            ['B0A', total / 7],
            ['B0Q', total / 5],
          ]),
          new Map([['B0A', total * 2]]),
        ]) {
          cases.push({ total, basis, direct, rows: [row('A', 'B0A', 111.11, 3), row('B', 'B0B', 222.22, 7), row('C', 'B0A', 33.33, 1)], asinSkus: new Map([['B0Q', ['Q']]]) })
          cases.push({ total, basis, direct, rows: [], asinSkus: new Map([['B0Q', ['Q']]]) })
        }
      }
    }
    for (const item of cases) expect(sumOf(allocateAds(item))).toBe(micro(item.total))
  })
})

describe('装配里的广告分摊', () => {
  const STORE = 'store-1'
  const DAY = '2026-09-05'
  const sale = (over: Partial<SalesRow> = {}): SalesRow => ({ sellerAccountId: STORE, sku: 'SKU-A', asin: 'B0A', day: DAY, currency: 'USD', units: 10, revenue: 200, ...over })
  const info = (byDay: Array<[string, number]>, first = '2026-09-01', last = '2026-09-30'): Map<string, AdsInfo> => new Map([[STORE, { first, last, byDay: new Map(byDay), nonUsd: false }]])
  const attribution = (direct: Array<[string, string, number]>, skus: Array<[string, string[]]> = []): AdsAttribution => ({
    direct: new Map([[STORE, direct.reduce((days, [day, asin, spend]) => days.set(day, new Map([...(days.get(day) ?? []), [asin, spend]])), new Map<string, Map<string, number>>())]]),
    asinSkus: new Map([[STORE, new Map(skus)]]),
  })
  const run = (over: Partial<AssembleInput> = {}, basis: ProfitBasis = 'ORDERED'): ProfitRow[] =>
    assembleProfit({
      basis,
      costing: 'FIFO',
      costingValid: true,
      range: { from: '2026-09-01', to: '2026-09-30' },
      today: '2026-10-23',
      sales: [sale()],
      fees: [],
      streams: new Map(),
      draftOnly: new Set(),
      fx: () => ({ rate: 1, source: 'SAME_CURRENCY', carriedForward: false }),
      ads: new Map(),
      ...over,
    })
  const find = (rows: ProfitRow[], sku: string, day = DAY) => rows.find(item => item.sku === sku && item.profitDate === day)
  const total = (rows: ProfitRow[], day = DAY) => rows.filter(item => item.profitDate === day).reduce((acc, item) => acc + (item.adsSpendAllocated ?? 0) + (item.adsUnallocated ?? 0), 0)

  it('归属 + 剩余：A 先得报表归属的 40，剩余 60 按销售额分；店铺级行没有未分摊，也没有“广告未分摊”标记', () => {
    const rows = run({
      sales: [sale({ revenue: 100, units: 1 }), sale({ sku: 'SKU-B', asin: 'B0B', revenue: 100, units: 1 })],
      ads: info([[DAY, 100]]),
      attribution: attribution([[DAY, 'B0A', 40]]),
    })
    expect(find(rows, 'SKU-A')).toMatchObject({ adsSpendAllocated: 70 })
    expect(find(rows, 'SKU-B')).toMatchObject({ adsSpendAllocated: 30 })
    expect(find(rows, STORE_LEVEL_SKU)).toMatchObject({ adsUnallocated: 0 })
    expect(find(rows, STORE_LEVEL_SKU)!.flags).not.toContain('ADS_UNALLOCATED')
    expect(total(rows)).toBeCloseTo(100, 6)
  })

  it('利润扣掉分摊的广告：有成本覆盖时 SKU 行利润 = 销售额 - 成本 - 广告', () => {
    const rows = run({ ads: info([[DAY, 20]]), streams: new Map([['SKU-A', { product: [{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 100 }], firstMile: [], other: [] }]]) })
    expect(find(rows, 'SKU-A')).toMatchObject({ revenue: 200, productCost: 50, adsSpendAllocated: 20, profit: 130 })
  })

  it('按销量分摊：规则按天取（传入的函数决定当天用哪种）', () => {
    const sales = [sale({ revenue: 300, units: 1 }), sale({ sku: 'SKU-B', asin: 'B0B', revenue: 100, units: 3 })]
    const bySales = run({ sales, ads: info([[DAY, 40]]) })
    expect(find(bySales, 'SKU-A')!.adsSpendAllocated).toBe(30)
    const byUnits = run({ sales, ads: info([[DAY, 40]]), adsBasis: () => 'BY_UNITS' })
    expect(find(byUnits, 'SKU-A')!.adsSpendAllocated).toBe(10)
    expect(find(byUnits, 'SKU-B')!.adsSpendAllocated).toBe(30)
  })

  it('有花费但当天没有销售：归属的 ASIN 通过商品目录生成 SKU 行（亏损如实显示）；对不上的留在店铺级行并标“广告未分摊”', () => {
    const rows = run({
      sales: [],
      ads: info([[DAY, 50]]),
      attribution: attribution([[DAY, 'B0Z', 30]], [['B0Z', ['SKU-Z']]]),
    })
    expect(find(rows, 'SKU-Z')).toMatchObject({ asin: 'B0Z', adsSpendAllocated: 30, units: 0, profit: -30 })
    expect(find(rows, STORE_LEVEL_SKU)).toMatchObject({ adsUnallocated: 20 })
    expect(find(rows, STORE_LEVEL_SKU)!.flags).toContain('ADS_UNALLOCATED')
    expect(total(rows)).toBeCloseTo(50, 6)
  })

  it('报表归属超出账户总花费、归属的 ASIN 对不上 SKU：店铺级行带上对应标记', () => {
    const exceeded = run({ ads: info([[DAY, 10]]), attribution: attribution([[DAY, 'B0A', 30]]) })
    expect(find(exceeded, 'SKU-A')!.adsSpendAllocated).toBe(10)
    expect(find(exceeded, STORE_LEVEL_SKU)!.flags).toContain('ADS_ATTRIBUTION_EXCEEDS')
    const unmapped = run({ ads: info([[DAY, 10]]), attribution: attribution([[DAY, 'B0X', 4]]) })
    expect(find(unmapped, 'SKU-A')!.adsSpendAllocated).toBe(10)
    expect(find(unmapped, STORE_LEVEL_SKU)!.flags).toContain('ADS_ASIN_UNMAPPED')
  })

  it('三种口径各自分摊，每种口径下总额都等于账户总花费', () => {
    for (const basis of ['ORDERED', 'SHIPPED', 'SETTLED'] as ProfitBasis[]) {
      const rows = run({ sales: [sale({ revenue: 33.33, units: 3 }), sale({ sku: 'SKU-B', asin: 'B0B', revenue: 66.67, units: 4 })], ads: info([[DAY, 7.77]]) }, basis)
      expect(total(rows)).toBeCloseTo(7.77, 6)
    }
  })

  it('广告未接入或范围之外：SKU 行的广告列保持为空，不是 0', () => {
    expect(find(run(), 'SKU-A')!.adsSpendAllocated).toBeNull()
    const outside = run({ ads: info([['2026-09-02', 5]], '2026-09-01', '2026-09-03') })
    expect(find(outside, 'SKU-A')!.adsSpendAllocated).toBeNull()
  })
})
