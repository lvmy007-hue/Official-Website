import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 促销与优惠券（P4-05，真实数据库 + 完整应用 + 后台同步器与报告导入器代码）：
// 迁移升级与回滚、检查约束与唯一键；用官方格式样例走一遍同步器与两份绩效报告导入器（租户行级隔离下写入、重复幂等）；
// 列表与详情（筛选、游标、绩效“尚未接入 / 尚无记录 / 有数字”）；用相对今天的销售、利润、订单折扣、费用事件跑一遍效果 / 成本 / 利润页签的真实查询；数据范围与跨企业隔离。

type Member = { userId: string; token: string }
const TARGET = '20261122010000_promotions'
const FIXTURES = join(__dirname, '../../../worker/fixtures/promotions')
const json = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
const NOW = new Date('2026-10-25T08:00:00Z')
const ZONE = 'America/Los_Angeles'
const dayText = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

describe('促销表迁移（P4-05）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('promotions_migrate')
    client = await db.connect('promotions_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean
  const TABLES = ['Promotion', 'PromotionItem', 'PromotionMetric', 'CouponMetric']

  it('升级建四张表、回滚全部删除、再次升级闭环成功；计数与数量由数据库约束，各表有唯一键，商品随促销级联删除', async () => {
    expect(await exists('Promotion')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of TABLES) expect(await exists(table)).toBe(true)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of TABLES) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'pro-mig')
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
    const when = '2026-10-20T00:00:00.000Z'
    const promotion = (over: Record<string, unknown>) =>
      insertRow(client, 'Promotion', { id: 'p-1', ...base, promotionId: 'P-1', promotionType: 'DEAL', title: 't', status: 'RUNNING', startAt: when, amazonUpdatedAt: when, ...over })
    expect(await promotion({})).toMatchObject({ itemCount: null, itemsForUpdatedAt: null, itemsTruncated: false, issuesJson: [], errorCount: 0, endAt: null })
    await expect(promotion({ id: 'p-2' })).rejects.toMatchObject({ code: '23505' }) // 同店铺同促销编号
    await expect(promotion({ id: 'p-3', promotionId: 'P-3', itemCount: -1 })).rejects.toMatchObject({ code: '23514' })
    // 亚马逊以后新增类型与状态值时不能让同步写不进去：不加检查约束
    await promotion({ id: 'p-4', promotionId: 'P-4', promotionType: 'SOMETHING_NEW', status: 'SOMETHING_ELSE' })

    const item = (over: Record<string, unknown>) => insertRow(client, 'PromotionItem', { id: 'i-1', ...base, promotionRowId: 'p-1', asin: 'B0A', sku: 'S', ...over })
    expect(await item({})).toMatchObject({ issuesJson: [] })
    await expect(item({ id: 'i-2' })).rejects.toMatchObject({ code: '23505' })
    const metric = (over: Record<string, unknown>) => insertRow(client, 'PromotionMetric', { id: 'm-1', ...base, mappingId: 'T1', asin: 'B0A', metricDate: '2026-10-21', ...over })
    expect(await metric({})).toMatchObject({ units: null, sales: null, currency: 'USD' })
    await expect(metric({ id: 'm-2' })).rejects.toMatchObject({ code: '23505' })
    await expect(metric({ id: 'm-3', asin: 'B0B', units: -1 })).rejects.toMatchObject({ code: '23514' })
    const coupon = (over: Record<string, unknown>) => insertRow(client, 'CouponMetric', { id: 'c-1', ...base, mappingId: 'T2', metricDate: '2026-10-21', ...over })
    expect(await coupon({})).toMatchObject({ clips: null, budgetSpent: null })
    await expect(coupon({ id: 'c-2' })).rejects.toMatchObject({ code: '23505' })
    await expect(coupon({ id: 'c-3', metricDate: '2026-10-22', clips: -5 })).rejects.toMatchObject({ code: '23514' })

    await client.query(`DELETE FROM "Promotion" WHERE "id" = 'p-1'`)
    expect((await client.query(`SELECT 1 FROM "PromotionItem" WHERE "id" = 'i-1'`)).rowCount).toBe(0)
  })
})

