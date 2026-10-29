import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { CatalogApi, CATALOG_INCLUDED_DATA } from '../../connectors/catalog-api'
import type { AmazonSpApiClient } from '../../connectors/amazon-sp-api'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { ImportContext } from '../../types'
import { parseCatalogItems } from './items-parse'
import { changeTitle, syncCatalogItems } from './items-sync'

// 商品目录同步器（I-09）：官方格式样例（apps/worker/fixtures/catalog）→ 解析结果、写入的表与幂等键、未找到的标记、变更事件、关系对账。

const fixture = () => JSON.parse(readFileSync(join(__dirname, '../../../fixtures/catalog/items.json'), 'utf8')) as Record<string, unknown>
const TODAY = new Date('2026-10-25T00:00:00Z')
const NOW = new Date('2026-10-25T08:00:00Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }

type Loose = ReturnType<typeof JSON.parse>
type ProductSeed = {
  id: string
  asin: string
  brand?: string | null
  imageUrl?: string | null
  categoryPath?: string | null
  parentAsin?: string | null
  productType?: string | null
  variantAttributes?: unknown
  catalogSyncedAt?: Date | null
}

function context(products: ProductSeed[]) {
  const calls: Array<{ model: string; op: string; args: Loose }> = []
  const record = (model: string, op: string) => async (args: Loose) => {
    calls.push({ model, op, args })
    return model === 'fbaProduct' && op === 'findMany'
      ? products.map(item => ({ brand: null, imageUrl: null, categoryPath: null, parentAsin: null, productType: null, variantAttributes: null, catalogSyncedAt: null, ...item }))
      : null
  }
  const table = (model: string) => ({
    findMany: record(model, 'findMany'),
    updateMany: record(model, 'updateMany'),
    upsert: record(model, 'upsert'),
    create: record(model, 'create'),
    deleteMany: record(model, 'deleteMany'),
  })
  const prisma = {
    fbaProduct: table('fbaProduct'),
    productVariantRelation: table('productVariantRelation'),
    salesRankSnapshot: table('salesRankSnapshot'),
    entityEvent: table('entityEvent'),
  } as unknown as PrismaClient
  const warn = vi.fn()
  const ctx: ImportContext = { prisma, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }
  const of = (model: string, op: string) => calls.filter(call => call.model === model && call.op === op)
  return { ctx, of, warn }
}

const apiOf = (getItems: (asins: readonly string[]) => Promise<Record<string, unknown>>) => ({ getItems: vi.fn(getItems) }) as unknown as CatalogApi & { getItems: ReturnType<typeof vi.fn> }
const http = (status: number) => new UpstreamHttpError(`SP_API_${status}`, status, undefined, 'api')

describe('响应解析', () => {
  it('取主图里最大的一张；类目取展示组与分类两级；父体、变体主题、排名（含展示组排名）', () => {
    const { items, skipped } = parseCatalogItems(fixture())
    expect(skipped).toBe(1)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      asin: 'B0AAAAAAA1',
      brand: 'NovaHome',
      imageUrl: 'https://m.media-amazon.com/images/I/main-large.jpg',
      productType: 'KITCHEN',
      categoryPath: 'Home & Kitchen > Kitchen Utensils & Gadgets',
      parentAsin: 'B0PARENT01',
      childAsins: [],
      variationTheme: 'COLOR',
      variantValues: { color: 'Red' },
      ranks: [
        { classificationId: '289913', name: 'Kitchen Utensils & Gadgets', rank: 1520 },
        { classificationId: 'display:home_display_on_website', name: 'Home & Kitchen', rank: 20450 },
      ],
    })
  })

  it('父体列出子体；缺失的字段是 null 与空数组（不补空串、不补 0）；只认美国站那一组', () => {
    const parent = parseCatalogItems(fixture()).items[1]!
    expect(parent).toMatchObject({
      asin: 'B0PARENT01',
      brand: 'NovaHome',
      imageUrl: null,
      productType: null,
      categoryPath: null,
      parentAsin: null,
      childAsins: ['B0AAAAAAA1', 'B0BBBBBBB2'],
      ranks: [],
    })
    const other = parseCatalogItems({ items: [{ asin: 'B0X', summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', brand: '英国站品牌' }] }] })
    expect(other.items[0]!.brand).toBeNull()
    expect(parseCatalogItems(null)).toEqual({ items: [], skipped: 0 })
  })

  it('变更标题：主图不写地址', () => {
    expect(changeTitle('categoryPath', 'A', 'B')).toBe('类目由「A」变为「B」')
    expect(changeTitle('imageUrl', 'https://x/1.jpg', 'https://x/2.jpg')).toBe('主图已更换')
  })
})

describe('接口调用', () => {
  it('一次最多 20 个 ASIN，固定美国站，请求全部需要的数据集', async () => {
    const request = vi.fn(async () => ({}))
    await new CatalogApi({ request } as unknown as AmazonSpApiClient).getItems(['B0A', 'B0B'])
    expect(request).toHaveBeenCalledWith({
      path: '/catalog/2022-04-01/items',
      query: { identifiers: 'B0A,B0B', identifiersType: 'ASIN', marketplaceIds: 'ATVPDKIKX0DER', includedData: CATALOG_INCLUDED_DATA.join(','), pageSize: '20', locale: 'en_US' },
    })
    const api = new CatalogApi({ request } as unknown as AmazonSpApiClient)
    expect(() => api.getItems([])).toThrow('CATALOG_BATCH_SIZE_INVALID')
    expect(() => api.getItems(Array.from({ length: 21 }, (_, index) => `B0${index}`))).toThrow('CATALOG_BATCH_SIZE_INVALID')
  })
})

describe('同步商品目录', () => {
  const products: ProductSeed[] = [
    { id: 'p1', asin: 'B0AAAAAAA1' },
    { id: 'p1b', asin: 'B0AAAAAAA1' },
    { id: 'p3', asin: 'B0MISSING9' },
  ]

  it('写回商品字段与已找到状态；一个 ASIN 的多个 SKU 一起更新；没返回的标记待核实且不清空已有数据', async () => {
    const { ctx, of } = context(products)
    const api = apiOf(async () => fixture())
    const result = await syncCatalogItems(ctx, api, scope, { today: TODAY, now: NOW })
    expect(api.getItems).toHaveBeenCalledTimes(1) // 去重后 2 个 ASIN，一批
    expect(api.getItems.mock.calls[0]![0]).toEqual(['B0AAAAAAA1', 'B0MISSING9'])
    expect(result).toMatchObject({ notApplicable: false, found: 1, notFound: 1, ranks: 2, products: 3, skipped: 1 })
    const updates = of('fbaProduct', 'updateMany')
    expect(updates[0]!.args).toEqual({
      where: { tenantId: 't1', sellerAccountId: 'sa1', marketplaceId: 'ATVPDKIKX0DER', asin: 'B0AAAAAAA1' },
      data: {
        variantAttributes: { color: 'Red' },
        brand: 'NovaHome',
        imageUrl: 'https://m.media-amazon.com/images/I/main-large.jpg',
        categoryPath: 'Home & Kitchen > Kitchen Utensils & Gadgets',
        productType: 'KITCHEN',
        parentAsin: 'B0PARENT01',
        catalogStatus: 'FOUND',
        catalogSyncedAt: NOW,
      },
    })
    expect(updates[1]!.args).toEqual({
      where: { tenantId: 't1', sellerAccountId: 'sa1', marketplaceId: 'ATVPDKIKX0DER', asin: { in: ['B0MISSING9'] } },
      data: { catalogStatus: 'NOT_FOUND', catalogSyncedAt: NOW },
    })
  })

  it('销售排名按“店铺 × ASIN × 分类 × 日”幂等写入', async () => {
    const { ctx, of } = context(products)
    await syncCatalogItems(
      ctx,
      apiOf(async () => fixture()),
      scope,
      { today: TODAY, now: NOW },
    )
    const ranks = of('salesRankSnapshot', 'upsert')
    expect(ranks).toHaveLength(2)
    expect(ranks[0]!.args.where).toEqual({
      tenantId_sellerAccountId_asin_classificationId_snapshotDate: { tenantId: 't1', sellerAccountId: 'sa1', asin: 'B0AAAAAAA1', classificationId: '289913', snapshotDate: TODAY },
    })
    expect(ranks[0]!.args.create).toMatchObject({ classificationName: 'Kitchen Utensils & Gadgets', rank: 1520 })
    expect(ranks[0]!.args.update).toEqual({ classificationName: 'Kitchen Utensils & Gadgets', rank: 1520 })
  })

  it('父子关系：子体一侧登记父体；父体被取回时按它列出的子体对账删除', async () => {
    const { ctx, of } = context([...products, { id: 'pp', asin: 'B0PARENT01' }])
    const result = await syncCatalogItems(
      ctx,
      apiOf(async () => fixture()),
      scope,
      { today: TODAY, now: NOW },
    )
    const pairs = of('productVariantRelation', 'upsert').map(call => call.args.create)
    expect(pairs.map(item => `${item.parentAsin}>${item.childAsin}`)).toEqual(['B0PARENT01>B0AAAAAAA1', 'B0PARENT01>B0AAAAAAA1', 'B0PARENT01>B0BBBBBBB2'])
    expect(pairs[0]).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', variationTheme: 'COLOR' })
    expect(result).toMatchObject({ relations: 3 })
    const deletes = of('productVariantRelation', 'deleteMany')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.args.where).toEqual({ tenantId: 't1', sellerAccountId: 'sa1', parentAsin: 'B0PARENT01', childAsin: { notIn: ['B0AAAAAAA1', 'B0BBBBBBB2'] } })
  })

  it('已有值与目录值不同才记“亚马逊侧变更”；首次填入与没变化都不记', async () => {
    const same = context([{ id: 'p1', asin: 'B0AAAAAAA1', brand: 'NovaHome', categoryPath: 'Home & Kitchen > Kitchen Utensils & Gadgets' }])
    const unchanged = await syncCatalogItems(
      same.ctx,
      apiOf(async () => fixture()),
      scope,
      { today: TODAY, now: NOW },
    )
    expect(unchanged).toMatchObject({ changes: 0 })

    const changed = context([{ id: 'p1', asin: 'B0AAAAAAA1', brand: 'OldBrand', imageUrl: 'https://m.media-amazon.com/images/I/old.jpg', categoryPath: null, parentAsin: 'B0PARENT01' }])
    const result = await syncCatalogItems(
      changed.ctx,
      apiOf(async () => fixture()),
      scope,
      { today: TODAY, now: NOW },
    )
    expect(result).toMatchObject({ changes: 2 })
    const events = changed.of('entityEvent', 'create').map(call => call.args.data)
    expect(events.map(event => event.title)).toEqual(['品牌由「OldBrand」变为「NovaHome」', '主图已更换'])
    expect(events[0]).toMatchObject({
      tenantId: 't1',
      sellerAccountId: 'sa1',
      entityType: 'ASIN',
      entityId: 'p1',
      kind: 'listing.change',
      occurredAt: NOW,
      actorKind: 'AMAZON',
      sourceRef: 'catalog:brand:2026-10-25',
      detailJson: { field: 'brand', before: 'OldBrand', after: 'NovaHome', observedBy: 'catalog-sync' },
    })
  })

  it('目录没给的字段保留原值（不用空值覆盖），但父体明确缺失会清空', async () => {
    const { ctx, of } = context([{ id: 'pp', asin: 'B0PARENT01', parentAsin: 'B0OLD' }])
    await syncCatalogItems(
      ctx,
      apiOf(async () => fixture()),
      scope,
      { today: TODAY, now: NOW },
    )
    expect(of('fbaProduct', 'updateMany')[0]!.args.data).toEqual({ brand: 'NovaHome', parentAsin: null, catalogStatus: 'FOUND', catalogSyncedAt: NOW })
  })

  it('变体结构变更（P4-03）：同步过的商品父体变了，旧父体记移除、新父体记新增；变体属性取值变了记在商品上；首次同步不记', async () => {
    const synced = new Date('2026-10-24T08:00:00Z')
    const { ctx, of } = context([{ id: 'p1', asin: 'B0AAAAAAA1', parentAsin: 'B0OLDPAR01', catalogSyncedAt: synced, variantAttributes: { color: 'Blue' } }])
    const result = await syncCatalogItems(
      ctx,
      apiOf(async () => fixture()),
      scope,
      { today: TODAY, now: NOW },
    )
    const events = of('entityEvent', 'create').map(call => call.args.data)
    expect(events.map(event => `${event.entityType}:${event.entityId}:${event.kind}`)).toEqual([
      'ASIN:p1:listing.change', // 既有的“父体变更”事件仍然记（商品时间线用）
      'PARENT_ASIN:B0OLDPAR01:variation.child_removed',
      'PARENT_ASIN:B0PARENT01:variation.child_added',
      'ASIN:p1:variation.attribute_change',
    ])
    expect(events[3]).toMatchObject({
      title: '变体属性 color 由「Blue」变为「Red」',
      detailJson: { field: 'color', before: 'Blue', after: 'Red', childAsin: 'B0AAAAAAA1', parentAsin: 'B0PARENT01' },
      actorKind: 'AMAZON',
    })
    expect(result).toMatchObject({ changes: 4 })

    const first = context([{ id: 'p1', asin: 'B0AAAAAAA1', parentAsin: 'B0OLDPAR01', variantAttributes: { color: 'Blue' } }])
    await syncCatalogItems(
      first.ctx,
      apiOf(async () => fixture()),
      scope,
      { today: TODAY, now: NOW },
    )
    // 从没同步过目录：只有既有的 listing.change（父体前后都有值），变体结构事件不记
    expect(first.of('entityEvent', 'create').map(call => call.args.data.kind)).toEqual(['listing.change'])
  })

  it('每 20 个 ASIN 一批', async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ id: `p${index}`, asin: `B0${String(index).padStart(8, '0')}` }))
    const { ctx, of } = context(many)
    const api = apiOf(async () => ({ items: [] }))
    const result = await syncCatalogItems(ctx, api, scope, { today: TODAY, now: NOW })
    expect(api.getItems.mock.calls.map(call => (call[0] as string[]).length)).toEqual([20, 20, 5])
    expect(result).toMatchObject({ found: 0, notFound: 45 })
    expect(of('fbaProduct', 'updateMany')).toHaveLength(3)
  })

  it('整批被拒（400）退化为逐个请求，单个仍被拒只标记它；其余错误原样抛出', async () => {
    const { ctx, of } = context([
      { id: 'a', asin: 'B0AAAAAAA1' },
      { id: 'b', asin: 'BAD' },
    ])
    const api = apiOf(async asins => {
      if (asins.length > 1 || asins[0] === 'BAD') throw http(400)
      return fixture()
    })
    const result = await syncCatalogItems(ctx, api, scope, { today: TODAY, now: NOW })
    expect(api.getItems).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ found: 1, notFound: 1 })
    expect(of('fbaProduct', 'updateMany').map(call => call.args.data.catalogStatus)).toEqual(['FOUND', 'NOT_FOUND'])

    const denied = context(products)
    await expect(
      syncCatalogItems(
        denied.ctx,
        apiOf(async () => {
          throw http(403)
        }),
        scope,
        { today: TODAY, now: NOW },
      ),
    ).rejects.toThrow('SP_API_403')
  })

  it('店铺里没有商品：不适用（不调用亚马逊、不写任何行）', async () => {
    const { ctx, of } = context([])
    const api = apiOf(async () => fixture())
    expect(await syncCatalogItems(ctx, api, scope, { today: TODAY, now: NOW })).toEqual({ notApplicable: true, reason: 'NO_PRODUCTS', imported: 0 })
    expect(api.getItems).not.toHaveBeenCalled()
    expect(of('fbaProduct', 'updateMany')).toHaveLength(0)
  })
})
