import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 广告连接器（P3-01，真实数据库 + 后台任务代码）：
// 迁移升级与回滚、检查约束与唯一键、外键级联；官方推荐同步（人工状态不被覆盖、失效与复活）、活动预测、旧版并行核对的完整一轮
// （读已入库的旧版日指标、解析新报告分片、分类、落记录、连续通过后关闭旧通道）；行级隔离下别的企业看不到也写不进。

const TARGET = '20261109010000_ads_connector'
const TODAY = '2026-10-23'
const OLD_DAY = '2026-10-10'
const NOW = new Date('2026-10-23T08:00:00Z')
const ACCOUNT = 'amzn1.ads-account.g.test'

describe('广告连接器表迁移（P3-01）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('ads_conn_migrate')
    client = await db.connect('ads_conn_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean
  const TABLES = ['AdsRecommendation', 'AdsForecastRun', 'AdsParityState', 'AdsParityRun', 'AdsParityDiff']

  it('升级建五张表并开启行级安全、回滚全部删除、再次升级闭环成功', async () => {
    for (const table of TABLES) expect(await exists(table), table).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of TABLES) {
      expect(await exists(table), table).toBe(true)
      expect((await client.query(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [table])).rows[0], table).toEqual({ relrowsecurity: true })
      expect((await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND qual LIKE '%nova_current_tenant%'`, [table])).rowCount, table).toBe(1)
    }
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of TABLES) expect(await exists(table), table).toBe(false)
    await applyMigrations(client, { only: TARGET })
  })

  it('检查约束、唯一键与默认值；删除广告档案会级联删掉全部记录', async () => {
    const ids = await seedTenant(client, 'ads-mig')
    const profile = await insertRow(client, 'AdsProfile', { id: 'ap-mig', tenantId: ids.tenantId, profileId: 'P-MIG' })
    const base = { tenantId: ids.tenantId, adsProfileId: profile.id, adsAccountId: ACCOUNT }
    const when = '2026-10-20T00:00:00.000Z'

    const rec = (over: Record<string, unknown>) =>
      insertRow(client, 'AdsRecommendation', {
        id: 'r-1',
        ...base,
        recommendationId: 'rec-1',
        type: 'BUDGET',
        entityType: 'CAMPAIGN',
        entityId: 'c1',
        payloadJson: '{}',
        receivedAt: when,
        lastSeenAt: when,
        ...over,
      })
    expect(await rec({})).toMatchObject({ status: 'NEW', decidedBy: null })
    await expect(rec({ id: 'r-2' })).rejects.toMatchObject({ code: '23505' }) // 同企业同账户同推荐编号
    await expect(rec({ id: 'r-3', recommendationId: 'rec-3', status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    for (const status of ['ADOPTED', 'IGNORED', 'EXPIRED']) await rec({ id: `r-${status}`, recommendationId: `rec-${status}`, status })

    const forecast = (over: Record<string, unknown>) =>
      insertRow(client, 'AdsForecastRun', { id: 'f-1', ...base, campaignId: 'c1', requestedBudget: 10, forecastJson: '{}', requestedAt: when, ...over })
    expect(await forecast({})).toMatchObject({ currency: 'USD', requestedBy: null })
    await expect(forecast({ id: 'f-2', requestedBudget: -1 })).rejects.toMatchObject({ code: '23514' })
    await forecast({ id: 'f-3', requestedBudget: 0 })

    const state = (over: Record<string, unknown>) => insertRow(client, 'AdsParityState', { id: 's-1', tenantId: ids.tenantId, adsProfileId: profile.id, ...over })
    expect(await state({})).toMatchObject({ legacyEnabled: true, consecutivePasses: 0, requiredPasses: 7 })
    await expect(state({ id: 's-2' })).rejects.toMatchObject({ code: '23505' }) // 一个档案一行状态
    const other = await insertRow(client, 'AdsProfile', { id: 'ap-mig-2', tenantId: ids.tenantId, profileId: 'P-MIG-2' })
    await expect(insertRow(client, 'AdsParityState', { id: 's-3', tenantId: ids.tenantId, adsProfileId: other.id, requiredPasses: 0 })).rejects.toMatchObject({ code: '23514' })

    const run = (over: Record<string, unknown>) =>
      insertRow(client, 'AdsParityRun', { id: 'pr-1', tenantId: ids.tenantId, adsProfileId: profile.id, windowStart: '2026-10-10', windowEnd: '2026-10-23', status: 'PASSED', ...over })
    expect(await run({})).toMatchObject({ legacyCount: 0, warningCount: 0, finishedAt: null })
    await expect(run({ id: 'pr-2', status: 'OK' })).rejects.toMatchObject({ code: '23514' })
    await expect(run({ id: 'pr-3', windowStart: '2026-10-24' })).rejects.toMatchObject({ code: '23514' })
    await expect(run({ id: 'pr-4', matchedCount: -1 })).rejects.toMatchObject({ code: '23514' })

    const diff = (over: Record<string, unknown>) =>
      insertRow(client, 'AdsParityDiff', { id: 'pd-1', tenantId: ids.tenantId, runId: 'pr-1', category: 'SCOPE', entityKey: 'c1@2026-10-10', field: 'clicks', explanation: '原因', ...over })
    await diff({})
    await expect(diff({ id: 'pd-2', category: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })

    await client.query(`DELETE FROM "AdsParityRun" WHERE id = 'pr-1'`)
    expect((await client.query(`SELECT 1 FROM "AdsParityDiff" WHERE "tenantId" = $1`, [ids.tenantId])).rowCount).toBe(0)
    await client.query(`DELETE FROM "AdsProfile" WHERE id = $1`, [profile.id])
    for (const table of ['AdsRecommendation', 'AdsForecastRun', 'AdsParityState'])
      expect((await client.query(`SELECT 1 FROM "${table}" WHERE "tenantId" = $1`, [ids.tenantId])).rowCount, table).toBe(0)
  })
})

describe('广告连接器（真实数据库，行级隔离下运行后台代码）', () => {
  let db: TestDatabase
  let admin: Client
  let tenantA: Awaited<ReturnType<typeof seedTenant>>
  let tenantB: Awaited<ReturnType<typeof seedTenant>>
  let scopeA: { tenantId: string; adsProfileId: string; adsAccountId: string }
  let tenantDb: PrismaClient
  let ctx: { prisma: PrismaClient; logger: { warn: () => void; info: () => void; error: () => void } }
  let syncRecommendations: (ctx: unknown, api: unknown, scope: unknown, options?: { now?: Date }) => Promise<Record<string, unknown>>
  let requestForecast: (ctx: unknown, api: unknown, scope: unknown, input: Record<string, unknown>) => Promise<{ id: string }>
  let runParity: (ctx: unknown, scope: unknown, deps: Record<string, unknown>) => Promise<Record<string, unknown>>
  let decodeStream: (raw: Readable) => Readable

  const rows = async <T>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as T[]
  const asTenant = <T>(tenantId: string, work: () => Promise<T>) => runWithTenant(tenantId, work)
  const rec = (id: string, over: Record<string, unknown> = {}) => ({ recommendationId: id, type: 'BUDGET', campaignId: 'c1', ...over })
  const api = (items: Record<string, unknown>[], complete = true) => ({
    async *queryAll() {
      for (const item of items) yield item
      return { complete, pages: 1 }
    },
  })

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('ads_conn')
    db.migrate('ads_conn')
    admin = await db.connect('ads_conn')
    tenantA = await seedTenant(admin, 'ads-a')
    tenantB = await seedTenant(admin, 'ads-b')
    const profile = await insertRow(admin, 'AdsProfile', { id: 'ap-a', tenantId: tenantA.tenantId, profileId: 'PA' })
    await insertRow(admin, 'AdsProfile', { id: 'ap-b', tenantId: tenantB.tenantId, profileId: 'PB' })
    // P3-02 起推荐与预测的账户编号是指向广告账户表的外键，先有账户
    await insertRow(admin, 'AdsAccount', { id: 'aa-a', tenantId: tenantA.tenantId, adsProfileId: profile.id, adsAccountId: ACCOUNT, name: '测试账户' })
    scopeA = { tenantId: tenantA.tenantId, adsProfileId: profile.id, adsAccountId: ACCOUNT }
    const base = new PrismaClient({ datasourceUrl: db.urlFor('ads_conn', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ctx = { prisma: tenantDb, logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }
    syncRecommendations = (await import(/* @vite-ignore */ String('../../../worker/src/importers/ads/recommendations'))).syncAdsRecommendations
    requestForecast = (await import(/* @vite-ignore */ String('../../../worker/src/importers/ads/forecast'))).requestCampaignForecast
    runParity = (await import(/* @vite-ignore */ String('../../../worker/src/parity/ads-run'))).runAdsParity
    decodeStream = (await import(/* @vite-ignore */ String('../../../worker/src/streaming/download'))).decodeStream
  })
  afterAll(async () => {
    await admin?.end()
    await db?.stop()
  })

  it('官方推荐：新推荐待处理、人工决定不被同步覆盖、不再返回的待处理记为已失效、再次出现回到待处理', async () => {
    const first = await asTenant(tenantA.tenantId, () => syncRecommendations(ctx, api([rec('r1'), rec('r2'), rec('r3', { adGroupId: 'g9' })]), scopeA, { now: new Date('2026-10-23T08:00:00Z') }))
    expect(first).toMatchObject({ read: 3, created: 3, updated: 0, expired: 0, complete: true })
    expect((await rows<{ entityType: string; entityId: string }>(`SELECT "entityType", "entityId" FROM "AdsRecommendation" WHERE "recommendationId" = 'r3'`))[0]).toEqual({
      entityType: 'AD_GROUP',
      entityId: 'g9',
    })

    // 人工把 r2 标记为已忽略；亚马逊这次只返回 r1（内容变了）和新的 r4
    await admin.query(`UPDATE "AdsRecommendation" SET status = 'IGNORED', "decidedBy" = 'u1', "decidedAt" = now() WHERE "recommendationId" = 'r2'`)
    const second = await asTenant(tenantA.tenantId, () => syncRecommendations(ctx, api([rec('r1', { type: 'BID' }), rec('r4')]), scopeA, { now: new Date('2026-10-23T09:00:00Z') }))
    expect(second).toMatchObject({ read: 2, created: 1, updated: 1, expired: 1 })
    const status = Object.fromEntries(
      (await rows<{ recommendationId: string; status: string; type: string }>(`SELECT "recommendationId", status, type FROM "AdsRecommendation" WHERE "tenantId" = $1`, [tenantA.tenantId])).map(
        row => [row.recommendationId, `${row.status}/${row.type}`],
      ),
    )
    expect(status).toEqual({ r1: 'NEW/BID', r2: 'IGNORED/BUDGET', r3: 'EXPIRED/BUDGET', r4: 'NEW/BUDGET' })
    expect((await rows<{ decidedBy: string }>(`SELECT "decidedBy" FROM "AdsRecommendation" WHERE "recommendationId" = 'r2'`))[0].decidedBy).toBe('u1')

    // r3 又出现了；这次翻页没翻完，不做失效判断
    const third = await asTenant(tenantA.tenantId, () => syncRecommendations(ctx, api([rec('r3')], false), scopeA, { now: new Date('2026-10-23T10:00:00Z') }))
    expect(third).toMatchObject({ updated: 1, expired: 0, complete: false })
    expect((await rows<{ status: string }>(`SELECT status FROM "AdsRecommendation" WHERE "recommendationId" = 'r3'`))[0].status).toBe('NEW')
    expect((await rows<{ status: string }>(`SELECT status FROM "AdsRecommendation" WHERE "recommendationId" = 'r1'`))[0].status).toBe('NEW') // 没看到不等于没有
  })

  it('活动预测：只追加一行；预算不合法不写库', async () => {
    const forecast = { forecastCampaign: async () => ({ clicks: { low: 10, high: 20 }, spend: { low: 40, high: 50 } }) }
    const saved = await asTenant(tenantA.tenantId, () => requestForecast(ctx, forecast, scopeA, { campaignId: 'c1', requestedBudget: 60, requestedBy: 'u1', now: NOW }))
    const [row] = await rows<{ requestedBudget: string; forecastJson: { clicks: { high: number } }; requestedBy: string }>(`SELECT * FROM "AdsForecastRun" WHERE id = $1`, [saved.id])
    expect(Number(row.requestedBudget)).toBe(60)
    expect(row.forecastJson.clicks.high).toBe(20)
    expect(row.requestedBy).toBe('u1')
    await expect(asTenant(tenantA.tenantId, () => requestForecast(ctx, forecast, scopeA, { campaignId: 'c1', requestedBudget: -5 }))).rejects.toMatchObject({ code: 'ADS_FORECAST_INVALID' })
    expect((await rows(`SELECT 1 FROM "AdsForecastRun" WHERE "tenantId" = $1`, [tenantA.tenantId])).length).toBe(1)
  })

  it('旧版并行核对一整轮：读已入库的旧版日指标、解析新报告分片、全部分类落记录；连续 7 次通过后旧通道关闭，之后不再运行', async () => {
    const legacy = (id: string, campaign: string, over: Record<string, unknown> = {}) =>
      insertRow(admin, 'AdsMetric', {
        id,
        tenantId: tenantA.tenantId,
        adsProfileId: 'ap-a',
        reportDate: OLD_DAY,
        externalCampaignId: campaign,
        impressions: 1000,
        clicks: 50,
        cost: 25,
        sales: 200,
        purchases: 10,
        sourceUpdatedAt: '2026-10-11T00:00:00Z',
        ...over,
      })
    await legacy('am-1', 'c1')
    await legacy('am-2', 'c2', { sales: 100, purchases: 5 })
    await legacy('am-3', 'c3', { clicks: 40 })
    const report = [
      { date: OLD_DAY, campaignId: 'c1', adProduct: 'SPONSORED_PRODUCTS', impressions: 1000, clicks: 50, cost: 25, sales: 200, purchases: 10 }, // 一致
      { date: OLD_DAY, campaignId: 'c2', adProduct: 'SPONSORED_PRODUCTS', impressions: 1000, clicks: 50, cost: 25, sales: 130, purchases: 7 }, // 只有销售更多：归因口径
      { date: OLD_DAY, campaignId: 'c3', adProduct: 'SPONSORED_PRODUCTS', impressions: 1000, clicks: 52, cost: 25, sales: 200, purchases: 10 }, // 点击差异且无解释
      { date: OLD_DAY, campaignId: 'c9', adProduct: 'SPONSORED_BRANDS', impressions: 5, clicks: 1, cost: 1, sales: 0, purchases: 0 }, // 旧版没拉的广告产品：范围
    ]
    const deps = (): Record<string, unknown> => ({
      reporting: { create: async () => 'rep', retrieve: async () => ({ state: 'READY', reportId: 'rep', shardUrls: ['u/1'], warnings: [] }) },
      today: TODAY,
      now: () => NOW,
      open: async () => decodeStream(Readable.from([gzipSync(report.map(row => JSON.stringify(row)).join('\n'))])),
    })
    const scope = { tenantId: tenantA.tenantId, adsProfileId: 'ap-a' }
    const first = await asTenant(tenantA.tenantId, () => runParity(ctx, scope, deps()))
    expect(first).toMatchObject({ ran: true, status: 'HAS_DIFFS', closed: false, counts: { ATTRIBUTION_BASIS: 2, SCOPE: 1, UNEXPLAINED: 1, TIME_BASIS: 0 } })

    const [run] = await rows<{ legacyCount: number; newCount: number; matchedCount: number; unexplainedCount: number; status: string; ws: string; we: string }>(
      `SELECT "legacyCount", "newCount", "matchedCount", "unexplainedCount", status, to_char("windowStart", 'YYYY-MM-DD') AS ws, to_char("windowEnd", 'YYYY-MM-DD') AS we FROM "AdsParityRun" WHERE "adsProfileId" = 'ap-a'`,
    )
    expect(run).toEqual({ legacyCount: 3, newCount: 4, matchedCount: 1, unexplainedCount: 1, status: 'HAS_DIFFS', ws: '2026-10-10', we: TODAY })
    const diffs = await rows<{ category: string; entityKey: string; field: string; explanation: string }>(
      `SELECT category, "entityKey", field, explanation FROM "AdsParityDiff" WHERE "tenantId" = $1 ORDER BY category, "entityKey", field`,
      [tenantA.tenantId],
    )
    expect(diffs.map(diff => `${diff.category}:${diff.entityKey}:${diff.field}`)).toEqual([
      `ATTRIBUTION_BASIS:c2@${OLD_DAY}:purchases`,
      `ATTRIBUTION_BASIS:c2@${OLD_DAY}:sales`,
      `SCOPE:c9@${OLD_DAY}:presence`,
      `UNEXPLAINED:c3@${OLD_DAY}:clicks`,
    ])
    for (const diff of diffs) expect(diff.explanation.length).toBeGreaterThan(5)

    // 把第 3 行的旧版点击改成与新报告一致：之后每一轮都没有未解释差异，连续 7 次通过后旧通道关闭
    await admin.query(`UPDATE "AdsMetric" SET clicks = 52 WHERE id = 'am-3'`)
    let last: Record<string, unknown> = {}
    for (let index = 0; index < 7; index += 1) {
      await admin.query(`UPDATE "AdsParityState" SET "lastRunAt" = NULL WHERE "adsProfileId" = 'ap-a'`)
      last = await asTenant(tenantA.tenantId, () => runParity(ctx, scope, deps()))
      expect(last).toMatchObject({ ran: true, status: 'PASSED' })
    }
    expect(last.closed).toBe(true)
    const [state] = await rows<{ legacyEnabled: boolean; consecutivePasses: number; closedReason: string }>(
      `SELECT "legacyEnabled", "consecutivePasses", "closedReason" FROM "AdsParityState" WHERE "adsProfileId" = 'ap-a'`,
    )
    expect(state).toMatchObject({ legacyEnabled: false, consecutivePasses: 7 })
    expect(state.closedReason).toContain('7')
    await admin.query(`UPDATE "AdsParityState" SET "lastRunAt" = NULL WHERE "adsProfileId" = 'ap-a'`)
    expect(await asTenant(tenantA.tenantId, () => runParity(ctx, scope, deps()))).toEqual({ ran: false })
    expect((await rows(`SELECT 1 FROM "AdsParityRun" WHERE "adsProfileId" = 'ap-a'`)).length).toBe(8)
  })

  it('行级隔离：别的企业读不到这些记录，也写不进别的企业的行', async () => {
    for (const model of ['adsRecommendation', 'adsForecastRun', 'adsParityState', 'adsParityRun', 'adsParityDiff'] as const) {
      const seen = await asTenant(tenantB.tenantId, () => (tenantDb[model] as unknown as { count(): Promise<number> }).count())
      expect(seen, model).toBe(0)
      const own = await asTenant(tenantA.tenantId, () => (tenantDb[model] as unknown as { count(): Promise<number> }).count())
      expect(own, model).toBeGreaterThan(0)
    }
    // 以企业 B 的身份往企业 A 的广告档案下写推荐：行级策略拒绝
    await expect(
      asTenant(tenantB.tenantId, () => syncRecommendations(ctx, api([rec('leak')]), { tenantId: tenantA.tenantId, adsProfileId: 'ap-a', adsAccountId: ACCOUNT }, { now: NOW })),
    ).rejects.toThrow()
    expect((await rows(`SELECT 1 FROM "AdsRecommendation" WHERE "recommendationId" = 'leak'`)).length).toBe(0)
  })
})
