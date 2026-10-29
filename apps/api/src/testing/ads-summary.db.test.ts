import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { MIGRATIONS_DIR, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P3-04 验收（真实数据库）：广告日汇总（AdsDailySummary）与经营日汇总里的广告花费、广告销售额。
// 刷新代码在后台任务进程里；这里按路径动态加载，让接口服务的编译范围不包含后台任务代码（测试专用）。
type Range = { tenantId: string; dateFrom: string; dateTo: string }
type Refresh = (db: unknown, range: Range) => Promise<number>
const loadRefreshers = async () => {
  const ads = await import(/* @vite-ignore */ String('../../../worker/src/derivers/ads-summary-sql'))
  const summary = await import(/* @vite-ignore */ String('../../../worker/src/derivers/summary-sql'))
  return { ads: ads.refreshAdsDailySummary as Refresh, store: summary.refreshStoreDailySummary as Refresh, version: ads.ADS_SUMMARY_VERSION as string }
}

describe('广告日汇总（P3-04，真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let ads: Refresh
  let store: Refresh
  let version: string
  let a: Awaited<ReturnType<typeof seedTenant>>
  let b: Awaited<ReturnType<typeof seedTenant>>
  let seq = 0

  const metric = (ids: typeof a, profile: string, day: string, campaign: string | null, patch: Record<string, unknown> = {}) =>
    insertRow(admin, 'AdsMetric', {
      id: `m-${++seq}`,
      tenantId: ids.tenantId,
      adsProfileId: profile,
      reportDate: `${day}T00:00:00.000Z`,
      externalCampaignId: campaign,
      adProduct: 'SPONSORED_PRODUCTS',
      currency: 'USD',
      ...patch,
    })
  const adsRows = async (ids: typeof a) =>
    (
      await admin.query(
        `SELECT "adsProfileId" AS profile, "adsAccountId" AS account, "adProduct" AS product, "campaignId" AS campaign, to_char("summaryDate", 'YYYY-MM-DD') AS d, ` +
          `"impressions", "clicks", "spend"::float AS spend, "sales"::float AS sales, "orders", "currency", "metricVersion"` +
          ` FROM "AdsDailySummary" WHERE "tenantId" = $1 ORDER BY "adsProfileId", "summaryDate", "currency", "adProduct", "campaignId"`,
        [ids.tenantId],
      )
    ).rows
  const storeRows = async (ids: typeof a) =>
    (
      await admin.query(
        `SELECT to_char("summaryDate", 'YYYY-MM-DD') AS d, "orders", "adsSpend"::float AS spend, "adsSales"::float AS sales FROM "StoreDailySummary" WHERE "tenantId" = $1 ORDER BY 1`,
        [ids.tenantId],
      )
    ).rows
  const inTenant = <T>(ids: typeof a, fn: () => Promise<T>) => runWithTenant(ids.tenantId, fn)
  const range = (ids: typeof a, patch: Partial<Range> = {}): Range => ({ tenantId: ids.tenantId, dateFrom: '2026-10-01', dateTo: '2026-10-10', ...patch })

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('ads_summary')
    db.migrate('ads_summary')
    admin = await db.connect('ads_summary')
    a = await seedTenant(admin, 'a')
    b = await seedTenant(admin, 'b')
    base = new PrismaClient({ datasourceUrl: db.urlFor('ads_summary', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ;({ ads, store, version } = await loadRefreshers())

    // 租户 A：ap-1 绑定店铺（带账户编号）、ap-2 未绑定
    await insertRow(admin, 'AdsProfile', { id: 'ap-1', tenantId: a.tenantId, profileId: 'P-1', sellerAccountId: a.sellerAccountId, bindingStatus: 'MANUAL', adsAccountId: 'ACCT-1' })
    await insertRow(admin, 'AdsProfile', { id: 'ap-2', tenantId: a.tenantId, profileId: 'P-2' })
    await metric(a, 'ap-1', '2026-10-05', 'C1', { cost: 10.5, sales: 40, purchases: 2, clicks: 20, impressions: 1000 })
    await metric(a, 'ap-1', '2026-10-05', 'C1', { adProduct: 'SPONSORED_BRANDS', cost: 4, sales: 0, purchases: 0, clicks: 3, impressions: 90 })
    await metric(a, 'ap-1', '2026-10-05', 'C2', { cost: 1, sales: 3, purchases: 1, clicks: 1, impressions: 10 })
    await metric(a, 'ap-1', '2026-10-05', 'C3', { currency: 'EUR', cost: 100, sales: 300, purchases: 5 })
    await metric(a, 'ap-1', '2026-10-05', 'AG-1', { entityType: 'AD_GROUP', entityId: 'AG-1', cost: 99, sales: 99, purchases: 9 }) // 广告组行：同一笔花费的拆分，不进汇总
    await metric(a, 'ap-1', '2026-10-06', 'C1', { cost: null, sales: null, clicks: 2, impressions: 50 }) // 来源没给金额
    await metric(a, 'ap-1', '2026-09-01', 'C1', { cost: 5, sales: 5 }) // 范围之外
    await metric(a, 'ap-2', '2026-10-05', 'C9', { cost: 7, sales: 21, purchases: 1, clicks: 4, impressions: 80 })
    await insertRow(admin, 'Order', {
      id: 'o-1',
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      amazonOrderId: '111-0000001-0000001',
      purchaseDate: '2026-10-05T20:00:00Z',
      status: 'Shipped',
      currency: 'USD',
      sourceUpdatedAt: '2026-10-05T20:00:00Z',
    })
    // 租户 B：自己的档案与指标
    await insertRow(admin, 'AdsProfile', { id: 'ap-b', tenantId: b.tenantId, profileId: 'P-b', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })
    await metric(b, 'ap-b', '2026-10-05', 'CB', { cost: 8, sales: 16, purchases: 2 })
  })
  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('广告日汇总：按档案、广告产品、活动、日、币种汇总活动级行；不含广告组行与范围之外的日期；没给金额的保持为空；未绑定的档案也汇总', async () => {
    expect(await inTenant(a, () => ads(scoped, range(a)))).toBe(6)
    const rows = await adsRows(a)
    const key = (row: (typeof rows)[number]) => [row.profile, row.d, row.currency, row.product, row.campaign].join('|')
    expect(rows.map(key)).toEqual([
      'ap-1|2026-10-05|EUR|SPONSORED_PRODUCTS|C3',
      'ap-1|2026-10-05|USD|SPONSORED_BRANDS|C1',
      'ap-1|2026-10-05|USD|SPONSORED_PRODUCTS|C1',
      'ap-1|2026-10-05|USD|SPONSORED_PRODUCTS|C2',
      'ap-1|2026-10-06|USD|SPONSORED_PRODUCTS|C1',
      'ap-2|2026-10-05|USD|SPONSORED_PRODUCTS|C9',
    ])
    const byKey = new Map(rows.map(row => [key(row), row]))
    expect(byKey.get('ap-1|2026-10-05|USD|SPONSORED_PRODUCTS|C1')).toMatchObject({ spend: 10.5, sales: 40, orders: 2, clicks: 20, impressions: 1000, account: 'ACCT-1', metricVersion: version })
    expect(byKey.get('ap-1|2026-10-05|USD|SPONSORED_BRANDS|C1')).toMatchObject({ spend: 4, sales: 0, orders: 0, clicks: 3 })
    expect(byKey.get('ap-1|2026-10-05|EUR|SPONSORED_PRODUCTS|C3')).toMatchObject({ spend: 100, sales: 300, orders: 5 })
    expect(byKey.get('ap-1|2026-10-06|USD|SPONSORED_PRODUCTS|C1')).toMatchObject({ spend: null, sales: null, orders: 0, clicks: 2, impressions: 50 })
    expect(byKey.get('ap-2|2026-10-05|USD|SPONSORED_PRODUCTS|C9')).toMatchObject({ spend: 7, sales: 21, account: null })
    expect(rows.some(row => row.spend === 99)).toBe(false)
  })

  it('广告日汇总：活动编号没有时取对象编号，同一活动的新旧格式行求和；账户编号优先取来源行再取档案', async () => {
    await insertRow(admin, 'AdsAccount', { id: 'acc-x', tenantId: a.tenantId, adsProfileId: 'ap-1', adsAccountId: 'ACCT-ROW', name: '账户' })
    await metric(a, 'ap-1', '2026-10-07', 'C5', { cost: 2, sales: 6, purchases: 1, clicks: 1 }) // 旧格式：只有活动编号，没有账户编号
    await metric(a, 'ap-1', '2026-10-07', null, { adsAccountId: 'ACCT-ROW', entityId: 'C5', cost: 3, clicks: 2 }) // 新格式：活动编号为空，对象编号是活动
    await inTenant(a, () => ads(scoped, range(a, { dateFrom: '2026-10-07', dateTo: '2026-10-07' })))
    const rows = (await adsRows(a)).filter(row => row.d === '2026-10-07')
    expect(rows.map(row => [row.campaign, row.account, row.spend, row.sales, row.clicks])).toEqual([['C5', 'ACCT-ROW', 5, 6, 3]])
    // 清理，保持后面的断言只面对前一个用例的数据
    await admin.query(`DELETE FROM "AdsMetric" WHERE "tenantId" = $1 AND "reportDate" = '2026-10-07'`, [a.tenantId])
    await inTenant(a, () => ads(scoped, range(a)))
    await admin.query(`DELETE FROM "AdsAccount" WHERE id = 'acc-x'`)
    expect((await adsRows(a)).length).toBe(6)
  })

  it('经营日汇总：只汇总已绑定店铺的美元活动级指标，订单日与广告日合并；没有金额的日子保持为空；未绑定与欧元不计', async () => {
    await inTenant(a, () => store(scoped, range(a)))
    expect(await storeRows(a)).toEqual([
      { d: '2026-10-05', orders: 1, spend: 15.5, sales: 43 },
      { d: '2026-10-06', orders: 0, spend: null, sales: null },
    ])
  })

  it('可重复执行：同一范围再刷新一次，结果完全相同', async () => {
    const before = [await adsRows(a), await storeRows(a)]
    expect(await inTenant(a, () => ads(scoped, range(a)))).toBe(6)
    await inTenant(a, () => store(scoped, range(a)))
    expect([await adsRows(a), await storeRows(a)]).toEqual(before)
  })

  it('只重算范围内的日期：范围外的旧汇总保留；源数据变化后重算得到新值；删掉源数据后对应汇总行消失', async () => {
    await insertRow(admin, 'AdsDailySummary', {
      id: 'keep-old',
      tenantId: a.tenantId,
      adsProfileId: 'ap-1',
      adProduct: 'SPONSORED_PRODUCTS',
      campaignId: 'OLD',
      summaryDate: '2026-09-01',
      metricVersion: 'old',
      spend: 1,
    })
    await admin.query(`UPDATE "AdsMetric" SET "cost" = 11.5 WHERE "tenantId" = $1 AND "externalCampaignId" = 'C1' AND "adProduct" = 'SPONSORED_PRODUCTS' AND "reportDate" = '2026-10-05'`, [a.tenantId])
    await inTenant(a, () => ads(scoped, range(a, { dateFrom: '2026-10-05', dateTo: '2026-10-05' })))
    const rows = await adsRows(a)
    expect(rows.find(row => row.campaign === 'OLD')).toMatchObject({ d: '2026-09-01', spend: 1 })
    expect(rows.find(row => row.campaign === 'C1' && row.d === '2026-10-05' && row.product === 'SPONSORED_PRODUCTS')?.spend).toBe(11.5)
    expect(rows.find(row => row.d === '2026-10-06')).toBeTruthy()
    await admin.query(`DELETE FROM "AdsMetric" WHERE "tenantId" = $1 AND "externalCampaignId" = 'C2'`, [a.tenantId])
    await inTenant(a, () => ads(scoped, range(a)))
    expect((await adsRows(a)).some(row => row.campaign === 'C2')).toBe(false)
    expect((await adsRows(a)).some(row => row.campaign === 'OLD')).toBe(true)
  })

  it('店铺绑定变化后重新汇总：改绑未绑定档案到店铺，经营日汇总的广告花费随之增加', async () => {
    await admin.query(`UPDATE "AdsProfile" SET "sellerAccountId" = $1, "bindingStatus" = 'MANUAL' WHERE id = 'ap-2'`, [a.sellerAccountId])
    await inTenant(a, () => store(scoped, range(a)))
    const day = (await storeRows(a)).find(row => row.d === '2026-10-05')
    expect(day).toMatchObject({ spend: 7 + 11.5 + 4, sales: 21 + 40 + 0 })
    await admin.query(`UPDATE "AdsProfile" SET "sellerAccountId" = NULL, "bindingStatus" = 'UNBOUND' WHERE id = 'ap-2'`)
    await inTenant(a, () => store(scoped, range(a)))
    expect((await storeRows(a)).find(row => row.d === '2026-10-05')).toMatchObject({ spend: 11.5 + 4, sales: 40 })
  })

  it('租户隔离：租户 B 的汇总只含自己的数据，不受 A 刷新影响；错用别的租户上下文或没有上下文，什么都写不进', async () => {
    expect(await adsRows(b)).toEqual([])
    await inTenant(b, () => ads(scoped, range(b)))
    expect((await adsRows(b)).map(row => [row.profile, row.campaign, row.spend])).toEqual([['ap-b', 'CB', 8]])
    expect((await adsRows(a)).some(row => row.profile === 'ap-b')).toBe(false)

    const before = await adsRows(a)
    await inTenant(b, () => ads(scoped, range(a))).catch(() => undefined)
    expect(await ads(scoped, range(a)).catch(() => 0)).toBe(0)
    expect(await adsRows(a)).toEqual(before)
  })

  it('迁移回滚与再升级：回滚只删除汇总表，原始指标不受影响；再次升级后汇总表可重新计算', async () => {
    await db.createDatabase('ads_summary_rb')
    db.migrate('ads_summary_rb')
    const client = await db.connect('ads_summary_rb')
    try {
      const folder = join(MIGRATIONS_DIR, '20261111010000_ads_daily_summary')
      const found = async () => (await client.query(`SELECT to_regclass('"AdsDailySummary"') IS NOT NULL AS found`)).rows[0].found as boolean
      const ids = await seedTenant(client, 'rb')
      await insertRow(client, 'AdsProfile', { id: 'ap-rb', tenantId: ids.tenantId, profileId: 'P-rb' })
      await insertRow(client, 'AdsMetric', { id: 'm-rb', tenantId: ids.tenantId, adsProfileId: 'ap-rb', reportDate: '2026-10-05T00:00:00.000Z', externalCampaignId: 'C1', cost: 1 })
      expect(await found()).toBe(true)
      await client.query(readFileSync(join(folder, 'rollback.sql'), 'utf8'))
      expect(await found()).toBe(false)
      expect((await client.query(`SELECT count(*)::int AS n FROM "AdsMetric"`)).rows[0].n).toBe(1)
      await client.query(readFileSync(join(folder, 'migration.sql'), 'utf8'))
      expect(await found()).toBe(true)
      expect((await client.query(`SELECT count(*)::int AS n FROM "AdsDailySummary"`)).rows[0].n).toBe(0)
    } finally {
      await client.end()
    }
  })

  it('没有广告指标的企业：广告日汇总为空，经营日汇总的广告列保持为空而不是 0', async () => {
    const c = await seedTenant(admin, 'c')
    await insertRow(admin, 'Order', {
      id: 'o-c',
      tenantId: c.tenantId,
      sellerAccountId: c.sellerAccountId,
      amazonOrderId: '111-0000009-0000001',
      purchaseDate: '2026-10-05T20:00:00Z',
      status: 'Shipped',
      currency: 'USD',
      sourceUpdatedAt: '2026-10-05T20:00:00Z',
    })
    expect(await inTenant(c, () => ads(scoped, range(c)))).toBe(0)
    await inTenant(c, () => store(scoped, range(c)))
    expect(await storeRows(c)).toEqual([{ d: '2026-10-05', orders: 1, spend: null, sales: null }])
  })
})
