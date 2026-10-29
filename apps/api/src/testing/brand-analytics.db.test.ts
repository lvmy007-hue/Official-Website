import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 品牌分析（P4-04，真实数据库）：迁移升级、回滚与再升级；唯一键与检查约束（周期种类、起止顺序、份额范围、非负数）；
// 五个导入器在行级隔离的租户连接下写入（重复写不重复、热门搜索词按排名合并进同一行）；接口按导入结果给出确切的漏斗、
// 热门搜索词、购物篮与重复购买；跨企业隔离。后台代码在 worker 里，这里按路径动态加载，接口服务的编译范围不含后台任务代码（测试专用）。

const TARGET = '20261121010000_brand_analytics'
const TABLES = ['BrandSearchQueryPerformance', 'BrandSearchCatalogPerformance', 'BrandSearchTerm', 'BrandMarketBasket', 'BrandRepeatPurchase']
const logger = { warn: () => undefined, info: () => undefined, error: () => undefined }
const NOW = new Date('2026-10-22T08:00:00Z')
const WEEK = '2026-10-11'
const PREV = '2026-10-04'
const A1 = 'B0AAAAAAA1'
const A2 = 'B0AAAAAAA2'
const X1 = 'B0XXXXXXX1'

describe('品牌分析表迁移（P4-04）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('brand_migrate')
    client = await db.connect('brand_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean

  it('升级建五张表、回滚全部删除、再次升级闭环成功', async () => {
    for (const table of TABLES) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of TABLES) expect(await exists(table)).toBe(true)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of TABLES) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of TABLES) expect(await exists(table)).toBe(true)
  })

  it('唯一键与检查约束由数据库保证；没给的列存空，不是 0', async () => {
    const ids = await seedTenant(client, 'brand-mig')
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, reportPeriod: 'WEEK', periodStart: WEEK, periodEnd: '2026-10-17' }
    const sqp = (over: Record<string, unknown>) => insertRow(client, 'BrandSearchQueryPerformance', { id: `q-${Math.random()}`, ...base, asin: A1, searchQuery: 'yoga mat', ...over })
    expect(await sqp({})).toMatchObject({ impressionsOwn: null, clickShare: null, clickPriceOwn: null })
    await expect(sqp({})).rejects.toMatchObject({ code: '23505' })
    await sqp({ reportPeriod: 'MONTH', periodStart: '2026-10-01', periodEnd: '2026-10-31' }) // 同词不同周期种类可以并存
    await expect(sqp({ reportPeriod: 'YEAR', searchQuery: 'a' })).rejects.toMatchObject({ code: '23514' })
    await expect(sqp({ periodEnd: '2026-10-10', searchQuery: 'b' })).rejects.toMatchObject({ code: '23514' }) // 结束日早于起始日
    await expect(sqp({ clickShare: 1.5, searchQuery: 'c' })).rejects.toMatchObject({ code: '23514' }) // 份额存 0 到 1 的小数
    await expect(sqp({ clicksOwn: -1, searchQuery: 'd' })).rejects.toMatchObject({ code: '23514' })

    const term = (over: Record<string, unknown>) =>
      insertRow(client, 'BrandSearchTerm', { id: `t-${Math.random()}`, ...base, department: '', searchTerm: 'yoga mat', searchFrequencyRank: 10, ...over })
    expect(await term({})).toMatchObject({ clickedAsin1: null, clickShare1: null })
    await expect(term({})).rejects.toMatchObject({ code: '23505' })
    await expect(term({ searchTerm: 'x', searchFrequencyRank: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(term({ searchTerm: 'y', clickShare2: 2 })).rejects.toMatchObject({ code: '23514' })

    const basket = (over: Record<string, unknown>) => insertRow(client, 'BrandMarketBasket', { id: `b-${Math.random()}`, ...base, asin: A1, pairedAsin: X1, ...over })
    await basket({})
    await expect(basket({})).rejects.toMatchObject({ code: '23505' })
    await expect(basket({ pairedAsin: X1.replace('1', '2'), combinationPct: 1.2 })).rejects.toMatchObject({ code: '23514' })

    const repeat = (over: Record<string, unknown>) => insertRow(client, 'BrandRepeatPurchase', { id: `r-${Math.random()}`, ...base, asin: A1, ...over })
    await repeat({})
    await expect(repeat({})).rejects.toMatchObject({ code: '23505' })
    await expect(repeat({ asin: A2, repeatCustomersPct: 1.01 })).rejects.toMatchObject({ code: '23514' })

    const catalog = (over: Record<string, unknown>) => insertRow(client, 'BrandSearchCatalogPerformance', { id: `c-${Math.random()}`, ...base, asin: A1, ...over })
    await catalog({})
    await expect(catalog({})).rejects.toMatchObject({ code: '23505' })
    await expect(catalog({ asin: A2, purchases: -3 })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('品牌分析（真实数据库 + 完整应用）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let scoped: PrismaClient
  let a: Awaited<ReturnType<typeof seedTenant>>
  let b: Awaited<ReturnType<typeof seedTenant>>
  let s2: string
  let reader: { token: string }
  let noBrand: { token: string }
  let narrow: { token: string }
  let other: { token: string }
  let imports: {
    brandImporterFor: (type: string, scope: { tenantId: string; sellerAccountId: string }, options: Record<string, unknown>) => ((ctx: unknown, rows: unknown) => Promise<unknown>) | null
  }

  const scopeOf = (ids: typeof a) => ({ tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId })
  async function* rowsOf(items: Record<string, unknown>[]) {
    yield* items
  }
  const importReport = (ids: typeof a, type: string, items: Record<string, unknown>[], start = WEEK, end = '2026-10-17') =>
    runWithTenant(ids.tenantId, () => {
      const importer = imports.brandImporterFor(type, scopeOf(ids), { reportJobId: null, now: NOW, from: new Date(`${start}T00:00:00Z`), to: new Date(`${end}T00:00:00Z`) })!
      return importer({ prisma: scoped, logger } as never, rowsOf(items) as never)
    })
  const get = (member: { token: string }, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: { token: string }, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const count = async (table: string, ids: typeof a) => Number((await h.client.query(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [ids.tenantId])).rows[0].n)
  const usd = (amount: number) => ({ amount, currencyCode: 'USD' })

  const sqp = (asin: string, term: string, c: number[], dates: [string, string] = [WEEK, '2026-10-17']) => ({
    startDate: dates[0],
    endDate: dates[1],
    asin,
    searchQueryData: { searchQuery: term, searchQueryScore: 1, searchQueryVolume: c[0] },
    impressionData: { totalQueryImpressionCount: c[1], asinImpressionCount: c[2] },
    clickData: { totalClickCount: c[3], asinClickCount: c[4], totalMedianClickPrice: usd(20), asinMedianClickPrice: usd(22) },
    cartAddData: { totalCartAddCount: c[5], asinCartAddCount: c[6] },
    purchaseData: { totalPurchaseCount: c[7], asinPurchaseCount: c[8], totalMedianPurchasePrice: usd(20), asinMedianPurchasePrice: usd(21) },
  })
  const term = (over: Record<string, unknown>) => ({
    departmentName: 'Sports',
    searchTerm: 'Yoga Mat',
    searchFrequencyRank: 120,
    clickedAsin: A1,
    clickedItemName: '瑜伽垫',
    clickShareRank: 1,
    clickShare: 0.3,
    conversionShare: 0.2,
    ...over,
  })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'brand_analytics' })
    a = await h.createTenant('ba-a')
    b = await h.createTenant('ba-b')
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = '美国主店' WHERE id = $1`, [a.sellerAccountId])
    s2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-ba-2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-BA-2', displayName: '欧洲店' })).id
    reader = await h.createMember(a.tenantId, 'ba-read', ['analytics.brand.read'])
    noBrand = await h.createMember(a.tenantId, 'ba-none', ['analytics.read'])
    narrow = await h.createMember(a.tenantId, 'ba-narrow', ['analytics.brand.read'], { scopes: [{ sellerAccountId: s2 }] })
    other = await h.createMember(b.tenantId, 'ba-other', ['*'])
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('brand_analytics', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    imports = await import(/* @vite-ignore */ String('../../../worker/src/importers/brand/registry'))
    await insertRow(h.client, 'FbaProduct', { id: 'prod-ba-1', tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, sellerSku: 'SKU-1', asin: A1, title: '瑜伽垫', brand: 'Acme' })
    await insertRow(h.client, 'FbaProduct', { id: 'prod-ba-2', tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, sellerSku: 'SKU-2', asin: A2, title: '瑜伽砖', brand: 'Acme' })
  }, 180_000)
  afterAll(async () => {
    await h?.close()
    await base?.$disconnect()
  })

  it('搜索查询表现：导入本周与上周；重复导入不重复；接口按次数重算份额，给出与上一周期的变化', async () => {
    const type = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'
    const week = [sqp(A1, 'Yoga Mat', [12000, 1000, 250, 400, 80, 100, 15, 50, 5]), sqp(A1, 'yoga block', [3000, 500, 50, 200, 20, 50, 5, 20, 2])]
    expect(await importReport(a, type, week)).toEqual({ imported: 2, read: 2, skipped: 0 })
    await importReport(a, type, week) // 重复导入
    await importReport(a, type, [sqp(A1, 'yoga mat', [11000, 1000, 150, 400, 60, 100, 10, 50, 4], [PREV, '2026-10-10'])], PREV, '2026-10-10')
    await importReport(b, type, [sqp(A1, 'yoga mat', [999, 99, 99, 99, 99, 99, 99, 99, 99])])
    expect(await count('BrandSearchQueryPerformance', a)).toBe(3)
    const stored = (
      await h.client.query(`SELECT "searchQuery", "impressionShare", "purchasesOwn" FROM "BrandSearchQueryPerformance" WHERE "tenantId" = $1 AND "periodStart" = $2 ORDER BY 1`, [a.tenantId, WEEK])
    ).rows
    expect(stored.map(row => row.searchQuery)).toEqual(['yoga block', 'yoga mat']) // 搜索词统一小写
    expect(stored[0].impressionShare).toBeNull() // 官方没给份额：存空，不是 0

    const data = await ok(reader, `/analytics/brand/search-query?period=WEEK&periodStart=${WEEK}`)
    expect(data.state).toBe('OK')
    expect(data.period).toMatchObject({ kind: 'WEEK', start: WEEK, previousStart: PREV, available: [WEEK, PREV] })
    const stage = (key: string) => data.funnel.find((item: { key: string }) => item.key === key)
    expect(stage('impressions')).toMatchObject({ market: 1500, own: 300, share: 0.2 })
    expect(stage('purchases')).toMatchObject({ market: 70, own: 7, share: 0.1, previousShare: 0.08 })
    expect(stage('purchases').shareChange).toBeCloseTo(0.02, 6)
    expect(data.items.map((row: { searchQuery: string }) => row.searchQuery)).toEqual(['yoga mat', 'yoga block']) // 默认按搜索量降序
    expect(data.items[0].shares.purchase).toBeCloseTo(0.1, 6)
    expect(data.price.find((row: { stage: string }) => row.stage === 'purchase')).toMatchObject({ own: 21, market: 20 })
  })

  it('目录表现、热门搜索词（按排名合并进一行）、购物篮与重复购买：导入后接口给出确切结果', async () => {
    const catalog = 'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT'
    await importReport(a, catalog, [
      { asin: A1, impressionData: { impressionCount: 10000 }, clickData: { clickCount: 400 }, cartAddData: { cartAddCount: 60 }, purchaseData: { purchaseCount: 30, searchTrafficSales: usd(660) } },
    ])
    const catalogData = await ok(reader, `/analytics/brand/catalog?period=WEEK&periodStart=${WEEK}`)
    expect(catalogData.summary).toMatchObject({ impressions: 10000, clicks: 400, cartAdds: 60, purchases: 30, searchTrafficSales: 660 })
    expect(catalogData.summary.clickRate).toBeCloseTo(0.04, 6)
    expect(catalogData.items[0]).toMatchObject({ asin: A1, brand: 'Acme', title: '瑜伽垫' })

    const terms = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT'
    await importReport(a, terms, [term({}), term({ clickShareRank: 2, clickedAsin: X1, clickedItemName: '别家垫', clickShare: 0.2, conversionShare: 0.1 })])
    await importReport(a, terms, [term({ searchFrequencyRank: 100, clickShareRank: 2, clickShare: 0.25 })], PREV, '2026-10-10')
    expect(await count('BrandSearchTerm', a)).toBe(2) // 同词同周期的多行按点击份额排名合并
    const termData = await ok(reader, `/analytics/brand/search-terms?period=WEEK&periodStart=${WEEK}`)
    expect(termData.ownAsinCount).toBe(2)
    expect(termData.items).toHaveLength(1)
    expect(termData.items[0]).toMatchObject({ searchTerm: 'yoga mat', department: 'Sports', rank: 120, previousRank: 100, inTop3: true })
    expect(termData.items[0].slots.map((slot: { asin: string; own: boolean }) => [slot.asin, slot.own])).toEqual([
      [A1, true],
      [X1, false],
    ])

    const basket = 'GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT'
    await importReport(a, basket, [
      { asin: A1, purchasedAsin: A2, combinationPct: 0.12, purchasedRank: 1 },
      { asin: A1, purchasedAsin: X1, combinationPct: 0.06, purchasedRank: 2 },
    ])
    const basketData = await ok(reader, `/analytics/brand/market-basket?period=WEEK&periodStart=${WEEK}`)
    expect(basketData.items.map((row: { pairedAsin: string; pairedOwn: boolean; advice: string | null }) => [row.pairedAsin, row.pairedOwn, row.advice])).toEqual([
      [A2, true, 'BUNDLE'],
      [X1, false, 'PRODUCT_TARGETING'],
    ])

    const repeat = 'GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT'
    await importReport(a, repeat, [
      { asin: A1, orders: 100, uniqueCustomers: 80, repeatCustomersPctTotal: 0.2, repeatPurchaseRevenue: usd(500), repeatPurchaseRevenuePctTotal: 0.25 },
      { asin: A2, orders: 50, uniqueCustomers: 20, repeatCustomersPctTotal: 0.1, repeatPurchaseRevenue: usd(100), repeatPurchaseRevenuePctTotal: 0.1 },
    ])
    const repeatData = await ok(reader, `/analytics/brand/repeat-purchase?period=WEEK&periodStart=${WEEK}&dimension=BRAND`)
    expect(repeatData.summary).toMatchObject({ orders: 150, uniqueCustomers: 100, repeatRevenue: 600 })
    expect(repeatData.summary.repeatCustomersPct).toBeCloseTo(0.18, 6)
    expect(repeatData.items.map((row: { label: string }) => row.label)).toEqual(['Acme'])
  })

  it('权限、数据范围与跨企业隔离：缺品牌分析权限 403；只授权欧洲店看不到主店的数据；另一个企业什么也看不到', async () => {
    expect((await get(noBrand, `/analytics/brand/search-query`)).status).toBe(403)
    expect((await get(reader, `/analytics/brand/search-query?periodStart=2026-10-12`)).status).toBe(422) // 周起始日必须是周日
    const mine = await ok(narrow, `/analytics/brand/search-query?period=WEEK&periodStart=${WEEK}`)
    expect(mine.state).toBe('NO_DATA')
    expect(mine.stores.map((store: { sellerAccountId: string }) => store.sellerAccountId)).toEqual([s2])
    const theirs = await ok(other, `/analytics/brand/search-terms?period=WEEK&periodStart=${WEEK}`)
    expect(theirs.state).toBe('NO_DATA')
    expect(theirs.items).toEqual([])
    const visible = await runWithTenant(b.tenantId, () => scoped.brandSearchQueryPerformance.findMany({ select: { tenantId: true } }))
    expect(visible.length).toBe(1) // 企业 B 自己导入的那一行
    expect(visible.every(row => row.tenantId === b.tenantId)).toBe(true)
    expect(await runWithTenant(b.tenantId, () => scoped.brandSearchTerm.count())).toBe(0)
  })
})
