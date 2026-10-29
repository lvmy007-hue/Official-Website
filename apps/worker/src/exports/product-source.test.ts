import { EXPORT_KINDS, PRODUCT_EXPORT_KIND } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { productFiltersOf, products } from './product-source'
import { EXPORT_SOURCES } from './sources'

// 商品主数据导出源（P4-07）：筛选与页面一致、范围、分页续取、负责人导出成名字、列与契约一致。

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  asin: 'B0TEST0001',
  sellerSku: `SKU-${id}`,
  fnsku: null,
  parentAsin: null,
  title: '示例商品',
  brand: '示例品牌',
  categoryPath: 'Home > Kitchen',
  fulfillmentChannel: 'AFN',
  listingStatus: 'ACTIVE',
  price: { toString: () => '19.9' },
  currency: 'USD',
  ownerUserId: null,
  tagIds: ['新品', '促销'],
  updatedAt: new Date('2026-10-20T08:00:00Z'),
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const collect = async (iterable: AsyncIterable<unknown>) => {
  const rows: Array<Record<string, unknown>> = []
  for await (const item of iterable) rows.push(item as Record<string, unknown>)
  return rows
}
const run = (db: unknown, over: { filters?: Record<string, unknown>; storeIds?: string[] | null } = {}) =>
  collect(products({ db: db as never, tenantId: 't1', filters: over.filters ?? {}, storeIds: over.storeIds === undefined ? null : over.storeIds }))

describe('商品主数据导出', () => {
  it('已登记到导出源，且契约里的每一列都有取数', async () => {
    expect(EXPORT_SOURCES[PRODUCT_EXPORT_KIND]).toBe(products)
    const spec = EXPORT_KINDS.find(item => item.kind === PRODUCT_EXPORT_KIND)
    expect(spec).toBeDefined()
    const [first] = await run({ fbaProduct: { findMany: vi.fn().mockResolvedValue([row('a')]) }, membership: { findMany: vi.fn() } })
    for (const column of spec?.columns ?? []) expect(first, column.key).toHaveProperty(column.key)
  })

  it('字段：价格是数字、标签用顿号连接；没有负责人是 null；已离开的成员显示固定文案', async () => {
    const db = {
      fbaProduct: { findMany: vi.fn().mockResolvedValue([row('a', { ownerUserId: 'u1' }), row('b', { ownerUserId: 'gone', price: null, tagIds: [] }), row('c')]) },
      membership: { findMany: vi.fn().mockResolvedValue([{ userId: 'u1', user: { displayName: '张三', email: 'z@example.com' } }]) },
    }
    const rows = await run(db)
    expect(rows[0]).toMatchObject({ storeName: '美国主店', price: 19.9, tags: '新品、促销', ownerName: '张三', category: 'Home > Kitchen' })
    expect(rows[1]).toMatchObject({ price: null, tags: '', ownerName: '已离开的成员' })
    expect(rows[2].ownerName).toBeNull()
  })

  it('筛选与范围：企业、美国站、店铺清单和页面同一套条件；店铺清单为 null 表示不限', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const db = { fbaProduct: { findMany }, membership: { findMany: vi.fn() } }
    await run(db, { storeIds: ['s1'], filters: { brand: 'Acme', fulfillment: 'MFN', tag: '新品', bad: 'x' } })
    const where = findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 't1', marketplaceId: 'ATVPDKIKX0DER', sellerAccountId: { in: ['s1'] } })
    expect(JSON.stringify(where.AND)).toContain('Acme')
    expect(JSON.stringify(where.AND)).toContain('MFN')
    await run(db)
    expect(findMany.mock.calls[1][0].where).not.toHaveProperty('sellerAccountId')
  })

  it('分页续取：整页满了就带游标取下一页，不满就停', async () => {
    const page = Array.from({ length: 2000 }, (_, i) => row(`p${String(i).padStart(4, '0')}`))
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([row('z')])
    const rows = await run({ fbaProduct: { findMany }, membership: { findMany: vi.fn() } })
    expect(rows).toHaveLength(2001)
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: 'p1999' }, skip: 1 })
  })

  it('筛选参数只认白名单取值', () => {
    expect(productFiltersOf({ fulfillment: 'OTHER', brand: '  ', q: ' 杯 ', tag: 5 })).toMatchObject({ fulfillment: undefined, brand: undefined, q: '杯', tag: undefined })
  })
})
