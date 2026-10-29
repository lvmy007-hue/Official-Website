import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'

// ASIN 360 的“广告”页签（P3-19）：权限先于参数校验也先于读数据、商品不在数据范围内是 404、店铺没绑广告账户时整页“尚未接入”且不读任何广告业务表、日期不合法是 422。
// 取数与口径的真实查询在 apps/api/src/testing/products-ads.db.test.ts；纯函数细节在 modules/ads/ads-asin-tab-math.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  asin: 'B0TEST0001',
  sellerSku: 'SKU-1',
  title: '示例商品',
  sellerAccount: { displayName: '店铺一' },
  ...over,
})

const BUSINESS = ['adsAdvertisedProductMetric', 'adsConvertedProductDaily', 'adsAd', 'adsAdGroup', 'adsCampaign', 'adsTarget', 'adsKeyword', 'adsTermMetric', 'adsMetric', 'asinDailySummary'] as const

function stub(permissions: string[], over: Record<string, any> = {}) {
  const tables = Object.fromEntries(
    BUSINESS.map(name => [
      name,
      { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), groupBy: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({ _sum: {} }) },
    ]),
  )
  return prismaFor(permissions, {
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    fbaProduct: { findFirst: vi.fn().mockResolvedValue(product()) },
    adsProfile: { findMany: vi.fn().mockResolvedValue([]) },
    ...tables,
    ...over,
  })
}

async function call(permissions: string[], path: string, over: Record<string, any> = {}) {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { res: await harness.call('GET', path), prisma }
}

const FULL = ['products.read', 'ads.read']
const untouched = (prisma: ReturnType<typeof stub>) => BUSINESS.every(name => (prisma as any)[name].findMany.mock.calls.length === 0 && (prisma as any)[name].groupBy.mock.calls.length === 0)

describe('权限：先于参数校验，也先于读数据', () => {
  it('没有 ads.read：403，坏参数也不会先看到 422，也不读业务表和商品', async () => {
    const { res, prisma } = await call(['products.read'], '/products/p1/ads?from=bad&to=bad')
    expect(res.status).toBe(403)
    expect(prisma.fbaProduct.findFirst).not.toHaveBeenCalled()
    expect(prisma.adsProfile.findMany).not.toHaveBeenCalled()
    expect(untouched(prisma)).toBe(true)
  })

  it('没有 products.read：403', async () => {
    const { res, prisma } = await call(['ads.read'], '/products/p1/ads')
    expect(res.status).toBe(403)
    expect(prisma.fbaProduct.findFirst).not.toHaveBeenCalled()
  })
})

describe('商品与日期', () => {
  it('商品不在成员数据范围内或不存在：404，不读广告表', async () => {
    const { res, prisma } = await call(FULL, '/products/p1/ads', { fbaProduct: { findFirst: vi.fn().mockResolvedValue(null) } })
    expect(res.status).toBe(404)
    expect(prisma.fbaProduct.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p1', tenantId: 'tenant-1', marketplaceId: 'ATVPDKIKX0DER' })
    expect(prisma.adsProfile.findMany).not.toHaveBeenCalled()
  })

  it('日期不合法：422（通过权限与商品后才校验），不读广告表', async () => {
    const { res, prisma } = await call(FULL, '/products/p1/ads?from=nope&to=2026-10-10')
    expect(res.status).toBe(422)
    expect(prisma.adsProfile.findMany).not.toHaveBeenCalled()
  })
})

describe('店铺没有绑定广告账户', () => {
  it('整页“尚未接入”：说明原因，所有块为空，品牌分析缺口也是尚未接入；只查店铺绑定，不读广告业务表', async () => {
    const { res, prisma } = await call(FULL, '/products/p1/ads?from=2026-10-01&to=2026-10-03')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'NOT_CONNECTED', currency: 'USD', range: { from: '2026-10-01', to: '2026-10-03', defaulted: false } })
    expect(data.note).toContain('没有绑定')
    expect(data.summary.totals.spend).toBeNull()
    expect(data.summary.totalSales).toBeNull()
    for (const key of ['campaigns', 'adGroups', 'targets', 'searchTerms']) expect(data[key]).toMatchObject({ state: 'NOT_CONNECTED', items: [], truncated: false })
    expect(data.halo).toMatchObject({ state: 'NOT_CONNECTED', sales: null })
    expect(data.brandGaps.state).toBe('NOT_CONNECTED')
    expect(data.stock).toMatchObject({ stock: 'UNKNOWN', sellable: null, spend: null })
    expect(data.sharedNote).toBeTruthy()
    expect(prisma.adsProfile.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', sellerAccountId: 's1' })
    expect(untouched(prisma)).toBe(true)
  })

  it('不选日期：默认最近 30 天并写明', async () => {
    const { res } = await call(FULL, '/products/p1/ads')
    expect(res.json.data.range.defaulted).toBe(true)
  })
})