describe('促销与优惠券（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerAccountId: string
  let liveSellerId: string
  let owner: Member
  let reader: Member
  let noAccess: Member
  let scoped: Member
  let other: Member
  let tenantDb: PrismaClient
  type Run = (ctx: unknown, api: unknown, scope: { tenantId: string; sellerAccountId: string }, options?: { now?: Date }) => Promise<Record<string, unknown>>
  type Importer = (scope: { tenantId: string; sellerAccountId: string }, options?: { reportJobId?: string }) => (ctx: unknown, rows: unknown) => Promise<Record<string, unknown>>
  let sync: Run
  let promotionReport: Importer
  let couponReport: Importer
  let rowsOfFile: (name: string) => unknown

  const call = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await call(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const ctx = () => ({ prisma: tenantDb, logger: { warn: () => undefined, info: () => undefined, error: () => undefined } })
  const fakeApi = () => {
    const search = { ...json('search.json'), pagination: undefined }
    const second = json('selection-2.json') as { selection: { selectionDetails: Record<string, unknown> } }
    return {
      search: async () => search,
      selection: async (promotionId: string) =>
        promotionId === 'P-DEAL-1' ? json('selection-1.json') : { selection: { ...second.selection, selectionDetails: { ...second.selection.selectionDetails, pagination: undefined } } },
    }
  }
  const scope = (sellerId = sellerAccountId) => ({ tenantId, sellerAccountId: sellerId })
  const item = (list: Array<{ promotionId: string }>, promotionId: string) => list.find(entry => entry.promotionId === promotionId) as Record<string, unknown>

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'promotions', db })
    const a = await h.createTenant('pro-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = $1 WHERE "id" = $2`, [ZONE, tenantId])
    const makeSeller = async (id: string) => (await insertRow(h.client, 'SellerAccount', { id, tenantId, legalEntityId: a.legalEntityId, sellerId: id.toUpperCase() })).id as string
    liveSellerId = await makeSeller('seller-pro-live')
    const b = await h.createTenant('pro-b')
    owner = await h.createMember(tenantId, 'pro-owner', ['*'])
    reader = await h.createMember(tenantId, 'pro-reader', ['analytics.read'])
    noAccess = await h.createMember(tenantId, 'pro-none', ['orders.read'])
    scoped = await h.createMember(tenantId, 'pro-scoped', ['analytics.read'], { scopes: [{ sellerAccountId: liveSellerId }] })
    other = await h.createMember(b.tenantId, 'pro-other', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('promotions', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    sync = (await import(/* @vite-ignore */ String('../../../worker/src/importers/promotions/sync'))).syncPromotions
    const reports = await import(/* @vite-ignore */ String('../../../worker/src/importers/promotions/reports'))
    promotionReport = reports.promotionReportImporter
    couponReport = reports.couponReportImporter
    const streaming = await import(/* @vite-ignore */ String('../../../worker/src/streaming/rows'))
    rowsOfFile = (name: string) =>
      streaming.tsvRows(
        streaming.readLines(
          (async function* () {
            yield Buffer.from(readFileSync(join(FIXTURES, name), 'utf8'))
          })(),
        ),
      )
  })
  afterAll(async () => {
    await h?.close()
  })

  it('同步器：在行级隔离的租户连接下写入促销与商品清单；重复同步不重复写', async () => {
    const first = await runWithTenant(tenantId, () => sync(ctx(), fakeApi(), scope(), { now: NOW }))
    expect(first).toMatchObject({ promotions: 3, changed: 3, itemPromotions: 2, skipped: 2, incomplete: false })
    expect((await rows(`SELECT 1 FROM "Promotion" WHERE "tenantId" = $1`, [tenantId])).length).toBe(3)
    const itemCount = (await rows(`SELECT 1 FROM "PromotionItem" WHERE "tenantId" = $1`, [tenantId])).length
    expect(itemCount).toBeGreaterThan(0)
    const again = await runWithTenant(tenantId, () => sync(ctx(), fakeApi(), scope(), { now: NOW }))
    expect(again).toMatchObject({ changed: 0, itemPromotions: 0 })
    expect((await rows(`SELECT 1 FROM "PromotionItem" WHERE "tenantId" = $1`, [tenantId])).length).toBe(itemCount)
  })

  it('列表：按开始时间新到旧；类型、状态、关键词筛选；游标翻页不重复不遗漏；商品数、折扣力度、预算', async () => {
    const list = await ok(owner, '/promotions')
    expect(list.state).toBe('OK')
    expect(list.items.map((entry: { promotionId: string }) => entry.promotionId)).toEqual(['P-COUPON-1', 'P-DEAL-1', 'P-CAT-1'])
    expect(item(list.items, 'P-DEAL-1')).toMatchObject({ typeLabel: '秒杀', statusLabel: '进行中', title: '十月秒杀·厨房小家电', budget: { type: 'UNITS', value: 200 } })
    expect(item(list.items, 'P-COUPON-1')).toMatchObject({ typeLabel: '优惠券', statusLabel: '即将开始', discountText: '立减 15%', revisionStatus: 'FAILED', errorCount: 1 })
    expect(item(list.items, 'P-CAT-1')).toMatchObject({ typeLabel: '价格折扣', selectionType: 'CATALOG', itemCount: null })
    expect((await ok(owner, '/promotions?type=DEAL')).items).toHaveLength(1)
    expect((await ok(owner, '/promotions?status=EXPIRED')).items.map((entry: { promotionId: string }) => entry.promotionId)).toEqual(['P-CAT-1'])
    expect((await ok(owner, '/promotions?q=秒杀')).items).toHaveLength(1)
    expect((await ok(owner, '/promotions?q=P-COUPON')).items).toHaveLength(1)
    expect((await ok(owner, '/promotions?status=CANCELLED')).items).toEqual([])
    const page1 = await ok(owner, '/promotions?pageSize=2')
    expect(page1.pageInfo.hasMore).toBe(true)
    const page2 = await ok(owner, `/promotions?pageSize=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`)
    expect([...page1.items, ...page2.items].map((entry: { promotionId: string }) => entry.promotionId)).toEqual(['P-COUPON-1', 'P-DEAL-1', 'P-CAT-1'])
    expect(page2.pageInfo.hasMore).toBe(false)
  })

  it('绩效：报告没接入写“尚未接入”；导入两份报告并有成功记录后给数字，报告里没有的促销写“尚无记录”', async () => {
    const before = await ok(owner, '/promotions')
    expect(item(before.items, 'P-DEAL-1').reported).toMatchObject({ state: 'NOT_CONNECTED', units: null })
    const promo = await runWithTenant(tenantId, () => promotionReport(scope())(ctx(), rowsOfFile('promotion-report.tsv')))
    const coupon = await runWithTenant(tenantId, () => couponReport(scope())(ctx(), rowsOfFile('coupon-report.tsv')))
    expect(promo).toMatchObject({ imported: 2 })
    expect(coupon).toMatchObject({ imported: 2 })
    for (const key of ['rpt.promotion-performance', 'rpt.coupon-performance']) {
      await insertRow(h.client, 'DataFreshness', {
        id: `df-${key}`,
        tenantId,
        sellerAccountId,
        sourceKey: key,
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        status: 'NORMAL',
      })
    }
    const after = await ok(owner, '/promotions')
    expect(item(after.items, 'P-DEAL-1').reported).toEqual({ state: 'OK', units: 15, sales: 299.85, redemptions: 12 })
    expect(item(after.items, 'P-COUPON-1').reported).toMatchObject({ state: 'OK', units: null, sales: 90, redemptions: 9 })
    expect(item(after.items, 'P-CAT-1').reported).toEqual({ state: 'NO_RECORD', units: null, sales: null, redemptions: null })
  })

  it('平台费用：没有 finance.read 写“无权限”；按目录选品没有商品清单；价格折扣不适用；有清单但没有费用事件写“尚无记录”', async () => {
    const full = await ok(owner, '/promotions')
    expect(item(full.items, 'P-DEAL-1').platformFee).toEqual({ state: 'NO_DATA', amount: null })
    expect(item(full.items, 'P-CAT-1').platformFee).toEqual({ state: 'NOT_APPLICABLE', amount: null })
    const limited = await ok(reader, '/promotions')
    expect(limited.items.every((entry: { platformFee: { state: string } }) => entry.platformFee.state === 'RESTRICTED')).toBe(true)
  })

  it('详情：商品清单（折扣力度、商品级问题）、问题页签；按目录选品的促销没有商品清单，效果与利润直接说明原因；写入口不存在', async () => {
    const detail = await ok(owner, '/promotions/P-DEAL-1')
    expect(detail.items).toMatchObject({ state: 'OK', selectionType: 'ITEMS' })
    expect(detail.items.items.map((entry: { asin: string }) => entry.asin)).toEqual(['B0TESTASIN1', 'B0TESTASIN2'])
    expect(detail.items.items[0]).toMatchObject({ sku: 'SKU-1', benefitText: '立减 20%', perCustomerUses: 1 })
    expect(detail.items.items[1]).toMatchObject({ benefitText: '固定价 $19.99', issues: [{ code: 'LOW_STOCK', severity: 'WARNING' }] })
    expect(detail.issues).toMatchObject({ state: 'OK', itemIssueCount: 1, promotionIssues: [{ code: 'PRICE_NEAR_FLOOR' }] })
    expect(detail.cost.feePreview).toMatchObject({ upfront: { amount: 150, currency: 'USD', frequency: 'ONE_TIME' }, variablePct: 2, capAmount: 25 })
    expect(detail.write).toMatchObject({ supported: false })
    expect(detail.methodNote).toContain('不是亚马逊给的数字')
    const catalog = await ok(owner, '/promotions/P-CAT-1')
    expect([catalog.effect.state, catalog.items.state, catalog.profit.state]).toEqual(['NO_ITEMS', 'NO_ITEMS', 'NO_ITEMS'])
    expect((await h.call(owner.token, 'POST', '/promotions/P-DEAL-1', { body: {} })).status).toBe(404)
  })

  it('效果、成本与利润页签的真实查询：基线法增量、折扣成本、平台费用、增量毛利与促销投入回报率', async () => {
    const today = dayText(new Date())
    const startDay = shift(today, -9)
    const base = { tenantId, sellerAccountId: liveSellerId }
    const when = new Date().toISOString()
    await insertRow(h.client, 'Promotion', {
      id: 'pr-live',
      ...base,
      promotionId: 'P-LIVE',
      promotionType: 'DEAL',
      title: '进行中的秒杀',
      status: 'RUNNING',
      startAt: `${startDay}T20:00:00.000Z`,
      amazonUpdatedAt: when,
      mappingId: 'TRK-LIVE',
      selectionType: 'ITEMS',
      itemCount: 1,
    })
    await insertRow(h.client, 'PromotionItem', { id: 'pi-live', ...base, promotionRowId: 'pr-live', asin: 'B0LIVE0001', sku: 'SKU-L' })
    for (let index = 0; index < 38; index += 1) {
      const date = shift(startDay, index - 28)
      const units = date >= startDay ? 30 : 10
      await insertRow(h.client, 'AsinDailySummary', { id: `ads-live-${index}`, ...base, summaryDate: date, asin: 'B0LIVE0001', sku: 'SKU-L', units, salesAmount: units * 20, metricVersion: 'v1' })
      await insertRow(h.client, 'ProfitDaily', {
        id: `pd-live-${index}`,
        ...base,
        profitDate: date,
        sku: 'SKU-L',
        asin: 'B0LIVE0001',
        basis: 'ORDERED',
        costing: 'FIFO',
        units,
        profit: units * 5,
        metricVersion: 'v1',
      })
    }
    const purchaseDate = `${shift(today, -3)}T12:00:00.000Z`
    await insertRow(h.client, 'Order', { id: 'o-live', ...base, purchaseDate, amazonOrderId: '111-0000000-0000001' })
    await insertRow(h.client, 'OrderItem', {
      id: 'oi-live',
      ...base,
      orderId: 'o-live',
      orderPurchaseDate: purchaseDate,
      amazonOrderId: '111-0000000-0000001',
      orderItemId: 'oi1',
      asin: 'B0LIVE0001',
      promotionDiscount: 40,
    })
    await insertRow(h.client, 'FbaFeeEvent', {
      id: 'fe-live',
      ...base,
      asin: 'B0LIVE0001',
      eventType: 'DealParticipationFee',
      feeCategory: 'OTHER',
      amount: -30,
      postedAt: `${shift(today, -2)}T12:00:00.000Z`,
      sourceEventId: 'fe-live-1',
      sourceUpdatedAt: when,
    })
    const detail = await ok(owner, '/promotions/P-LIVE')
    expect(detail.effect).toMatchObject({
      state: 'OK',
      window: { from: startDay, to: today, days: 10 },
      baseline: { state: 'OK', usedDays: 28, excludedDays: 0 },
      actual: { units: 300, sales: 6000 },
      expected: { units: 100, sales: 2000 },
      incremental: { units: 200, sales: 4000, liftPct: 200 },
    })
    expect(detail.cost.discount).toMatchObject({ state: 'OK', amount: 40, orderLines: 1 })
    expect(detail.cost.platformFee).toMatchObject({ state: 'OK', amount: 30 })
    expect(detail.cost.total).toBe(70)
    expect(detail.profit).toMatchObject({ state: 'OK', actualProfit: 1500, expectedProfit: 500, incrementalProfit: 1000 })
    expect(detail.profit.roi).toMatchObject({ value: 14.29, denominator: 70 })
    expect(item((await ok(owner, '/promotions')).items, 'P-LIVE').platformFee).toEqual({ state: 'OK', amount: 30 })
    // 只有 analytics.read：效果照常，成本、利润、广告写“无权限”
    const limited = await ok(reader, '/promotions/P-LIVE')
    expect(limited.effect.state).toBe('OK')
    expect([limited.cost.discount.state, limited.cost.platformFee.state, limited.profit.state, limited.ads.state]).toEqual(['RESTRICTED', 'RESTRICTED', 'RESTRICTED', 'RESTRICTED'])
    expect(limited.profit).toMatchObject({ actualProfit: null, expectedProfit: null, incrementalProfit: null })
    // 同店铺里有另一个覆盖基线期的促销时，那些日子不进基线
    await insertRow(h.client, 'Promotion', {
      id: 'pr-live-2',
      ...base,
      promotionId: 'P-LIVE-2',
      promotionType: 'PRICE_DISCOUNT',
      title: '全目录折扣',
      status: 'EXPIRED',
      startAt: `${shift(startDay, -28)}T20:00:00.000Z`,
      endAt: `${shift(startDay, -3)}T20:00:00.000Z`,
      amazonUpdatedAt: when,
      selectionType: 'CATALOG',
    })
    const blocked = await ok(owner, '/promotions/P-LIVE')
    expect(blocked.effect.baseline).toMatchObject({ state: 'INSUFFICIENT', usedDays: 2 })
    expect(blocked.effect.incremental).toEqual({ units: null, sales: null, liftPct: null })
    expect(blocked.profit.state).toBe('INSUFFICIENT')
  })

  it('权限与范围：没有 analytics.read 403；范围外的店铺看不到列表与详情；其他企业看不到', async () => {
    expect((await call(noAccess, '/promotions')).status).toBe(403)
    expect((await call(noAccess, '/promotions/P-DEAL-1')).status).toBe(403)
    expect((await ok(scoped, '/promotions')).items.map((entry: { promotionId: string }) => entry.promotionId).sort()).toEqual(['P-LIVE', 'P-LIVE-2'])
    expect((await call(scoped, '/promotions/P-DEAL-1')).status).toBe(404)
    expect((await ok(other, '/promotions')).items).toEqual([])
    expect((await call(other, '/promotions/P-DEAL-1')).status).toBe(404)
    // 行级隔离：别的企业的租户连接直接查表也看不到
    expect(await runWithTenant('tenant-pro-b', () => tenantDb.promotion.count())).toBe(0)
    expect(await runWithTenant('tenant-pro-b', () => tenantDb.promotionMetric.count())).toBe(0)
  })

  it('同步没有促销的店铺：没同步过写“尚未同步”；接口角色没批给申请方式；同步正常写“尚无记录”', async () => {
    const mine = await h.createTenant('pro-c')
    const member = await h.createMember(mine.tenantId, 'pro-c-owner', ['*'])
    expect((await ok(member, '/promotions')).state).toBe('NOT_CONNECTED')
    await insertRow(h.client, 'DataFreshness', {
      id: 'df-pro-c',
      tenantId: mine.tenantId,
      sellerAccountId: mine.sellerAccountId,
      sourceKey: 'promotions.api',
      lastAttemptAt: new Date().toISOString(),
      status: 'UNAUTHORIZED',
      lastErrorCode: 'ROLE_MISSING',
    })
    expect(await ok(member, '/promotions')).toMatchObject({ state: 'ROLE_PENDING', sync: { rolePending: true } })
    await h.client.query(`UPDATE "DataFreshness" SET "status" = 'NORMAL', "lastErrorCode" = NULL, "lastSuccessAt" = now() WHERE "id" = 'df-pro-c'`)
    const normal = await ok(member, '/promotions')
    expect(normal.state).toBe('NO_DATA')
    expect(normal.note).toContain('尚无记录')
  })
})
