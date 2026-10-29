import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 订阅省页面（P4-06，真实数据库 + 完整应用 + 后台同步器代码）：
// 用官方格式样例走一遍同步器（租户行级隔离下写入、重复同步幂等）；用相对今天的日级与月度指标跑概览（指标卡、趋势、月度）；
// 报价只读每个店铺最近一次快照、快照超过 7 天的店铺不进预测；明细列表与游标；没有数据的四种原因；数据范围与跨企业隔离。

type Member = { userId: string; token: string }
type SyncApi = { listOffers: () => Promise<unknown>; listOfferMetrics: () => Promise<unknown>; sellerMetrics: () => Promise<unknown> }
const FIXTURES = join(__dirname, '../../../worker/fixtures/replenishment')
const json = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
const dayText = (date: Date) => date.toISOString().slice(0, 10)
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

describe('订阅省（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let owner: Member
  let noAccess: Member
  let scopedB: Member
  let other: Member
  let tenantDb: PrismaClient
  let sync: (ctx: unknown, api: unknown, scope: { tenantId: string; sellerAccountId: string }, options: { today: Date }) => Promise<Record<string, unknown>>
  const today = dayText(new Date())

  const call = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await call(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const count = async (table: string, id = tenantId) => Number((await h.client.query(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [id])).rows[0].n)
  const ctx = () => ({ prisma: tenantDb, logger: { warn: () => undefined, info: () => undefined, error: () => undefined } })
  const fakeApi = (): SyncApi => ({ listOffers: async () => json('offers.json'), listOfferMetrics: async () => json('offer-metrics.json'), sellerMetrics: async () => ({ metrics: [] }) })
  const card = (data: { cards: Array<{ key: string }> }, key: string) => data.cards.find(item => item.key === key) as Record<string, unknown>

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'subscribe_save', db })
    const a = await h.createTenant('sns-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" = $1`, [tenantId])
    storeB = (await insertRow(h.client, 'SellerAccount', { id: 'seller-sns-b', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-SNS-B', displayName: '加拿大店' })).id as string
    const b = await h.createTenant('sns-other')
    owner = await h.createMember(tenantId, 'sns-owner', ['*'])
    noAccess = await h.createMember(tenantId, 'sns-none', ['orders.read'])
    scopedB = await h.createMember(tenantId, 'sns-scoped', ['analytics.read'], { scopes: [{ sellerAccountId: storeB }] })
    other = await h.createMember(b.tenantId, 'sns-other-owner', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('subscribe_save', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    sync = (await import(/* @vite-ignore */ String('../../../worker/src/importers/replenishment/subscribe-save'))).syncSubscribeSave
  })
  afterAll(async () => {
    await h?.close()
  })

  const seedFreshness = async (sellerAccountId: string, id: string) =>
    insertRow(h.client, 'DataFreshness', {
      id,
      tenantId,
      sellerAccountId,
      sourceKey: 'replenishment.api',
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      status: 'NORMAL',
    })

  it('空库：没同步过写“尚未同步”，同步正常但没记录写“尚无记录”，两种都不给数字', async () => {
    const empty = await ok(owner, '/subscribe-save')
    expect(empty.state).toBe('NOT_CONNECTED')
    expect(empty.cards.every((item: { value: number | null }) => item.value === null)).toBe(true)
    await seedFreshness(storeA, 'df-sns-a')
    await seedFreshness(storeB, 'df-sns-b')
    const normal = await ok(owner, '/subscribe-save')
    expect(normal.state).toBe('NO_DATA')
    expect(normal.note).toContain('尚无记录')
    expect((await ok(owner, '/subscribe-save/offers')).items).toEqual([])
  })

  it('同步器：在行级隔离的租户连接下写入报价；重复同步不重复写', async () => {
    const first = await runWithTenant(tenantId, () => sync(ctx(), fakeApi(), { tenantId, sellerAccountId: storeA }, { today: new Date(`${today}T00:00:00Z`) }))
    expect(first).toMatchObject({ notApplicable: false, offers: 2, skipped: 1 })
    expect(await count('SubscribeSaveOffer')).toBe(2)
    await runWithTenant(tenantId, () => sync(ctx(), fakeApi(), { tenantId, sellerAccountId: storeA }, { today: new Date(`${today}T00:00:00Z`) }))
    expect(await count('SubscribeSaveOffer')).toBe(2)
  })

  it('造数：另一家店的过期快照、本店更早的旧快照，以及相对今天的日级与月度指标', async () => {
    // 本店更早的旧快照：只应读最近一次快照，旧的 SKU 不出现
    await insertRow(h.client, 'SubscribeSaveOffer', {
      id: 'o-old',
      tenantId,
      sellerAccountId: storeA,
      snapshotDate: shift(today, -20),
      sku: 'SKU-OLD',
      asin: 'B0OLD00000',
      eligibility: 'ELIGIBLE',
      forecastNext30: 999,
    })
    // 另一家店：快照在 10 天前，超过 7 天，不进预测
    await insertRow(h.client, 'SubscribeSaveOffer', {
      id: 'o-b',
      tenantId,
      sellerAccountId: storeB,
      snapshotDate: shift(today, -10),
      sku: 'SKU-L',
      asin: 'B0LIVE0001',
      eligibility: 'ELIGIBLE',
      forecastNext30: 50,
      forecastNext60: 90,
      forecastNext90: 120,
      shippedUnitsPrevMonth: 40,
      prevMonthDays: 30,
      subscriptions: 7,
    })
    const metric = (id: string, sellerAccountId: string, granularity: string, metricDate: string, over: Record<string, unknown>) =>
      insertRow(h.client, 'SubscribeSaveMetric', { id, tenantId, sellerAccountId, granularity, metricDate, currency: 'USD', ...over })
    await metric('m-a1', storeA, 'DAY', shift(today, -3), { activeSubscribers: 40, shippedUnits: 10, revenue: 199.9 })
    await metric('m-a2', storeA, 'DAY', shift(today, -2), { activeSubscribers: 41, shippedUnits: 12, revenue: 239.88 })
    await metric('m-b1', storeB, 'DAY', shift(today, -2), { activeSubscribers: 9, shippedUnits: 5, revenue: 50 })
    // 对比期（前 30 天）
    await metric('m-a0', storeA, 'DAY', shift(today, -35), { activeSubscribers: 30, shippedUnits: 8, revenue: 100 })
    const monthStart = `${today.slice(0, 7)}-01`
    await metric('m-m1', storeA, 'MONTH', shift(monthStart, -1).slice(0, 7) + '-01', { activeSubscribers: 38, shippedUnits: 300, revenue: 5000 })
    expect(await count('SubscribeSaveMetric')).toBe(5)
  })

  it('概览：指标卡、对比期、逐日趋势、月度；取消数尚未接入；过期店铺的预测不计入', async () => {
    const data = await ok(owner, '/subscribe-save')
    expect(data.state).toBe('OK')
    expect(card(data, 'activeSubscribers')).toMatchObject({ value: 50, note: `截至 ${shift(today, -2)}` })
    expect(card(data, 'shippedUnits')).toMatchObject({ value: 27, previous: 8 })
    expect(card(data, 'revenue')).toMatchObject({ value: 489.78, currency: 'USD', previous: 100 })
    expect(card(data, 'cancellations')).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(card(data, 'forecast30')).toMatchObject({ state: 'OK', value: 36 })
    expect(card(data, 'forecast90')).toMatchObject({ value: 101 })
    expect(card(data, 'offers')).toMatchObject({ value: 3 })
    expect(data.trend.points).toHaveLength(30)
    expect(data.trend.coverage).toEqual({ dataDays: 2, rangeDays: 30 })
    expect(data.trend.points.find((point: { date: string }) => point.date === shift(today, -2))).toMatchObject({ activeSubscribers: 50, shippedUnits: 17, revenue: 289.88 })
    expect(data.trend.points.find((point: { date: string }) => point.date === today)).toMatchObject({ shippedUnits: null, revenue: null })
    expect(data.trend.months).toHaveLength(1)
    expect(data.trend.months[0]).toMatchObject({ shippedUnits: 300, revenue: 5000 })
    expect(data.forecast).toMatchObject({ snapshotDate: today, offers: 3, offersWithForecast: 2, usedInReplenishment: 1 })
    expect(data.forecast.staleStores).toEqual(['加拿大店'])
    // 补货采用：同步样例里 SKU-A 可订阅且有预测与上月订阅出货；SKU-B 已暂停、SKU-L 的快照已过期，都不采用
  })

  it('选范围：只含所选日期的日级记录，对比期没有记录时给空值而不是 0', async () => {
    const data = await ok(owner, `/subscribe-save?from=${shift(today, -2)}&to=${shift(today, -1)}`)
    expect(data.range).toMatchObject({ days: 2 })
    expect(card(data, 'shippedUnits')).toMatchObject({ value: 17, previous: null })
  })

  it('报价列表：只读每家店最近一次快照；可订阅状态筛选与排序；游标翻页不重不漏', async () => {
    const all = await ok(owner, '/subscribe-save/offers?sort=forecastNext30:desc')
    expect(all.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-L', 'SKU-A', 'SKU-B'])
    expect(all.items.map((row: { sku: string }) => row.sku)).not.toContain('SKU-OLD')
    expect(all.staleStores).toEqual(['加拿大店'])
    const byRow = (sku: string) => all.items.find((row: { sku: string }) => row.sku === sku)
    expect(byRow('SKU-A')).toMatchObject({
      eligibilityLabel: '可订阅',
      discountPct: 5,
      price: 19.99,
      inventory: 320,
      subscriptions: 41,
      forecastNext30: 36,
      replenishment: { used: true, reason: null },
    })
    expect(byRow('SKU-B')).toMatchObject({ eligibilityLabel: '已暂停', forecastNext30: null, replenishment: { used: false, reason: 'INELIGIBLE' } })
    expect(byRow('SKU-L')).toMatchObject({ storeName: '加拿大店', replenishment: { used: false, reason: 'STALE' } })
    expect((await ok(owner, '/subscribe-save/offers?eligibility=SUSPENDED')).items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-B'])
    const page1 = await ok(owner, '/subscribe-save/offers?pageSize=2')
    const page2 = await ok(owner, `/subscribe-save/offers?pageSize=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`)
    expect([...page1.items, ...page2.items].map((row: { sku: string }) => row.sku)).toEqual(['SKU-L', 'SKU-A', 'SKU-B'])
    expect(page2.pageInfo.hasMore).toBe(false)
  })

  it('ASIN 明细：按 ASIN 合并；ASIN 360 编号取自商品主数据，没有对应商品就是空', async () => {
    await insertRow(h.client, 'FbaProduct', { id: 'p-sns-a', tenantId, sellerAccountId: storeA, asin: 'B0AAAAAAA1', sellerSku: 'SKU-A' })
    const data = await ok(owner, '/subscribe-save/asins')
    expect(data.items.map((row: { asin: string }) => row.asin)).toEqual(['B0LIVE0001', 'B0AAAAAAA1', 'B0BBBBBBB2'])
    expect(data.items.find((row: { asin: string }) => row.asin === 'B0AAAAAAA1')).toMatchObject({ skus: ['SKU-A'], productId: 'p-sns-a', subscriptions: 41, forecastNext30: 36 })
    expect(data.items.find((row: { asin: string }) => row.asin === 'B0LIVE0001').productId).toBeNull()
    expect((await ok(owner, '/subscribe-save/asins?q=bbbb')).items).toHaveLength(1)
  })

  it('权限与范围：没有 analytics.read 403；只授权加拿大店时只看到它；其他企业看不到任何数据', async () => {
    for (const path of ['/subscribe-save', '/subscribe-save/asins', '/subscribe-save/offers']) expect((await call(noAccess, path)).status, path).toBe(403)
    const scoped = await ok(scopedB, '/subscribe-save')
    expect(card(scoped, 'shippedUnits')).toMatchObject({ value: 5 })
    expect(card(scoped, 'offers')).toMatchObject({ value: 1 })
    expect(card(scoped, 'forecast30')).toMatchObject({ state: 'STALE', value: null })
    expect((await ok(scopedB, '/subscribe-save/offers')).items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-L'])
    const alien = await ok(other, '/subscribe-save')
    expect(alien.state).toBe('NOT_CONNECTED')
    expect(alien.cards.every((item: { value: number | null }) => item.value === null)).toBe(true)
    expect((await ok(other, '/subscribe-save/offers')).items).toEqual([])
    // 行级隔离：别的企业的租户连接直接查表也看不到
    expect(await runWithTenant('tenant-sns-other', () => tenantDb.subscribeSaveMetric.count())).toBe(0)
    expect(await runWithTenant('tenant-sns-other', () => tenantDb.subscribeSaveOffer.count())).toBe(0)
  })

  it('没有写入口', async () => {
    expect((await h.call(owner.token, 'POST', '/subscribe-save', { body: {} })).status).toBe(404)
    expect((await h.call(owner.token, 'DELETE', '/subscribe-save/offers', { body: {} })).status).toBe(404)
  })
})
