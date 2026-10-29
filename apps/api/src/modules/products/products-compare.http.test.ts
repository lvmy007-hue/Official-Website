import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'

// ASIN 360 锚点长页新增的三个读接口（P6-21）：同环比明细、竞品对比、预警日志。
// 覆盖：权限先于参数校验也先于读数据、商品不在数据范围内是 404、参数不合法是 422、没有来源的列是“尚未接入”而不是 0、利润列没有字段权限是“受限”。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const day = (date: string) => new Date(`${date}T00:00:00Z`)
const dec = (value: number) => ({ toString: () => String(value) })
const RANGE = 'from=2026-10-11&to=2026-10-20&compare=custom&compareFrom=2026-10-01&compareTo=2026-10-10'

const product = {
  id: 'p1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  asin: 'B0TEST0001',
  sellerSku: 'SKU-1',
  title: '示例商品',
  currency: 'USD',
  ownerUserId: null,
  sellerAccount: { displayName: '店铺一' },
}

const summary = (date: string, over: Record<string, unknown> = {}) => ({
  summaryDate: day(date),
  units: 10,
  salesAmount: dec(200),
  sessions: 100,
  adsSpend: dec(20),
  adsSales: dec(60),
  profit: dec(50),
  currency: 'USD',
  metricVersion: 'v1',
  refreshedAt: new Date('2026-10-21T00:00:00Z'),
  ...over,
})
function stub(permissions: string[], over: Record<string, any> = {}) {
  return prismaFor(permissions, {
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    fbaProduct: { findFirst: vi.fn().mockResolvedValue(product), findMany: vi.fn().mockResolvedValue([]) },
    asinDailySummary: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
    watchedAsin: { findMany: vi.fn().mockResolvedValue([]) },
    competitorSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    priceSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    salesRankSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    reviewMetricSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    alertInstance: { findMany: vi.fn().mockResolvedValue([]) },
    alertRead: { findMany: vi.fn().mockResolvedValue([]) },
    fbaInventoryRecord: { findFirst: vi.fn().mockResolvedValue({ id: 'inv-1' }), findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  })
}

async function call(permissions: string[], path: string, over: Record<string, any> = {}) {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { res: await harness.call('GET', path), prisma }
}

const BUSINESS = ['products.read', 'field.profit']

describe('权限、范围与参数', () => {
  it.each([
    ['/products/p1/compare', ['field.profit'], 'products.read'],
    ['/products/p1/competitor-compare', ['products.read'], 'competitors.read'],
    ['/products/p1/alerts', ['products.read'], 'alerts.read'],
  ])('%s 缺少权限（%s 不够）：403，坏参数也不会先看到 422，也不读商品', async (path, permissions) => {
    const { res, prisma } = await call(permissions as string[], `${path}?from=bad&to=bad`)
    expect(res.status).toBe(403)
    expect(prisma.fbaProduct.findFirst).not.toHaveBeenCalled()
  })

  it.each(['/products/p1/compare', '/products/p1/competitor-compare', '/products/p1/alerts'])('%s 商品不在数据范围内或不存在：404', async path => {
    const { res, prisma } = await call([...BUSINESS, 'competitors.read', 'alerts.read'], path, { fbaProduct: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } })
    expect(res.status).toBe(404)
    expect(prisma.fbaProduct.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p1', tenantId: 'tenant-1', marketplaceId: 'ATVPDKIKX0DER' })
  })

  it('日期参数不合法：422（只给 from）', async () => {
    for (const path of ['/products/p1/compare?from=2026-10-01', '/products/p1/competitor-compare?from=2026-10-01']) {
      const { res } = await call([...BUSINESS, 'competitors.read'], path)
      expect(res.status, path).toBe(422)
      await harness?.close()
      harness = undefined
    }
  })
})

describe('同环比明细', () => {
  it('通用结构：本期、对比期、变化比率与变化量；没有接入的列是尚未接入而不是 0', async () => {
    const rows = [summary('2026-10-12'), summary('2026-10-05', { salesAmount: dec(100), units: 5, sessions: null, adsSpend: null, adsSales: null, profit: dec(20) })]
    const findMany = vi
      .fn()
      .mockImplementation(async (args: { where: { summaryDate: { gte: Date } } }) =>
        rows.filter(row => row.summaryDate >= args.where.summaryDate.gte && row.summaryDate <= (args.where.summaryDate as any).lte),
      )
    const { res } = await call(BUSINESS, `/products/p1/compare?${RANGE}`, { asinDailySummary: { findMany, groupBy: vi.fn() } })
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.compare).toEqual({ mode: 'custom', from: '2026-10-01', to: '2026-10-10' })
    const sales = data.rows.find((row: { metric: string }) => row.metric === 'sales')
    expect(sales).toMatchObject({ value: 200, prevValue: 100, changeRate: 1, changeValue: 100, state: 'OK' })
    const sessions = data.rows.find((row: { metric: string }) => row.metric === 'sessions')
    expect(sessions).toMatchObject({ value: 100, prevValue: null, changeRate: null, changeValue: null, state: 'OK' })
    const profit = data.rows.find((row: { metric: string }) => row.metric === 'profit')
    expect(profit).toMatchObject({ value: 50, prevValue: 20, changeRate: 1.5, state: 'OK' })
  })

  it('没有利润字段权限：利润列是受限；本期没有订单记录：整体没有数据，不写 0', async () => {
    const { res } = await call(['products.read'], `/products/p1/compare?${RANGE}`)
    expect(res.status).toBe(200)
    expect(res.json.data.state).toBe('NO_DATA')
    const rows = res.json.data.rows as Array<{ metric: string; state: string; value: number | null }>
    expect(rows.find(row => row.metric === 'profit')?.state).toBe('RESTRICTED')
    expect(rows.find(row => row.metric === 'sales')).toMatchObject({ state: 'NO_DATA', value: null })
  })
})

