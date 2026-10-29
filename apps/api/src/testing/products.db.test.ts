import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// ASIN 360 与商品目录同步（P2a-14，真实数据库 + 完整应用）：
// 迁移升级与回滚、检查约束与唯一键；身份区、经营表现、变更与审计的真实查询，数据范围与跨租户隔离。

type Member = { userId: string; token: string }
const TARGET = '20261025010000_catalog_items'
const US = 'ATVPDKIKX0DER'
const now = () => new Date().toISOString()

describe('商品目录迁移（P2a-14）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('catalog_migrate')
    client = await db.connect('catalog_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean
  const columns = async () => (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'FbaProduct'`)).rows.map(row => row.column_name as string)

  it('升级加列建表、回滚还原、再次升级闭环；取值由数据库约束', async () => {
    const ids = await seedTenant(client, 'cat-mig')
    const store = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
    const base = { ...store, marketplaceId: US }
    await insertRow(client, 'FbaProduct', { id: 'fp-old', ...base, sellerSku: 'OLD', asin: 'B0OLD00001' })
    expect(await exists('SalesRankSnapshot')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists('SalesRankSnapshot')).toBe(true)
    expect(await exists('ProductVariantRelation')).toBe(true)
    // 已有商品行：新列都是空（没同步过），标签默认空数组
    const old = (await client.query(`SELECT "catalogStatus", "catalogSyncedAt", "imageUrl", "tagIds" FROM "FbaProduct" WHERE id = 'fp-old'`)).rows[0]
    expect(old).toEqual({ catalogStatus: null, catalogSyncedAt: null, imageUrl: null, tagIds: [] })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists('SalesRankSnapshot')).toBe(false)
    expect(await exists('ProductVariantRelation')).toBe(false)
    expect(await columns()).not.toContain('catalogStatus')
    await applyMigrations(client, { only: TARGET })

    await expect(client.query(`UPDATE "FbaProduct" SET "catalogStatus" = 'MAYBE' WHERE id = 'fp-old'`)).rejects.toMatchObject({ code: '23514' })
    await client.query(`UPDATE "FbaProduct" SET "catalogStatus" = 'FOUND' WHERE id = 'fp-old'`)

    const rank = (over: Record<string, unknown> = {}) =>
      insertRow(client, 'SalesRankSnapshot', {
        id: `sr-${Math.random()}`,
        ...store,
        asin: 'B0OLD00001',
        classificationId: '1',
        classificationName: '类目',
        rank: 10,
        snapshotDate: '2026-10-22',
        ...over,
      })
    await rank()
    await expect(rank()).rejects.toMatchObject({ code: '23505' })
    await expect(rank({ classificationId: '2', rank: 0 })).rejects.toMatchObject({ code: '23514' })
    await rank({ snapshotDate: '2026-10-23' })

    const relation = (over: Record<string, unknown> = {}) =>
      insertRow(client, 'ProductVariantRelation', { id: `pv-${Math.random()}`, ...store, parentAsin: 'B0PARENT01', childAsin: 'B0CHILD001', sourceUpdatedAt: now(), ...over })
    await relation()
    await expect(relation()).rejects.toMatchObject({ code: '23505' })
    await expect(relation({ childAsin: 'B0PARENT01' })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('ASIN 360（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerAccountId: string
  let owner: Member
  let reader: Member
  let scoped: Member
  let outsider: Member
  let noAccess: Member
  const call = (member: Member, path: string) => h.call(member.token, 'GET', path, {})

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'products', db })
    const a = await h.createTenant('prod-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    const secondSeller = (await insertRow(h.client, 'SellerAccount', { id: 'seller-prod-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-PROD-2' })).id
    const b = await h.createTenant('prod-b')
    owner = await h.createMember(tenantId, 'prod-owner', ['*'])
    reader = await h.createMember(tenantId, 'prod-reader', ['products.read'])
    scoped = await h.createMember(tenantId, 'prod-scoped', ['products.read'], { scopes: [{ sellerAccountId: secondSeller }] })
    noAccess = await h.createMember(tenantId, 'prod-none', ['overview.read'])
    outsider = await h.createMember(b.tenantId, 'prod-outsider', ['*'])

    const store = { tenantId, sellerAccountId }
    const base = { ...store, marketplaceId: US }
    await insertRow(h.client, 'FbaProduct', {
      id: 'prod-1',
      ...base,
      sellerSku: 'SKU-1',
      asin: 'B0TEST0001',
      fnsku: 'X0TEST0001',
      title: '示例商品',
      brand: '示例品牌',
      imageUrl: 'https://img.example/a.jpg',
      categoryPath: 'Home > Kitchen',
      parentAsin: 'B0PARENT01',
      catalogStatus: 'FOUND',
      catalogSyncedAt: now(),
    })
    await insertRow(h.client, 'FbaProduct', { id: 'prod-1b', ...base, sellerSku: 'SKU-1B', asin: 'B0TEST0001', title: '示例商品（另一个 SKU）' })
    await insertRow(h.client, 'FbaProduct', { id: 'prod-2', ...base, sellerSku: 'SKU-2', asin: 'B0TEST0002', title: '没同步目录也没有销售的商品' })
    await insertRow(h.client, 'ProductVariantRelation', { id: 'pv-1', ...store, parentAsin: 'B0PARENT01', childAsin: 'B0TEST0001', variationTheme: 'COLOR_NAME', sourceUpdatedAt: now() })
    await insertRow(h.client, 'ProductVariantRelation', { id: 'pv-2', ...store, parentAsin: 'B0PARENT01', childAsin: 'B0TEST0002', variationTheme: 'COLOR_NAME', sourceUpdatedAt: now() })
    await insertRow(h.client, 'SalesRankSnapshot', {
      id: 'sr-1',
      ...store,
      asin: 'B0TEST0001',
      classificationId: '1055398',
      classificationName: 'Home & Kitchen',
      rank: 1200,
      snapshotDate: '2026-10-22',
    })
    await insertRow(h.client, 'SalesRankSnapshot', {
      id: 'sr-0',
      ...store,
      asin: 'B0TEST0001',
      classificationId: '1055398',
      classificationName: 'Home & Kitchen',
      rank: 900,
      snapshotDate: '2026-10-20',
    })
    for (const [date, units, sales] of [
      ['2026-10-02', 2, 40],
      ['2026-10-03', 3, 60],
    ] as const) {
      await insertRow(h.client, 'AsinDailySummary', { id: `ads-${date}`, ...store, asin: 'B0TEST0001', summaryDate: date, units, salesAmount: sales, metricVersion: 'v1' })
    }
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-1',
      tenantId,
      sellerAccountId,
      entityType: 'ASIN',
      entityId: 'prod-1',
      kind: 'listing.change',
      occurredAt: '2026-10-21T10:00:00Z',
      title: '品牌已变更',
      detailJson: JSON.stringify({ field: 'brand', before: '旧品牌', after: '示例品牌' }),
      actorKind: 'AMAZON',
    })
    await insertRow(h.client, 'OperationLog', {
      id: 'ol-1',
      tenantId,
      sellerAccountId,
      scope: 'ASIN',
      scopeRef: 'prod-1',
      occurredAt: '2026-10-20T10:00:00Z',
      category: 'PRICE',
      text: '做了一次促销',
      authorId: owner.userId,
      attachmentIds: [],
    })
    // 别的商品的事件不能混进来
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-other',
      tenantId,
      sellerAccountId,
      entityType: 'ASIN',
      entityId: 'prod-1b',
      kind: 'alert',
      occurredAt: '2026-10-21T11:00:00Z',
      title: '别的商品',
      actorKind: 'SYSTEM',
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await db?.stop()
  })

  it('身份区：商品、目录信息、同 ASIN 的所有 SKU、父体与子体、最新一天的排名', async () => {
    const res = await call(owner, '/products/prod-1')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data
    expect(data.product).toMatchObject({
      id: 'prod-1',
      asin: 'B0TEST0001',
      brand: '示例品牌',
      imageUrl: 'https://img.example/a.jpg',
      categoryPath: 'Home > Kitchen',
      parentAsin: 'B0PARENT01',
      tags: [],
    })
    expect(data.catalog).toMatchObject({ state: 'OK' })
    expect(data.siblings.map((item: { sku: string }) => item.sku)).toEqual(['SKU-1', 'SKU-1B'])
    expect(data.variants).toMatchObject({ parentAsin: 'B0PARENT01', isParent: false, siblingCount: 1, variationTheme: 'COLOR_NAME' })
    expect(data.ranks).toMatchObject({ state: 'OK', snapshotDate: '2026-10-22', items: [{ classificationId: '1055398', rank: 1200 }] })
    // 没有库存读权限：库存摘要受限
    expect((await call(reader, '/products/prod-1')).json.data.stock.state).toBe('RESTRICTED')
    // 同店铺同 ASIN 的另一个 SKU 共用 ASIN 级的目录信息与排名；还没同步目录的商品
    expect((await call(owner, '/products/prod-1b')).json.data.ranks.state).toBe('OK')
    const bare = (await call(owner, '/products/prod-2')).json.data
    expect(bare.catalog.state).toBe('NOT_SYNCED')
    expect(bare.ranks).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('数据范围与隔离：别的租户、范围外的店铺、不存在的编号都是 404；没有 products.read 是 403', async () => {
    for (const path of ['/products/prod-1', '/products/prod-1/overview', '/products/prod-1/changes', '/products/prod-1/actions']) {
      expect((await call(outsider, path)).status, `租户外 ${path}`).toBe(404)
      expect((await call(scoped, path)).status, `范围外 ${path}`).toBe(404)
      expect((await call(noAccess, path)).status, `无权限 ${path}`).toBe(403)
    }
    expect((await call(owner, '/products/nope')).status).toBe(404)
    expect((await call(reader, '/products/prod-1/inventory')).status).toBe(403)
  })

  it('经营表现：按这个商品的日汇总求和；没有记录的时段为空值', async () => {
    const { data } = (await call(owner, '/products/prod-1/overview?from=2026-10-01&to=2026-10-07')).json
    expect(data).toMatchObject({ hasRows: true, currency: 'USD', metricVersion: 'v1' })
    expect(data.cards.find((card: { key: string }) => card.key === 'sales')).toMatchObject({ state: 'OK', value: 100 })
    expect(data.table[1]).toMatchObject({ key: 'units', current: 5, previous: null, yoy: null })
    expect(data.daily).toHaveLength(7)
    expect(data.daily[1]).toMatchObject({ date: '2026-10-02', units: 2, sales: 40 })
    expect(data.daily[0]).toMatchObject({ units: 0, sales: 0, profit: null })
    const empty = (await call(owner, '/products/prod-2/overview?from=2026-10-01&to=2026-10-07')).json.data
    expect(empty.hasRows).toBe(false)
    expect(empty.cards.find((card: { key: string }) => card.key === 'sales')).toMatchObject({ state: 'NO_DATA', value: null })
  })

  it('变更与审计：只含这个商品的事件与运营日志，新的在前', async () => {
    const { data } = (await call(reader, '/products/prod-1/changes')).json
    expect(data.items.map((item: { id: string }) => item.id)).toEqual(['event:ev-1', 'log:ol-1'])
    expect(data.items[0]).toMatchObject({ source: 'amazon', before: '旧品牌', after: '示例品牌', kindLabel: '商品信息变更' })
    expect(data.items[1]).toMatchObject({ source: 'manual', actor: expect.any(String) })
    expect((await call(owner, '/products/prod-1b/changes')).json.data.items.map((item: { id: string }) => item.id)).toEqual(['event:ev-other'])
  })

  it('没有库存记录时：库存页签与建议动作说明原因', async () => {
    expect((await call(owner, '/products/prod-1/inventory')).json.data).toMatchObject({ state: 'NO_DATA', inventoryId: null })
    expect((await call(owner, '/products/prod-1/actions')).json.data).toMatchObject({ state: 'NO_DATA', items: [] })
  })
})
