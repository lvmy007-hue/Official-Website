import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { policyRow, prismaFor, record } from '../inventory/inventory-http.test-helper'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const day = (date: string) => new Date(`${date}T00:00:00Z`)
const dec = (value: number) => ({ toString: () => String(value) })

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  asin: 'B0TEST0001',
  sellerSku: 'SKU-1',
  fnsku: 'X0TEST0001',
  title: '示例商品',
  brand: '示例品牌',
  productType: 'HOME',
  listingStatus: 'ACTIVE',
  fulfillmentChannel: 'FBA',
  price: dec(19.9),
  currency: 'USD',
  imageUrl: 'https://img.example/a.jpg',
  categoryPath: 'Home > Kitchen',
  parentAsin: 'B0PARENT01',
  ownerUserId: null,
  tagIds: [],
  catalogStatus: 'FOUND',
  catalogSyncedAt: new Date('2026-10-22T02:00:00Z'),
  sellerAccount: { displayName: '店铺一' },
  ...over,
})

const summary = (date: string, over: Record<string, unknown> = {}) => ({
  summaryDate: day(date),
  units: 2,
  salesAmount: dec(40),
  sessions: null,
  adsSpend: null,
  adsSales: null,
  profit: null,
  currency: 'USD',
  metricVersion: 'v1',
  refreshedAt: new Date('2026-10-22T03:00:00Z'),
  ...over,
})

/** 商品相关表的替身；fbaProduct.findMany 同时服务库存装配（取标题）与身份区的同 ASIN 行。 */
function withProduct(permissions: string[], over: Record<string, any> = {}) {
  const loader = { sellerAccountId: 's1', sellerSku: 'SKU-1', title: '示例商品', brand: '示例品牌' }
  return prismaFor(permissions, {
    fbaProduct: {
      findFirst: vi.fn().mockResolvedValue(product()),
      findMany: vi
        .fn()
        .mockImplementation((args: { select?: { listingStatus?: boolean } }) =>
          Promise.resolve(args.select?.listingStatus ? [{ id: 'p1', sellerSku: 'SKU-1', fnsku: 'X0TEST0001', listingStatus: 'ACTIVE' }] : [loader]),
        ),
    },
    fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([record()]), findFirst: vi.fn().mockResolvedValue({ id: 'inv-1' }) },
    replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(policyRow()), findMany: vi.fn().mockResolvedValue([policyRow()]), create: vi.fn() },
    productVariantRelation: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue({ variationTheme: 'COLOR_NAME' }) },
    salesRankSnapshot: {
      findFirst: vi.fn().mockResolvedValue({ snapshotDate: day('2026-10-22') }),
      findMany: vi.fn().mockResolvedValue([{ classificationId: '1055398', classificationName: 'Home & Kitchen', rank: 1200 }]),
    },
    entityEvent: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    operationLog: { findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  })
}

const PATHS = ['/products/p1', '/products/p1/overview', '/products/p1/inventory', '/products/p1/actions', '/products/p1/changes']
const READER = ['products.read', 'inventory.read', 'replenishment.read']

describe('ASIN 360：权限与 404', () => {
  it('没有 products.read：403，且先于参数校验（坏日期也是 403）', async () => {
    harness = await createTestApp(withProduct(['inventory.read']))
    for (const path of PATHS) expect((await harness.call('GET', `${path}?from=bad`)).status, path).toBe(403)
  })

  it('商品不在成员的数据范围内或不存在：404，不泄露存在性', async () => {
    const prisma = withProduct(READER)
    prisma.fbaProduct.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    for (const path of PATHS) expect((await harness.call('GET', path)).status, path).toBe(404)
    const where = prisma.fbaProduct.findFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ id: 'p1', tenantId: 'tenant-1', marketplaceId: 'ATVPDKIKX0DER' })
  })

  it('库存页签另需 inventory.read；建议动作对没有库存权限的成员是受限而不是 403', async () => {
    harness = await createTestApp(withProduct(['products.read']))
    expect((await harness.call('GET', '/products/p1/inventory')).status).toBe(403)
    const { data } = (await harness.call('GET', '/products/p1/actions')).json
    expect(data).toMatchObject({ state: 'RESTRICTED', items: [], inventoryId: null })
  })
})

