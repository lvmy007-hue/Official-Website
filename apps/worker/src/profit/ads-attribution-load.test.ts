import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { loadAdsAttribution, loadAllocationBasis } from './ads-attribution-load'

// 广告分摊取数（P3-16）：只用已绑定店铺的美元档案；花费为空或为 0 的行不算；ASIN → SKU 对照只为报表里出现过的 ASIN 读取；规则按天取生效版本。

type Db = Parameters<typeof loadAdsAttribution>[0]
const d = (value: string) => new Date(`${value}T00:00:00Z`)
const money = (value: number | null) => (value === null ? null : { toString: () => String(value) })

function fakeDb(input: {
  profiles?: Array<{ id: string; sellerAccountId: string | null }>
  sums?: Array<{ adsProfileId: string; advertisedAsin: string; reportDate: Date; spend: number | null }>
  products?: Array<{ sellerAccountId: string; asin: string; sellerSku: string }>
  versions?: Array<{ effectiveFrom: Date; adsAllocationMode: string }>
}) {
  const productsQuery = vi.fn(async (args: { where: { sellerAccountId: string; asin: { in: string[] } } }) =>
    (input.products ?? []).filter(row => row.sellerAccountId === args.where.sellerAccountId && args.where.asin.in.includes(row.asin)),
  )
  const groupBy = vi.fn(async () =>
    (input.sums ?? []).map(row => ({ adsProfileId: row.adsProfileId, advertisedAsin: row.advertisedAsin, reportDate: row.reportDate, _sum: { spend: money(row.spend) } })),
  )
  const profileQuery = vi.fn(async () => input.profiles ?? [])
  const db = {
    adsProfile: { findMany: profileQuery },
    adsAdvertisedProductMetric: { groupBy },
    fbaProduct: { findMany: productsQuery },
    financePolicyVersion: { findMany: vi.fn(async () => input.versions ?? []) },
  }
  return { db: db as unknown as Db & Pick<PrismaClient, 'financePolicyVersion'>, groupBy, productsQuery, profileQuery }
}

describe('loadAdsAttribution', () => {
  it('没有已绑定店铺的美元档案：不读报表也不读商品目录', async () => {
    const { db, groupBy, productsQuery } = fakeDb({ profiles: [] })
    const out = await loadAdsAttribution(db, 't1', { from: '2026-10-01', to: '2026-10-10' })
    expect(out.direct.size).toBe(0)
    expect(groupBy).not.toHaveBeenCalled()
    expect(productsQuery).not.toHaveBeenCalled()
  })

  it('按 店铺 × 日 × ASIN 合计，两个档案绑同一店铺会合并，花费为空或为 0 的行不算', async () => {
    const { db, groupBy } = fakeDb({
      profiles: [
        { id: 'p1', sellerAccountId: 's1' },
        { id: 'p2', sellerAccountId: 's1' },
        { id: 'p3', sellerAccountId: 's2' },
      ],
      sums: [
        { adsProfileId: 'p1', advertisedAsin: 'A1', reportDate: d('2026-10-05'), spend: 10 },
        { adsProfileId: 'p2', advertisedAsin: 'A1', reportDate: d('2026-10-05'), spend: 2.5 },
        { adsProfileId: 'p1', advertisedAsin: 'A2', reportDate: d('2026-10-05'), spend: 0 },
        { adsProfileId: 'p1', advertisedAsin: 'A3', reportDate: d('2026-10-06'), spend: null },
        { adsProfileId: 'p3', advertisedAsin: 'A1', reportDate: d('2026-10-06'), spend: 4 },
      ],
      products: [
        { sellerAccountId: 's1', asin: 'A1', sellerSku: 'sku-a' },
        { sellerAccountId: 's1', asin: 'A1', sellerSku: 'sku-b' },
        { sellerAccountId: 's2', asin: 'A1', sellerSku: 'sku-z' },
      ],
    })
    const out = await loadAdsAttribution(db, 't1', { from: '2026-10-01', to: '2026-10-10' })
    expect(out.direct.get('s1')?.get('2026-10-05')).toEqual(new Map([['A1', 12.5]]))
    expect(out.direct.get('s1')?.has('2026-10-06')).toBe(false)
    expect(out.direct.get('s2')?.get('2026-10-06')).toEqual(new Map([['A1', 4]]))
    // ASIN → SKU 对照按店铺分开
    expect(out.asinSkus.get('s1')?.get('A1')).toEqual(['sku-a', 'sku-b'])
    expect(out.asinSkus.get('s2')?.get('A1')).toEqual(['sku-z'])
    // 查询范围含结束日当天，且限定企业
    const args = groupBy.mock.calls[0] as unknown as [{ where: { tenantId: string; reportDate: { gte: Date; lt: Date } } }]
    expect(args[0].where.tenantId).toBe('t1')
    expect(args[0].where.reportDate.lt.toISOString()).toBe('2026-10-11T00:00:00.000Z')
  })

  it('报表里没有出现的 ASIN 不读商品目录', async () => {
    const { db, productsQuery } = fakeDb({ profiles: [{ id: 'p1', sellerAccountId: 's1' }], sums: [{ adsProfileId: 'p1', advertisedAsin: 'A1', reportDate: d('2026-10-05'), spend: null }] })
    const out = await loadAdsAttribution(db, 't1', { from: '2026-10-01', to: '2026-10-10' })
    expect(out.direct.size).toBe(0)
    expect(productsQuery).not.toHaveBeenCalled()
  })
})

describe('loadAllocationBasis', () => {
  it('没有任何版本：全部按销售额', async () => {
    const { db } = fakeDb({})
    const basis = await loadAllocationBasis(db, 't1')
    expect(basis('2026-10-05')).toBe('BY_SALES')
  })

  it('按天取生效日不晚于这一天的最新版本（含已被替换的）', async () => {
    const { db } = fakeDb({
      versions: [
        { effectiveFrom: d('2026-01-01'), adsAllocationMode: 'BY_UNITS' },
        { effectiveFrom: d('2026-10-10'), adsAllocationMode: 'BY_SALES' },
      ],
    })
    const basis = await loadAllocationBasis(db, 't1')
    expect(basis('2025-12-31')).toBe('BY_SALES') // 第一个版本生效之前用默认口径
    expect(basis('2026-01-01')).toBe('BY_UNITS')
    expect(basis('2026-10-09')).toBe('BY_UNITS')
    expect(basis('2026-10-10')).toBe('BY_SALES')
  })

  it('取值不合法：退回默认口径，不让一条坏数据拖垮刷新', async () => {
    const { db } = fakeDb({ versions: [{ effectiveFrom: d('2026-01-01'), adsAllocationMode: 'WHATEVER' }] })
    const basis = await loadAllocationBasis(db, 't1')
    expect(basis('2026-10-05')).toBe('BY_SALES')
  })
})