describe('竞品对比', () => {
  it('没有关注竞品：只有本品，说明去竞品监控里添加', async () => {
    const { res } = await call(['products.read', 'competitors.read'], '/products/p1/competitor-compare?from=2026-10-01&to=2026-10-10')
    expect(res.status).toBe(200)
    expect(res.json.data.state).toBe('NO_DATA')
    expect(res.json.data.parties).toHaveLength(1)
    expect(res.json.data.parties[0]).toMatchObject({ asin: 'B0TEST0001', isOwn: true })
    expect(res.json.data.note).toContain('竞品监控')
  })

  it('本品与竞品并列：同一分类的名次、每天取最后一条价格；竞品评分没有来源，本品评分来自导入', async () => {
    const snap = (at: string, price: number, rank: number | null, classification = 'c1') => ({
      asin: 'B0RIVAL001',
      title: '竞品一',
      price: dec(price),
      currency: 'USD',
      rank,
      rankClassificationId: classification,
      rankClassificationName: '厨房',
      observedAt: new Date(at),
    })
    const { res, prisma } = await call(['products.read', 'competitors.read', 'reviews.read'], '/products/p1/competitor-compare?from=2026-10-01&to=2026-10-03', {
      watchedAsin: { findMany: vi.fn().mockResolvedValue([{ asin: 'B0RIVAL001' }]) },
      competitorSnapshot: { findMany: vi.fn().mockResolvedValue([snap('2026-10-01T01:00:00Z', 10, 100), snap('2026-10-01T20:00:00Z', 11, 90), snap('2026-10-02T01:00:00Z', 12, null)]) },
      priceSnapshot: { findMany: vi.fn().mockResolvedValue([{ price: dec(15), observedAt: new Date('2026-10-01T03:00:00Z') }]) },
      salesRankSnapshot: {
        findMany: vi.fn().mockResolvedValue([
          { classificationId: 'c1', classificationName: '厨房', rank: 50, snapshotDate: day('2026-10-02') },
          { classificationId: 'c2', classificationName: '其他', rank: 9, snapshotDate: day('2026-10-02') },
        ]),
      },
      reviewMetricSnapshot: { findMany: vi.fn().mockResolvedValue([{ asin: 'B0TEST0001', avgRating: dec(4.5), ratingCount: 120, captureDate: day('2026-10-02') }]) },
    })
    expect(res.status).toBe(200)
    const [own, rival] = res.json.data.parties
    expect(res.json.data.state).toBe('OK')
    expect(prisma.watchedAsin.findMany.mock.calls[0][0].where).toMatchObject({ sellerAccountId: 's1', ownAsin: 'B0TEST0001' })
    expect(rival.points).toEqual([
      { date: '2026-10-01', price: 11, rank: 90, rating: null, ratingCount: null },
      { date: '2026-10-02', price: 12, rank: null, rating: null, ratingCount: null },
    ])
    expect(rival.ratingNote).toContain('没有官方来源')
    expect(rival.latest).toMatchObject({ price: 12, rank: 90 })
    expect(own.points).toEqual([
      { date: '2026-10-01', price: 15, rank: null, rating: null, ratingCount: null },
      { date: '2026-10-02', price: null, rank: 50, rating: 4.5, ratingCount: 120 },
    ])
    expect(own.ratingNote).toBeNull()
    expect(own.rankName).toBe('厨房')
  })

  it('没有评价权限：本品评分列说明原因，不查评分表', async () => {
    const { res, prisma } = await call(['products.read', 'competitors.read'], '/products/p1/competitor-compare?from=2026-10-01&to=2026-10-03')
    expect(res.json.data.parties[0].ratingNote).toContain('评价')
    expect(prisma.reviewMetricSnapshot.findMany).not.toHaveBeenCalled()
  })
})

describe('预警日志', () => {
  it('按商品、同款 SKU 与库存记录三类对象取预警，受成员店铺范围限制，没有预警写尚无记录', async () => {
    const { res, prisma } = await call(['products.read', 'alerts.read'], '/products/p1/alerts')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', items: [], truncated: false })
    const where = prisma.alertInstance.findMany.mock.calls[0][0].where
    expect(where.tenantId).toBe('tenant-1')
    expect(where.OR).toEqual([
      { entityType: 'ASIN', entityId: 'p1' },
      { entityType: 'SKU', entityId: 'p1' },
      { entityType: 'INVENTORY', entityId: 'inv-1' },
    ])
  })
})