describe('ASIN 360：身份区', () => {
  it('商品、目录、父体、排名、库存摘要、数据新鲜度', async () => {
    harness = await createTestApp(withProduct(READER))
    const { data } = (await harness.call('GET', '/products/p1')).json
    expect(data.product).toMatchObject({
      id: 'p1',
      asin: 'B0TEST0001',
      sku: 'SKU-1',
      storeName: '店铺一',
      price: 19.9,
      imageUrl: 'https://img.example/a.jpg',
      categoryPath: 'Home > Kitchen',
      ownerName: null,
    })
    expect(data.catalog).toMatchObject({ state: 'OK', note: null })
    expect(data.siblings).toEqual([{ id: 'p1', sku: 'SKU-1', fnsku: 'X0TEST0001', listingStatus: 'ACTIVE' }])
    expect(data.variants).toMatchObject({ parentAsin: 'B0PARENT01', isParent: false, variationTheme: 'COLOR_NAME' })
    expect(data.ranks).toMatchObject({ state: 'OK', snapshotDate: '2026-10-22', items: [{ classificationId: '1055398', name: 'Home & Kitchen', rank: 1200 }] })
    expect(data.stock).toMatchObject({ state: 'OK', inventoryId: 'inv-1', sellable: 100 })
    expect(data.freshness).toMatchObject({ lastSuccessAt: null })
  })

  it('目录还没同步或查无此 ASIN：说明原因，不显示假的品牌与排名', async () => {
    const prisma = withProduct(READER, { salesRankSnapshot: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() } })
    prisma.fbaProduct.findFirst.mockResolvedValue(product({ catalogStatus: null, catalogSyncedAt: null, imageUrl: null, brand: null, parentAsin: null }))
    harness = await createTestApp(prisma)
    const { data } = (await harness.call('GET', '/products/p1')).json
    expect(data.catalog.state).toBe('NOT_SYNCED')
    expect(data.ranks).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(data.ranks.note).toContain('尚未同步')
    prisma.fbaProduct.findFirst.mockResolvedValue(product({ catalogStatus: 'NOT_FOUND' }))
    expect((await harness.call('GET', '/products/p1')).json.data.catalog).toMatchObject({ state: 'NOT_FOUND' })
  })

  it('没有库存读权限：库存摘要受限；没有库存记录：无数据', async () => {
    harness = await createTestApp(withProduct(['products.read']))
    expect((await harness.call('GET', '/products/p1')).json.data.stock).toMatchObject({ state: 'RESTRICTED', sellable: null, inventoryId: null })
    await harness.close()
    harness = await createTestApp(withProduct(READER, { fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) } }))
    expect((await harness.call('GET', '/products/p1')).json.data.stock).toMatchObject({ state: 'NO_DATA', sellable: null })
  })

  it('自己是父体：返回子体数量', async () => {
    const prisma = withProduct(READER, { productVariantRelation: { count: vi.fn().mockResolvedValue(3), findFirst: vi.fn().mockResolvedValue(null) } })
    prisma.fbaProduct.findFirst.mockResolvedValue(product({ parentAsin: null }))
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/products/p1')).json.data.variants).toMatchObject({ isParent: true, childCount: 3, parentAsin: null, siblingCount: null })
  })
})

