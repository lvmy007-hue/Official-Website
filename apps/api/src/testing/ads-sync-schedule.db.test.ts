import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告实体与报表的定时排任务、新鲜度记录（P5-12A，真实数据库 + worker 的排任务函数）：
// 谁排（有账户编号、启用、连接已授权）、谁不排（没账户编号、停用、没授权、被企业暂停）、不重复排、窗口规则、跨企业隔离、新鲜度归属。
// 亚马逊的响应不在这里：拉取与落库的整条链路见 ads-sync.db.test.ts 与 ads-reports.db.test.ts。

type Row = Record<string, unknown>
type Queues = { addSync: ReturnType<typeof vi.fn> }

const DAY_MS = 86_400_000
const today = new Date().toISOString().slice(0, 10)
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)

describe('广告同步的定时排任务与新鲜度（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let scheduleEntities: (prisma: PrismaClient, queues: Queues, tenantId: string, now: Date) => Promise<number>
  let scheduleReports: (prisma: PrismaClient, queues: Queues, tenantId: string, now: Date) => Promise<number>
  let record: (db: PrismaClient, syncJobId: string, outcome: { ok: true; rowCount?: number } | { ok: false; errorCode: string }) => Promise<boolean>
  const inTenant = <T>(id: string, work: () => Promise<T>) => runWithTenant(id, work)
  const rows = async <T = Row>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const queuesOf = (): Queues => ({ addSync: vi.fn().mockResolvedValue(undefined) })
  const runEntities = (queues: Queues, tenant = tenantId, now = new Date()) => inTenant(tenant, () => scheduleEntities(tenantDb, queues, tenant, now))
  const runReports = (queues: Queues, tenant = tenantId, now = new Date()) => inTenant(tenant, () => scheduleReports(tenantDb, queues, tenant, now))
  const reportJobs = (where = '') =>
    rows<Row>(
      [
        `SELECT "adsProfileId", "templateKey", "adProduct", granularity, status, to_char("fromDate", 'YYYY-MM-DD') AS "from", to_char("toDate", 'YYYY-MM-DD') AS "to"`,
        `FROM "AdsReportJob" WHERE "requestId" = 'schedule' ${where} ORDER BY "adsProfileId", "adProduct", "templateKey"`,
      ].join(' '),
    )
  const setConnection = (state: string, token: string | null) => h.client.query(`UPDATE "PlatformConnection" SET state = $1, "encryptedRefreshToken" = $2 WHERE id = 'conn-a'`, [state, token])
  const reset = async () => {
    await h.client.query(`DELETE FROM "SyncJob" WHERE type IN ('ADS_ENTITY_SYNC', 'ADS_REPORT_V1')`)
    await h.client.query(`DELETE FROM "AdsReportJob"`)
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_sync_schedule' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    const storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    const profiles: Array<[string, string, string | null, string | null, string, string]> = [
      ['ap-a', 'P-A', storeA, 'ACC-A', tenantId, 'ACTIVE'],
      ['ap-b', 'P-B', storeB, 'ACC-B', tenantId, 'ACTIVE'],
      ['ap-n', 'P-N', null, null, tenantId, 'ACTIVE'], // 没发现账户编号
      ['ap-i', 'P-I', storeA, 'ACC-I', tenantId, 'INACTIVE'], // 停用
      ['ap-o', 'P-O', b.sellerAccountId, 'ACC-O', otherTenantId, 'ACTIVE'],
    ]
    for (const [id, profileId, store, account, tenant, status] of profiles) {
      await insertRow(h.client, 'AdsProfile', {
        id,
        tenantId: tenant,
        profileId,
        status,
        ...(store ? { sellerAccountId: store, bindingStatus: 'MANUAL' } : {}),
        ...(account ? { adsAccountId: account } : {}),
      })
    }
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: 'enc' })
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-o', tenantId: otherTenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: 'enc' })
    // ap-a 有商品推广与品牌推广两个产品的活动（品牌推广只定时取活动日报）；ap-b 还没有任何活动（先按商品推广取）
    await insertRow(h.client, 'AdsCampaign', { id: 'cam-sp', tenantId, adsProfileId: 'ap-a', externalCampaignId: 'C1', adProduct: 'SPONSORED_PRODUCTS', name: '商品推广', state: 'ENABLED' })
    await insertRow(h.client, 'AdsCampaign', { id: 'cam-sb', tenantId, adsProfileId: 'ap-a', externalCampaignId: 'C9', adProduct: 'SPONSORED_BRANDS', name: '品牌推广', state: 'ENABLED' })
    await insertRow(h.client, 'AdsCampaign', { id: 'cam-old', tenantId, adsProfileId: 'ap-a', externalCampaignId: 'C8', adProduct: 'SPONSORED_DISPLAY', name: '已归档的展示型推广', state: 'ARCHIVED' })
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_sync_schedule', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    const worker = (path: string) => import(/* @vite-ignore */ String(`../../../worker/src/${path}`))
    scheduleEntities = (await worker('ads-entities/schedule')).scheduleTenantAdsEntities
    scheduleReports = (await worker('ads-reports/auto-schedule')).scheduleTenantAdsReports
    record = (await worker('freshness/record')).recordSyncOutcome
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('实体：只给有账户编号、已启用的档案排任务；任务带档案编号并声明不触发汇总；已有排队中的与刚排过的不重复排，隔了足够久才再排', async () => {
    const queues = queuesOf()
    expect(await runEntities(queues)).toBe(2)
    expect(await rows(`SELECT type, domain, "requestId", priority, context FROM "SyncJob" WHERE type = 'ADS_ENTITY_SYNC' AND "connectionId" = 'conn-a' ORDER BY context->>'adsProfileId'`)).toEqual([
      { type: 'ADS_ENTITY_SYNC', domain: 'ads', requestId: 'schedule', priority: expect.any(Number), context: { adsProfileId: 'ap-a', skipSummaries: true } },
      { type: 'ADS_ENTITY_SYNC', domain: 'ads', requestId: 'schedule', priority: expect.any(Number), context: { adsProfileId: 'ap-b', skipSummaries: true } },
    ])
    expect(queues.addSync).toHaveBeenCalledTimes(2)
    expect(queues.addSync).toHaveBeenCalledWith(
      'ADS_ENTITY_SYNC',
      expect.objectContaining({ tenantId, requestId: 'schedule', adsProfileId: 'ap-a' }),
      expect.objectContaining({ jobId: expect.any(String) }),
    )
    expect(await runEntities(queuesOf())).toBe(0) // 排队中的不重复排
    await h.client.query(`UPDATE "SyncJob" SET status = 'SUCCEEDED' WHERE type = 'ADS_ENTITY_SYNC'`)
    expect(await runEntities(queuesOf())).toBe(0) // 刚排过（90 分钟内）也不重复排
    await h.client.query(`UPDATE "SyncJob" SET "createdAt" = now() - interval '3 hours' WHERE type = 'ADS_ENTITY_SYNC'`)
    expect(await runEntities(queuesOf())).toBe(2)
    await h.client.query(`UPDATE "SyncJob" SET status = 'SUCCEEDED' WHERE type = 'ADS_ENTITY_SYNC'`)
    // 只有一个档案的任务还排队中：只补另一个
    await h.client.query(`UPDATE "SyncJob" SET "createdAt" = now() - interval '3 hours'`)
    await h.client.query(`UPDATE "SyncJob" SET status = 'PENDING', "createdAt" = now() - interval '5 hours' WHERE type = 'ADS_ENTITY_SYNC' AND context->>'adsProfileId' = 'ap-a'`)
    const queues3 = queuesOf()
    expect(await runEntities(queues3)).toBe(1)
    expect(queues3.addSync).toHaveBeenCalledWith('ADS_ENTITY_SYNC', expect.objectContaining({ adsProfileId: 'ap-b' }), expect.anything())
  })

  it('实体：连接没授权或令牌已清除、企业暂停了“广告实体”数据域，都不排；放慢到更长的间隔时没到点不排；别的企业的连接与档案互不影响', async () => {
    await reset()
    await setConnection('REVOKED', 'enc')
    expect(await runEntities(queuesOf())).toBe(0)
    await setConnection('AUTHORIZED', null)
    expect(await runEntities(queuesOf())).toBe(0)
    await setConnection('AUTHORIZED', 'enc')
    await insertRow(h.client, 'TenantSetting', {
      id: 'set-pause',
      tenantId,
      key: 'refresh.policy',
      valueJson: { ADS_ENTITY_SYNC: { mode: 'PAUSED' }, ADS_REPORT_V1: { mode: 'PAUSED' } },
      updatedBy: 'test',
    })
    expect(await runEntities(queuesOf())).toBe(0)
    expect(await runReports(queuesOf())).toBe(0)
    expect(await rows(`SELECT 1 FROM "SyncJob" WHERE type IN ('ADS_ENTITY_SYNC', 'ADS_REPORT_V1')`)).toHaveLength(0)
    // 放慢到 6 小时：上一次定时任务才排过 3 小时，没到点
    await h.client.query(`UPDATE "TenantSetting" SET "valueJson" = '{"ADS_ENTITY_SYNC":{"mode":"EVERY","minutes":360}}'::jsonb WHERE id = 'set-pause'`)
    await insertRow(h.client, 'SyncJob', { id: 'recent-entity', tenantId, connectionId: 'conn-a', type: 'ADS_ENTITY_SYNC', status: 'SUCCEEDED', requestId: 'schedule', sourceKey: 'other-key' })
    await h.client.query(`UPDATE "SyncJob" SET "createdAt" = now() - interval '3 hours' WHERE id = 'recent-entity'`)
    expect(await runEntities(queuesOf())).toBe(0)
    await h.client.query(`DELETE FROM "TenantSetting" WHERE id = 'set-pause'`)
    await h.client.query(`DELETE FROM "SyncJob" WHERE id = 'recent-entity'`)
    // 别的企业：只给它自己的档案排，任务挂在它自己的连接上
    const queues = queuesOf()
    expect(await runEntities(queues, otherTenantId)).toBe(1)
    expect(await rows(`SELECT "tenantId", "connectionId", context->>'adsProfileId' AS profile FROM "SyncJob" WHERE type = 'ADS_ENTITY_SYNC'`)).toEqual([
      { tenantId: otherTenantId, connectionId: 'conn-o', profile: 'ap-o' },
    ])
    expect(await runEntities(queuesOf())).toBe(2)
  })

  it('报表：每个档案、每个有活动的产品、每个模板建一个报告任务；商品推广取全部八个，其余产品只取活动日报；第一次取按日 30 天、按小时 14 天；停用、没账户编号的档案与已归档的产品不排', async () => {
    await reset()
    const queues = queuesOf()
    expect(await runReports(queues)).toBe(17) // ap-a：商品推广 8 + 品牌推广 1；ap-b：没有活动，先按商品推广 8
    expect(queues.addSync).toHaveBeenCalledTimes(17)
    expect(queues.addSync).toHaveBeenCalledWith('ADS_REPORT_V1', expect.objectContaining({ tenantId, requestId: 'schedule', reportJobId: expect.any(String), adsProfileId: 'ap-a' }), expect.anything())
    const jobs = await reportJobs()
    expect(jobs).toHaveLength(17)
    expect(new Set(jobs.map(job => job.adsProfileId))).toEqual(new Set(['ap-a', 'ap-b']))
    expect(jobs.filter(job => job.adsProfileId === 'ap-a' && job.adProduct === 'SPONSORED_BRANDS').map(job => job.templateKey)).toEqual(['CAMPAIGN_DAILY'])
    expect(jobs.some(job => job.adProduct === 'SPONSORED_DISPLAY')).toBe(false)
    expect(jobs.every(job => job.status === 'PENDING')).toBe(true)
    const daily = jobs.find(job => job.adsProfileId === 'ap-a' && job.templateKey === 'CAMPAIGN_DAILY' && job.adProduct === 'SPONSORED_PRODUCTS')
    expect(daily).toMatchObject({ from: daysAgo(29), to: today, granularity: 'DAILY' })
    expect(jobs.find(job => job.templateKey === 'CAMPAIGN_HOURLY')).toMatchObject({ from: daysAgo(13), to: today, granularity: 'HOURLY' })
    const sync = await rows<{ context: { reportJobId: string; adsProfileId: string; templateKey: string; window: { after: string; before: string } } }>(
      [
        `SELECT context FROM "SyncJob" WHERE type = 'ADS_REPORT_V1' AND context->>'adsProfileId' = 'ap-a' AND context->>'templateKey' = 'CAMPAIGN_DAILY'`,
        `AND context->>'reportJobId' IN (SELECT id FROM "AdsReportJob" WHERE "adProduct" = 'SPONSORED_PRODUCTS')`,
      ].join(' '),
    )
    expect(sync).toHaveLength(1)
    expect(sync[0]!.context.window).toEqual({ after: `${daysAgo(29)}T00:00:00.000Z`, before: `${today}T00:00:00.000Z` }) // 完成后只重算这段日期的汇总与利润
    expect(await runReports(queuesOf())).toBe(0) // 排队中的不重复排
  })

  it('报表：成功过的模板满 20 小时后每天只重拉最近 3 天；失败的下一轮重排；没满 20 小时的不排；别的企业互不影响', async () => {
    await h.client.query(`UPDATE "AdsReportJob" SET status = 'READY', "createdAt" = now() - interval '5 hours' WHERE "requestId" = 'schedule'`)
    expect(await runReports(queuesOf())).toBe(0) // 刚成功不到 20 小时
    await h.client.query(`UPDATE "AdsReportJob" SET "createdAt" = now() - interval '25 hours' WHERE "requestId" = 'schedule'`)
    await h.client.query(
      `UPDATE "AdsReportJob" SET status = 'FAILED', "createdAt" = now() - interval '1 hour' WHERE "requestId" = 'schedule' AND "adsProfileId" = 'ap-b' AND "templateKey" = 'PLACEMENT_DAILY'`,
    )
    const before = (await reportJobs()).length
    const queues = queuesOf()
    expect(await runReports(queues)).toBe(17) // 成功满 25 小时的 16 个到期，加上失败的 1 个：每个模板都重排
    expect((await reportJobs()).length).toBe(before + 17)
    const again = (await reportJobs(`AND status = 'PENDING'`)).filter(job => job.adsProfileId === 'ap-a' && job.templateKey === 'CAMPAIGN_DAILY' && job.adProduct === 'SPONSORED_PRODUCTS')
    expect(again).toEqual([expect.objectContaining({ from: daysAgo(2), to: today })])
    expect((await reportJobs(`AND status = 'PENDING'`)).find(job => job.templateKey === 'CAMPAIGN_HOURLY')).toMatchObject({ from: daysAgo(2), to: today })
    expect(await runReports(queuesOf())).toBe(0)
    // 别的企业：只有它自己的档案；还没有活动，先按商品推广 8 个模板
    expect(await runReports(queuesOf(), otherTenantId)).toBe(8)
    expect(await rows(`SELECT DISTINCT "tenantId", "adsProfileId" FROM "AdsReportJob" WHERE "tenantId" = $1`, [otherTenantId])).toEqual([{ tenantId: otherTenantId, adsProfileId: 'ap-o' }])
  })

  it('别的企业的广告连接断开后：实体与报表都不再排（每个企业每次最多排 400 个报表任务的上限需要上百个档案，这里没有验证）', async () => {
    await h.client.query(`UPDATE "PlatformConnection" SET state = 'REVOKED' WHERE id = 'conn-o'`)
    expect(await runEntities(queuesOf(), otherTenantId)).toBe(0)
    expect(await runReports(queuesOf(), otherTenantId)).toBe(0)
  })

  it('新鲜度：实体同步与定时报表记在广告档案绑定的店铺名下；失败保留上次成功时间，没发现账户是“等待依赖”；没绑定店铺、人工申请的报表、别的企业的档案都不记', async () => {
    const job = async (id: string, type: string, context: Row, requestId = 'schedule', tenant = tenantId, connection = 'conn-a') => {
      await insertRow(h.client, 'SyncJob', { id, tenantId: tenant, connectionId: connection, type, status: 'RUNNING', requestId, context, sourceKey: id })
      return id
    }
    const freshness = (source: string) =>
      rows<Row>(`SELECT "sellerAccountId", status, "lastErrorCode", "lastRowCount", "lastSuccessAt" IS NOT NULL AS ok FROM "DataFreshness" WHERE "tenantId" = $1 AND "sourceKey" = $2`, [
        tenantId,
        source,
      ])
    const entity = await job('j-entity', 'ADS_ENTITY_SYNC', { adsProfileId: 'ap-a' })
    expect(await inTenant(tenantId, () => record(tenantDb, entity, { ok: true, rowCount: 42 }))).toBe(true)
    expect(await freshness('ads.entities-v1')).toEqual([{ sellerAccountId: storeA, status: 'NORMAL', lastErrorCode: null, lastRowCount: 42, ok: true }])
    const failed = await job('j-entity-failed', 'ADS_ENTITY_SYNC', { adsProfileId: 'ap-a' })
    expect(await inTenant(tenantId, () => record(tenantDb, failed, { ok: false, errorCode: 'ADS_ACCOUNT_MISSING' }))).toBe(true)
    expect(await freshness('ads.entities-v1')).toEqual([{ sellerAccountId: storeA, status: 'WAITING_DEPENDENCY', lastErrorCode: 'ADS_ACCOUNT_MISSING', lastRowCount: 42, ok: true }])

    const scheduled = await job('j-report', 'ADS_REPORT_V1', { adsProfileId: 'ap-b', reportJobId: 'x' })
    expect(await inTenant(tenantId, () => record(tenantDb, scheduled, { ok: true, rowCount: 7 }))).toBe(true)
    expect((await freshness('ads.reports-v1'))[0]).toMatchObject({ sellerAccountId: 'seller-a2', status: 'NORMAL', lastRowCount: 7 })
    const manual = await job('j-manual', 'ADS_REPORT_V1', { adsProfileId: 'ap-a', reportJobId: 'y' }, 'req-manual')
    expect(await inTenant(tenantId, () => record(tenantDb, manual, { ok: true, rowCount: 1 }))).toBe(false)
    const unbound = await job('j-unbound', 'ADS_ENTITY_SYNC', { adsProfileId: 'ap-n' })
    expect(await inTenant(tenantId, () => record(tenantDb, unbound, { ok: true, rowCount: 1 }))).toBe(false)
    const noProfile = await job('j-none', 'ADS_ENTITY_SYNC', {})
    expect(await inTenant(tenantId, () => record(tenantDb, noProfile, { ok: true }))).toBe(false)
    // 任务属于本企业，但上下文里写的是别的企业的档案：按企业过滤，找不到就不记
    const foreign = await job('j-foreign', 'ADS_ENTITY_SYNC', { adsProfileId: 'ap-o' })
    expect(await inTenant(tenantId, () => record(tenantDb, foreign, { ok: true, rowCount: 1 }))).toBe(false)
    expect(await rows(`SELECT 1 FROM "DataFreshness" WHERE "tenantId" = $1`, [otherTenantId])).toHaveLength(0)
    expect(await rows(`SELECT 1 FROM "DataFreshness" WHERE "tenantId" = $1 AND "sourceKey" LIKE 'ads.%'`, [tenantId])).toHaveLength(2)
  })
})