describe('ASIN 360：经营表现', () => {
  const rows = [summary('2026-10-20'), summary('2026-10-21', { units: 3, salesAmount: dec(60) })]

  it('有记录：销售额卡片、逐日、同比环比；利润、会话、广告没接入不显示 0', async () => {
    harness = await createTestApp(withProduct(['products.read', 'field.profit'], { asinDailySummary: { findMany: vi.fn().mockResolvedValue(rows) } }))
    const { data } = (await harness.call('GET', '/products/p1/overview?from=2026-10-20&to=2026-10-21&compare=previous')).json
    expect(data).toMatchObject({ hasRows: true, currency: 'USD', metricVersion: 'v1', defaulted: false })
    const card = (key: string) => data.cards.find((item: { key: string }) => item.key === key)
    expect(card('sales')).toMatchObject({ state: 'OK', value: 100 })
    expect(card('profit')).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(card('conversion')).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(card('adsShare')).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(data.daily.map((point: { date: string; units: number }) => [point.date, point.units])).toEqual([
      ['2026-10-20', 2],
      ['2026-10-21', 3],
    ])
    expect(data.table.map((row: { key: string }) => row.key)).toEqual(['sales', 'units', 'unitPrice'])
    expect(data.split).toMatchObject({ state: 'NOT_CONNECTED', organicSales: null })
    expect(data.profit.state).toBe('NOT_CONNECTED')
    expect(data.refunds.state).toBe('NOT_CONNECTED')
  })

  it('没有记录：销售额无数据、整张表为空值，不是 0', async () => {
    harness = await createTestApp(withProduct(['products.read'], { asinDailySummary: { findMany: vi.fn().mockResolvedValue([]) } }))
    const { data } = (await harness.call('GET', '/products/p1/overview?from=2026-10-20&to=2026-10-21')).json
    expect(data.hasRows).toBe(false)
    expect(data.cards.find((item: { key: string }) => item.key === 'sales')).toMatchObject({ state: 'NO_DATA', value: null })
    expect(data.table[0]).toMatchObject({ current: null, previous: null, yoy: null })
    expect(data.attribution).toBeNull()
  })

  it('没有利润字段权限：利润卡片受限，逐日里也不带利润', async () => {
    const withProfit = [summary('2026-10-20', { profit: dec(12) })]
    harness = await createTestApp(withProduct(['products.read'], { asinDailySummary: { findMany: vi.fn().mockResolvedValue(withProfit) } }))
    const { data } = (await harness.call('GET', '/products/p1/overview?from=2026-10-20&to=2026-10-20')).json
    expect(data.cards.find((item: { key: string }) => item.key === 'profit')).toMatchObject({ state: 'RESTRICTED', value: null })
    expect(data.daily[0].profit).toBeNull()
    expect(data.profit.state).toBe('RESTRICTED')
  })

  it('日期参数不合法：422（通过权限后才校验）', async () => {
    harness = await createTestApp(withProduct(['products.read']))
    expect((await harness.call('GET', '/products/p1/overview?from=nope&to=2026-10-20')).status).toBe(422)
  })

  it('查询只按这个商品的店铺与 ASIN 取日汇总', async () => {
    const prisma = withProduct(['products.read'], { asinDailySummary: { findMany: vi.fn().mockResolvedValue([]) } })
    harness = await createTestApp(prisma)
    await harness.call('GET', '/products/p1/overview?from=2026-10-20&to=2026-10-21')
    for (const [args] of prisma.asinDailySummary.findMany.mock.calls) expect(args.where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', asin: 'B0TEST0001' })
  })
})

describe('ASIN 360：库存补货与变更', () => {
  it('库存页签返回库存记录编号；建议动作来自库存详情', async () => {
    harness = await createTestApp(withProduct(READER))
    expect((await harness.call('GET', '/products/p1/inventory')).json.data).toEqual({ state: 'OK', note: null, inventoryId: 'inv-1' })
    const actions = (await harness.call('GET', '/products/p1/actions')).json.data
    expect(actions).toMatchObject({ state: 'OK', inventoryId: 'inv-1' })
    expect(actions.items[0]).toMatchObject({ id: 'replenish' })
  })

  it('没有库存记录：页签与建议动作都说明原因', async () => {
    harness = await createTestApp(withProduct(READER, { fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) } }))
    expect((await harness.call('GET', '/products/p1/inventory')).json.data).toMatchObject({ state: 'NO_DATA', inventoryId: null })
    expect((await harness.call('GET', '/products/p1/actions')).json.data).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('变更与审计：事件与运营日志合并，新的在前；带前后取值与来源', async () => {
    const events = [
      {
        id: 'e1',
        kind: 'listing.change',
        occurredAt: new Date('2026-10-21T10:00:00Z'),
        title: '品牌已变更',
        detailJson: { field: 'brand', before: '旧品牌', after: '新品牌' },
        actorKind: 'AMAZON',
        actorId: null,
      },
      { id: 'e2', kind: 'price.change', occurredAt: new Date('2026-10-19T10:00:00Z'), title: '改价', detailJson: null, actorKind: 'USER', actorId: 'user-1' },
    ]
    const logs = [{ id: 'l1', category: 'PRICE', text: '做了一次促销', occurredAt: new Date('2026-10-20T10:00:00Z'), authorId: 'user-1' }]
    const prisma = withProduct(['products.read'], { entityEvent: { create: vi.fn(), findMany: vi.fn().mockResolvedValue(events) }, operationLog: { findMany: vi.fn().mockResolvedValue(logs) } })
    harness = await createTestApp(prisma)
    const { data } = (await harness.call('GET', '/products/p1/changes')).json
    expect(data.truncated).toBe(false)
    expect(data.items.map((item: { id: string }) => item.id)).toEqual(['event:e1', 'log:l1', 'event:e2'])
    expect(data.items[0]).toMatchObject({ source: 'amazon', kindLabel: '商品信息变更', before: '旧品牌', after: '新品牌', actor: '亚马逊' })
    expect(data.items[1]).toMatchObject({ source: 'manual', title: '做了一次促销', before: null })
    expect(data.items[2]).toMatchObject({ source: 'system', kindLabel: '改价' })
    expect(prisma.entityEvent.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', entityType: 'ASIN', entityId: 'p1' })
    expect(prisma.operationLog.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', scope: 'ASIN', scopeRef: 'p1' })
  })

  it('变更超过上限：标记截断', async () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      id: `e${index}`,
      kind: 'alert',
      occurredAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
      title: '预警',
      detailJson: null,
      actorKind: 'SYSTEM',
      actorId: null,
    }))
    harness = await createTestApp(withProduct(['products.read'], { entityEvent: { create: vi.fn(), findMany: vi.fn().mockResolvedValue(many) } }))
    const { data } = (await harness.call('GET', '/products/p1/changes')).json
    expect(data.truncated).toBe(true)
    expect(data.items).toHaveLength(200)
  })
})
