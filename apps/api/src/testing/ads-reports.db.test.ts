import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告报表与广告指标（P3-15，真实数据库 + 完整应用 + worker 的运行器与定时排任务）：模板库、创建、重试、回补、数据范围、企业隔离、
// 八个模板的写入、历史可用起点、指标汇总（空值、币种、周月折叠、排序、翻页、活动链接）、迁移期核对只读与手动触发、迁移回滚与重放。

type Member = { userId: string; token: string }
type Row = Record<string, unknown>
type RunnerDeps = { reporting: { create: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn> }; today: string; now?: () => Date; open: () => Promise<unknown> }

const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261117010000_ads_reports')
const DAY_MS = 86_400_000
const today = new Date().toISOString().slice(0, 10)
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
const hourAgo = (days: number) => new Date(Math.floor((Date.now() - days * DAY_MS) / 3_600_000) * 3_600_000).toISOString()
const RANGE = 'from=2026-09-01&to=2026-10-31'

describe('广告报表与广告指标（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let run: (ctx: { prisma: PrismaClient; logger: unknown }, scope: { reportJobId: string }, deps: RunnerDeps) => Promise<Row>
  let schedule: (prisma: PrismaClient, queues: { addSync: ReturnType<typeof vi.fn> }, tenantId: string, now: Date) => Promise<number>
  let decodeStream: (stream: Readable) => Readable
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let admin: Member
  let scopedA: Member
  let scopedB: Member
  let reader: Member
  let noAds: Member
  let other: Member
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, status = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} ${JSON.stringify(res.json)}`).toBe(status)
    return res.json.data as Record<string, any>
  }
  const post = (member: Member, path: string, body?: unknown) => h.call(member.token, 'POST', path, { body })
  const code = (res: { json: any }) => res.json?.error?.code as string

  /** 建一个新报告接口任务并跑完“创建 + 轮询”两步；rowsOf 是报告里的行。 */
  const importReport = async (templateKey: string, granularity: string, rowsOf: Row[], profile = 'ap-a', range = { from: '2026-09-01', to: '2026-09-30' }) => {
    const job = await insertRow(h.client, 'AdsReportJob', {
      id: `job-${templateKey}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      adsProfileId: profile,
      reportType: templateKey,
      source: 'V1',
      templateKey,
      granularity,
      fromDate: range.from,
      toDate: range.to,
      requestId: 'test',
    })
    const text = rowsOf.map(item => JSON.stringify(item)).join('\n')
    const reporting = { create: vi.fn().mockResolvedValue('RPT-X'), retrieve: vi.fn().mockResolvedValue({ state: 'READY', reportId: 'RPT-X', shardUrls: ['u/1'], warnings: [] }) }
    const deps: RunnerDeps = { reporting, today, now: () => new Date(), open: async () => decodeStream(Readable.from([Buffer.from(text)])) }
    const exec = () => runWithTenant(tenantId, () => run({ prisma: tenantDb, logger }, { reportJobId: job.id }, deps))
    const created = await exec()
    const imported = await exec()
    return { id: job.id as string, created, imported }
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_reports' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    const profiles: Array<[string, string, string | null, string | null, string]> = [
      ['ap-a', 'P-A', storeA, 'ACC-A', tenantId],
      ['ap-b', 'P-B', storeB, 'ACC-B', tenantId],
      ['ap-u', 'P-U', null, null, tenantId],
      ['ap-o', 'P-O', b.sellerAccountId, 'ACC-O', otherTenantId],
    ]
    for (const [id, profileId, store, account, tenant] of profiles) {
      await insertRow(h.client, 'AdsProfile', {
        id,
        tenantId: tenant,
        profileId,
        displayName: `档案 ${profileId}`,
        ...(store ? { sellerAccountId: store, bindingStatus: 'MANUAL' } : {}),
        ...(account ? { adsAccountId: account } : {}),
      })
    }
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED' })
    await insertRow(h.client, 'AdsCampaign', { id: 'cam-1', tenantId, adsProfileId: 'ap-a', externalCampaignId: 'C1', adProduct: 'SPONSORED_PRODUCTS', name: '春季活动', state: 'ENABLED' })
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_reports', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    run = (await import(/* @vite-ignore */ String('../../../worker/src/ads-reports/run'))).runAdsReport
    schedule = (await import(/* @vite-ignore */ String('../../../worker/src/ads-reports/schedule'))).scheduleTenantAdsParity
    decodeStream = (await import(/* @vite-ignore */ String('../../../worker/src/streaming/download'))).decodeStream
    admin = await h.createMember(tenantId, 'admin', ['ads.read', 'ads.report'])
    scopedA = await h.createMember(tenantId, 'scopeda', ['ads.read', 'ads.report'], { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', ['ads.read'], { scopes: [{ sellerAccountId: storeB }] })
    reader = await h.createMember(tenantId, 'reader', ['ads.read'])
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', ['ads.read', 'ads.report'])
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('模板库：8 个模板；档案是否可用（有广告账户编号且已授权）；受限成员只看到范围内的档案；没权限 403', async () => {
    const all = await get(admin, '/ads/report-templates')
    expect(all.templates).toHaveLength(8)
    const ready = Object.fromEntries(all.profiles.map((profile: Row) => [profile.id, profile.ready]))
    expect(ready).toEqual({ 'ap-a': true, 'ap-b': true, 'ap-u': false })
    expect(all.profiles.find((profile: Row) => profile.id === 'ap-u').notReadyReason).toContain('广告账户编号')
    expect(all.profiles.every((profile: Row) => profile.historyFrom === null)).toBe(true)
    expect(all.historyNote).toContain('15 个月')
    expect((await get(scopedA, '/ads/report-templates')).profiles.map((profile: Row) => profile.id)).toEqual(['ap-a'])
    expect((await get(other, '/ads/report-templates')).profiles.map((profile: Row) => profile.id)).toEqual(['ap-o'])
    expect((await get(other, '/ads/report-templates')).profiles[0].ready).toBe(false) // 对方企业没有授权的广告连接
    await get(noAds, '/ads/report-templates', 403)
  })

  it('还没有任务：列表是“尚无记录”，各状态计数都是 0', async () => {
    const list = await get(admin, '/ads/reports')
    expect(list).toMatchObject({ state: 'NO_DATA', items: [], counts: { PENDING: 0, GENERATING: 0, READY: 0, FAILED: 0 } })
    expect(list.note).toContain('模板库')
  })

  it('创建：任务与同步任务一起建好并入队；时间范围超限、没有账户编号、对方或范围外的档案、没有权限都被拒绝且不留半截记录', async () => {
    const good = { profileId: 'ap-a', templateKey: 'CAMPAIGN_DAILY', from: '2026-09-01', to: '2026-09-10' }
    const res = await post(admin, '/ads/reports', good)
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    const report = res.json.data.report
    expect(report).toMatchObject({
      source: 'V1',
      status: 'PENDING',
      templateKey: 'CAMPAIGN_DAILY',
      title: '活动日报',
      from: '2026-09-01',
      to: '2026-09-10',
      attempt: 1,
      canRetry: false,
      adProduct: 'SPONSORED_PRODUCTS',
    })
    expect(report.dimensions).toEqual(['date', 'adProduct', 'campaignId'])
    const jobs = await rows<{ type: string; domain: string; context: Row }>(`SELECT type, domain, context FROM "SyncJob" WHERE id = $1`, [res.json.data.syncJobId])
    expect(jobs[0]).toMatchObject({ type: 'ADS_REPORT_V1', domain: 'ads', context: { reportJobId: report.id } })
    expect(h.queue.add).toHaveBeenLastCalledWith(
      'sync',
      expect.objectContaining({ reportJobId: report.id, adsProfileId: 'ap-a', tenantId }),
      res.json.data.syncJobId,
      expect.objectContaining({ type: 'ADS_REPORT_V1' }),
    )
    const before = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsReportJob" WHERE source = 'V1'`))[0]!.n
    const hourly = await post(admin, '/ads/reports', { ...good, templateKey: 'CAMPAIGN_HOURLY', from: daysAgo(20), to: daysAgo(1) })
    expect([hourly.status, code(hourly)]).toEqual([422, 'ADS_REPORT_WINDOW'])
    expect(JSON.stringify(hourly.json)).toContain('14 天')
    expect(code(await post(admin, '/ads/reports', { ...good, to: '2999-01-01' }))).toBe('ADS_REPORT_WINDOW')
    expect(code(await post(admin, '/ads/reports', { ...good, from: '2025-01-01', to: '2026-09-10' }))).toBe('ADS_REPORT_WINDOW')
    expect(code(await post(admin, '/ads/reports', { ...good, profileId: 'ap-u' }))).toBe('ADS_ACCOUNT_MISSING')
    expect((await post(admin, '/ads/reports', { ...good, profileId: 'ap-o' })).status).toBe(404)
    expect((await post(scopedA, '/ads/reports', { ...good, profileId: 'ap-b' })).status).toBe(404)
    expect(code(await post(other, '/ads/reports', { ...good, profileId: 'ap-o' }))).toBe('ADS_CONNECTION_REQUIRED')
    expect((await post(reader, '/ads/reports', good)).status).toBe(403)
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsReportJob" WHERE source = 'V1'`))[0]!.n).toBe(before)
  })

  it('运行器：创建步骤记下报告编号，轮询步骤按模板写入指标表、登记行数，并把历史可用起点登记到档案上（只往前推）', async () => {
    const first = await importReport('CAMPAIGN_DAILY', 'DAILY', [
      { date: '2026-09-07', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', impressions: 100, clicks: 10, cost: 5, sales: 20, purchases: 2 },
      { date: '2026-09-08', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', impressions: 50, clicks: 4, cost: 3, sales: 6, purchases: 1 },
      { date: '2026-09-14', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', impressions: 10, clicks: 1 },
      { date: '2026-09-07', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C2', impressions: 7, clicks: 1, cost: 1, sales: 0, purchases: 0 },
      { date: '2026-09-09', impressions: 1 },
    ])
    expect(first.created).toEqual({ pending: true, reportId: 'RPT-X' })
    expect(first.imported).toMatchObject({ ready: true, imported: 4, skipped: 1 })
    const job = (await rows<Row>(`SELECT status, "importedRows", "skippedRows", "failureCode" FROM "AdsReportJob" WHERE id = $1`, [first.id]))[0]
    expect(job).toMatchObject({ status: 'READY', importedRows: 4, skippedRows: 1, failureCode: null })
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsAccount" WHERE "adsAccountId" = 'ACC-A'`))[0]!.n).toBe(1)
    const stored = await rows<Row>(`SELECT "externalCampaignId", cost, sales, "adsAccountId", "entityType" FROM "AdsMetric" WHERE "adsProfileId" = 'ap-a' AND "reportDate" = '2026-09-14'`)
    expect(stored).toEqual([{ externalCampaignId: 'C1', cost: null, sales: null, adsAccountId: 'ACC-A', entityType: 'CAMPAIGN' }]) // 没给的金额是空，不是 0
    expect((await rows<{ d: string }>(`SELECT to_char("historyFrom", 'YYYY-MM-DD') AS d FROM "AdsProfile" WHERE id = 'ap-a'`))[0]!.d).toBe('2026-09-07')
    // 更早的数据进来：起点往前推；之后一个更晚的任务不会把起点往后拉
    await importReport('CAMPAIGN_DAILY', 'DAILY', [{ date: '2026-08-20', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', impressions: 5, clicks: 1, cost: 1, sales: 1, purchases: 1 }], 'ap-a', {
      from: '2026-08-01',
      to: '2026-08-31',
    })
    await importReport('CAMPAIGN_DAILY', 'DAILY', [{ date: '2026-09-20', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', impressions: 5, clicks: 1, cost: 1, sales: 1, purchases: 1 }])
    expect((await rows<{ d: string }>(`SELECT to_char("historyFrom", 'YYYY-MM-DD') AS d FROM "AdsProfile" WHERE id = 'ap-a'`))[0]!.d).toBe('2026-08-20')
    expect((await get(admin, '/ads/report-templates')).profiles.find((profile: Row) => profile.id === 'ap-a').historyFrom).toBe('2026-08-20')
    expect((await get(scopedB, '/ads/report-templates')).profiles.find((profile: Row) => profile.id === 'ap-b').historyFrom).toBeNull()
  })

  it('同一天同一对象再导入一次：覆盖旧版写入的行（新值为准），不产生重复行；没给的指标不覆盖已有值', async () => {
    await insertRow(h.client, 'AdsMetric', {
      id: 'legacy-1',
      tenantId,
      adsProfileId: 'ap-a',
      reportDate: '2026-09-21',
      externalCampaignId: 'C3',
      adProduct: 'SPONSORED_PRODUCTS',
      cost: 5,
      sales: 9,
      purchases: 1,
      impressions: 20,
      clicks: 3,
    })
    await importReport('CAMPAIGN_DAILY', 'DAILY', [{ date: '2026-09-21', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C3', impressions: 30, clicks: 4, cost: 6 }])
    const found = await rows<Row>(`SELECT cost, sales, impressions, clicks FROM "AdsMetric" WHERE "adsProfileId" = 'ap-a' AND "externalCampaignId" = 'C3'`)
    expect(found).toEqual([{ cost: '6.000000', sales: '9.000000', impressions: 30, clicks: 4 }])
  })

  it('其余七个模板各写进自己的表：广告组与词级沿用词级表（层级分开），广告商品、广告位、转化商品、小时各自的表；字段名对不上的任务失败并说明', async () => {
    await importReport('AD_GROUP_DAILY', 'DAILY', [
      { date: '2026-09-07', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', adGroupId: 'G1', impressions: 10, clicks: 2, cost: 2, sales: 4, purchases: 1 },
    ])
    await importReport('TARGET_DAILY', 'DAILY', [
      { date: '2026-09-07', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', adGroupId: 'G1', targetId: 'K1', targetingExpression: 'yoga mat', matchType: 'exact', clicks: 3, cost: 3, sales: 8 },
    ])
    await importReport('SEARCH_TERM_DAILY', 'DAILY', [
      {
        date: '2026-09-07',
        adProduct: 'SPONSORED_PRODUCTS',
        campaignId: 'C1',
        adGroupId: 'G1',
        targetId: 'K1',
        targetingExpression: 'yoga mat',
        matchType: 'exact',
        searchTerm: 'best yoga mat',
        clicks: 1,
        cost: 1,
        sales: 2,
        purchases: 1,
      },
    ])
    await importReport('ADVERTISED_PRODUCT_DAILY', 'DAILY', [{ date: '2026-09-07', campaignId: 'C1', advertisedAsin: 'B0AAA', impressions: 9, clicks: 2, cost: 2, sales: 5, purchases: 1, units: 2 }])
    await importReport('PLACEMENT_DAILY', 'DAILY', [{ date: '2026-09-07', campaignId: 'C1', placement: 'Top of Search', impressions: 9, clicks: 2, cost: 2, sales: 5, purchases: 1 }])
    await importReport('CONVERTED_PRODUCT_DAILY', 'DAILY', [
      { date: '2026-09-07', campaignId: 'C1', advertisedAsin: 'B0AAA', purchasedAsin: 'B0AAA', units: 1, sales: 10 },
      { date: '2026-09-07', campaignId: 'C1', advertisedAsin: 'B0AAA', purchasedAsin: 'B0BBB', units: 2, sales: 7 },
    ])
    await importReport('CAMPAIGN_HOURLY', 'HOURLY', [{ hour: hourAgo(2), campaignId: 'C1', impressions: 5, clicks: 2, cost: 1, sales: 3, purchases: 1 }], 'ap-a', { from: daysAgo(3), to: daysAgo(1) })
    const levels = await rows<{ level: string; n: number }>(`SELECT level, count(*)::int AS n FROM "AdsTermMetric" WHERE "adsProfileId" = 'ap-a' GROUP BY level ORDER BY level`)
    expect(levels).toEqual([
      { level: 'AD_GROUP', n: 1 },
      { level: 'KEYWORD', n: 1 },
      { level: 'SEARCH_TERM', n: 1 },
    ])
    const term = (await rows<Row>(`SELECT "rowKey", "keywordText", "matchType", "matchedTargetExpression" FROM "AdsTermMetric" WHERE level = 'SEARCH_TERM'`))[0]
    expect(term).toMatchObject({ rowKey: 'C1|G1|K1|yoga mat|best yoga mat', keywordText: 'yoga mat', matchType: 'EXACT', matchedTargetExpression: 'yoga mat' })
    expect((await rows<{ halo: boolean; units: number }>(`SELECT "isHalo" AS halo, units FROM "AdsConvertedProductDaily" ORDER BY units`)).map(item => item.halo)).toEqual([false, true])
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsPerformanceHourly" WHERE "entityId" = 'C1' AND clicks = 2`))[0]!.n).toBe(1)
    const bad = await insertRow(h.client, 'AdsReportJob', {
      id: 'job-bad',
      tenantId,
      adsProfileId: 'ap-a',
      reportType: 'x',
      source: 'V1',
      templateKey: 'PLACEMENT_DAILY',
      granularity: 'DAILY',
      fromDate: '2026-09-01',
      toDate: '2026-09-02',
      requestId: 't',
    })
    const reporting = { create: vi.fn().mockResolvedValue('RPT-B'), retrieve: vi.fn().mockResolvedValue({ state: 'READY', reportId: 'RPT-B', shardUrls: ['u/1'], warnings: [] }) }
    const deps: RunnerDeps = { reporting, today, open: async () => decodeStream(Readable.from([Buffer.from('{"day":"2026-09-01","cmp":"C1","imps":3}')])) }
    const exec = () => runWithTenant(tenantId, () => run({ prisma: tenantDb, logger }, { reportJobId: bad.id }, deps))
    await exec()
    await expect(exec()).rejects.toMatchObject({ code: 'ADS_REPORT_ROWS_UNREADABLE' })
    expect((await rows<Row>(`SELECT status, "failureCode", "failureMessage" FROM "AdsReportJob" WHERE id = 'job-bad'`))[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'ADS_REPORT_ROWS_UNREADABLE',
    })
  })

  it('任务列表：新旧任务一起列出，失败原因与警告、导入行数、可否重试；状态筛选与计数；翻页；范围与企业隔离', async () => {
    await insertRow(h.client, 'AdsReportJob', { id: 'job-legacy-failed', tenantId, adsProfileId: 'ap-a', reportType: 'spCampaigns', status: 'FAILED', failureCode: 'FAILED', requestId: 't' })
    await h.client.query(`UPDATE "AdsReportJob" SET "warningSignals" = '[{"code":"DATA_DELAYED","message":"数据延迟"}]'::jsonb WHERE id = 'job-bad'`)
    const list = await get(admin, '/ads/reports?pageSize=200')
    expect(list.counts.FAILED).toBe(2)
    expect(list.counts.READY).toBeGreaterThanOrEqual(10)
    const bad = list.items.find((item: Row) => item.id === 'job-bad')
    expect(bad).toMatchObject({ status: 'FAILED', failureCode: 'ADS_REPORT_ROWS_UNREADABLE', canRetry: true, warnings: [{ code: 'DATA_DELAYED', message: '数据延迟' }] })
    expect(bad.failureText).toContain('没有一行能按')
    expect(list.items.find((item: Row) => item.id === 'job-legacy-failed')).toMatchObject({ source: 'LEGACY', title: 'spCampaigns', canRetry: false, failureText: '任务失败（FAILED）' })
    const ready = list.items.find((item: Row) => item.status === 'READY' && item.templateKey === 'CAMPAIGN_DAILY')
    expect(ready).toMatchObject({ importedRows: expect.any(Number), failureText: null, requestedByName: null })
    const failedOnly = await get(admin, '/ads/reports?status=FAILED&sort=createdAt:asc&pageSize=1')
    expect(failedOnly.items).toHaveLength(1)
    expect(failedOnly.pageInfo.hasMore).toBe(true)
    const next = await get(admin, `/ads/reports?status=FAILED&sort=createdAt:asc&pageSize=1&cursor=${encodeURIComponent(failedOnly.pageInfo.nextCursor)}`)
    expect(next.items[0].id).not.toBe(failedOnly.items[0].id)
    expect((await h.call(admin.token, 'GET', `/ads/reports?status=PENDING&pageSize=1&cursor=${encodeURIComponent(failedOnly.pageInfo.nextCursor)}`)).status).toBe(400)
    expect((await get(admin, '/ads/reports?templateKey=PLACEMENT_DAILY')).items.every((item: Row) => item.templateKey === 'PLACEMENT_DAILY')).toBe(true)
    expect((await get(scopedB, '/ads/reports')).items).toEqual([])
    expect((await get(other, '/ads/reports')).items).toEqual([])
    expect((await get(scopedA, '/ads/reports?pageSize=200')).counts.FAILED).toBe(2)
  })

  it('重试：只有新报告接口的失败任务能重试，同一个失败任务只能重试一次；新任务指向旧任务、次数加一；范围外 404', async () => {
    const res = await post(admin, '/ads/reports/job-bad/retry')
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    expect(res.json.data.report).toMatchObject({ status: 'PENDING', attempt: 2, retryOfId: 'job-bad', templateKey: 'PLACEMENT_DAILY', from: '2026-09-01', to: '2026-09-02' })
    expect(code(await post(admin, '/ads/reports/job-bad/retry'))).toBe('ADS_REPORT_ALREADY_RETRIED')
    expect(code(await post(admin, '/ads/reports/job-legacy-failed/retry'))).toBe('ADS_REPORT_NOT_RETRYABLE')
    const readyId = (await rows<{ id: string }>(`SELECT id FROM "AdsReportJob" WHERE status = 'READY' AND source = 'V1' LIMIT 1`))[0]!.id
    expect(code(await post(admin, `/ads/reports/${readyId}/retry`))).toBe('ADS_REPORT_NOT_RETRYABLE')
    expect((await post(scopedB, '/ads/reports/job-bad/retry')).status).toBe(403)
    expect((await post(other, '/ads/reports/job-bad/retry')).status).toBe(404)
    expect((await post(admin, '/ads/reports/nope-nope/retry')).status).toBe(404)
    const listed = await get(admin, '/ads/reports?pageSize=200')
    expect(listed.items.find((item: Row) => item.id === 'job-bad').canRetry).toBe(false)
  })

  it('历史回补：按 120 天切片各建一个活动日报任务（最近的在前、首尾相接）；还有没做完的任务时拒绝；范围外的档案 404', async () => {
    const res = await post(admin, '/ads/reports/backfill', { profileId: 'ap-b', months: 24 })
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    const { reports, windows } = res.json.data
    expect(windows.length).toBeGreaterThanOrEqual(6)
    expect(windows.length).toBeLessThanOrEqual(8)
    expect(windows[0].to).toBe(today)
    expect(reports).toHaveLength(windows.length)
    expect(reports.every((item: Row) => item.templateKey === 'CAMPAIGN_DAILY' && item.status === 'PENDING')).toBe(true)
    expect(code(await post(admin, '/ads/reports/backfill', { profileId: 'ap-b' }))).toBe('ADS_BACKFILL_RUNNING')
    expect((await post(scopedA, '/ads/reports/backfill', { profileId: 'ap-b' })).status).toBe(404)
    expect(code(await post(admin, '/ads/reports/backfill', { profileId: 'ap-u' }))).toBe('ADS_ACCOUNT_MISSING')
  })

  it('指标：活动日指标按日、周、月折叠；空值不当 0（合计也是）；派生指标现算；排序空值永远在最后；只看美元', async () => {
    await insertRow(h.client, 'AdsMetric', {
      id: 'eur-1',
      tenantId,
      adsProfileId: 'ap-a',
      reportDate: '2026-09-07',
      externalCampaignId: 'C9',
      adProduct: 'SPONSORED_PRODUCTS',
      currency: 'EUR',
      cost: 100,
      sales: 100,
    })
    const daily = await get(admin, `/ads/metrics?${RANGE}&dims=date&metrics=impressions,spend,sales,acos&grain=day&sort=key:asc&pageSize=50`)
    expect(daily.otherCurrencyRows).toBe(1)
    const byDay = Object.fromEntries(daily.items.map((item: Row) => [(item.dims as Row).date, item.values]))
    expect(byDay['2026-09-07']).toMatchObject({ impressions: 107, spend: 6, sales: 20 })
    expect((byDay['2026-09-07'] as Row).acos).toBeCloseTo(0.3)
    expect(byDay['2026-09-14']).toMatchObject({ impressions: 10, spend: null, sales: null, acos: null })
    const weekly = await get(admin, `/ads/metrics?${RANGE}&dims=date&metrics=spend&grain=week&sort=key:asc`)
    expect(weekly.items.map((item: Row) => (item.dims as Row).date).slice(0, 3)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21'])
    expect(weekly.items[0].values.spend).toBe(9)
    const monthly = await get(admin, `/ads/metrics?${RANGE}&dims=date&metrics=spend,clicks&grain=month`)
    expect(monthly.items.map((item: Row) => (item.dims as Row).date)).toEqual(['2026-09-01'])
    const sorted = await get(admin, `/ads/metrics?${RANGE}&dims=date&metrics=spend&sort=spend:asc&pageSize=50`)
    expect(sorted.items.at(-1).values.spend).toBeNull() // 9-14 没有花费：不管升降序都在最后
    expect((await get(admin, `/ads/metrics?${RANGE}&dims=date&metrics=spend&sort=spend:desc&pageSize=50`)).items.at(-1).values.spend).toBeNull()
    const none = await get(admin, `/ads/metrics?${RANGE}&dims=none&metrics=spend,clicks,ctr`)
    expect(none.items).toHaveLength(1)
    expect(none.totals).toMatchObject({ clicks: 21, spend: 16 }) // 欧元那一行不进合计
    const onlyNull = await get(admin, `/ads/metrics?from=2026-09-14&to=2026-09-14&dims=none&metrics=spend,sales,clicks`)
    expect(onlyNull.totals).toMatchObject({ spend: null, sales: null, clicks: 1 })
  })

  it('指标：活动维度带名称与详情页链接（报告里没有名称就用实体表补）；自由组合维度；其它数据集；翻页游标绑定条件', async () => {
    const byCampaign = await get(admin, `/ads/metrics?${RANGE}&dims=campaign&metrics=spend&sort=spend:desc`)
    const first = byCampaign.items[0]
    expect(first).toMatchObject({ key: 'C1', dims: { campaign: '春季活动' }, link: '/app/advertising/campaigns/cam-1' })
    expect(byCampaign.items.find((item: Row) => item.key === 'C2')).toMatchObject({ dims: { campaign: 'C2' }, link: null })
    const terms = await get(admin, `/ads/metrics?${RANGE}&dataset=SEARCH_TERM&dims=searchTerm,matchType&metrics=spend,orders`)
    expect(terms.items[0]).toMatchObject({ dims: { searchTerm: 'best yoga mat', matchType: 'EXACT' }, values: { spend: 1, orders: 1 } })
    const placement = await get(admin, `/ads/metrics?${RANGE}&dataset=PLACEMENT&dims=placement&metrics=spend,roas`)
    expect(placement.items[0]).toMatchObject({ dims: { placement: 'Top of Search' }, values: { spend: 2, roas: 2.5 } })
    const converted = await get(admin, `/ads/metrics?${RANGE}&dataset=CONVERTED_PRODUCT&dims=halo&metrics=units,sales&sort=key:asc`)
    expect(converted.items.map((item: Row) => [(item.dims as Row).halo, (item.values as Row).units])).toEqual([
      ['否', 1],
      ['是', 2],
    ])
    expect((await get(admin, `/ads/metrics?${RANGE}&dataset=ADVERTISED_PRODUCT&dims=advertisedAsin&metrics=units`)).items[0].values.units).toBe(2)
    expect((await get(admin, '/ads/metrics?dataset=HOURLY&dims=hour&metrics=clicks')).items[0].values.clicks).toBe(2)
    const page = await get(admin, `/ads/metrics?${RANGE}&dims=date&metrics=spend&sort=key:asc&pageSize=2`)
    expect(page.pageInfo.hasMore).toBe(true)
    const cursor = encodeURIComponent(page.pageInfo.nextCursor)
    expect((await get(admin, `/ads/metrics?${RANGE}&dims=date&metrics=spend&sort=key:asc&pageSize=2&cursor=${cursor}`)).items[0].key).not.toBe(page.items[0].key)
    expect((await h.call(admin.token, 'GET', `/ads/metrics?${RANGE}&dims=date&metrics=sales&sort=key:asc&pageSize=2&cursor=${cursor}`)).status).toBe(400)
    expect((await h.call(admin.token, 'GET', `/ads/metrics?${RANGE}&dataset=PLACEMENT&dims=searchTerm&metrics=spend`)).status).toBe(422)
  })

  it('指标：数据范围与企业隔离——只能看到自己范围内档案的数据；对方企业什么都看不到；没数据是“尚无记录”', async () => {
    await importReport('CAMPAIGN_DAILY', 'DAILY', [{ date: '2026-09-07', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'CB', impressions: 1, clicks: 1, cost: 77, sales: 1, purchases: 1 }], 'ap-b')
    const a = await get(scopedA, `/ads/metrics?${RANGE}&dims=campaign&metrics=spend`)
    expect(a.items.map((item: Row) => item.key)).not.toContain('CB')
    expect(a.profiles.map((item: Row) => item.id)).toEqual(['ap-a'])
    const b = await get(scopedB, `/ads/metrics?${RANGE}&dims=campaign&metrics=spend`)
    expect(b.items.map((item: Row) => item.key)).toEqual(['CB'])
    expect((await get(admin, `/ads/metrics?${RANGE}&dims=campaign&metrics=spend&adsProfileId=ap-b`)).items.map((item: Row) => item.key)).toEqual(['CB'])
    expect(await get(other, `/ads/metrics?${RANGE}&dims=campaign&metrics=spend`)).toMatchObject({ state: 'NO_DATA', items: [], totals: { spend: null } })
    expect((await get(admin, `/ads/metrics?from=2020-01-01&to=2020-01-31&dims=date&metrics=spend`)).note).toContain('没有记录')
    await get(noAds, '/ads/metrics', 403)
  })

  it('迁移期核对：只读总览（档案状态、最近核对、四类差异计数）、差异明细（未解释在前）、手动触发只排任务；范围与企业隔离', async () => {
    await insertRow(h.client, 'AdsParityState', { id: 'ps-a', tenantId, adsProfileId: 'ap-a', legacyEnabled: true, consecutivePasses: 3, requiredPasses: 7, lastRunAt: '2026-10-01T00:00:00Z' })
    await insertRow(h.client, 'AdsParityRun', {
      id: 'run-1',
      tenantId,
      adsProfileId: 'ap-a',
      windowStart: '2026-09-17',
      windowEnd: '2026-09-30',
      legacyCount: 10,
      newCount: 10,
      matchedCount: 8,
      unexplainedCount: 1,
      status: 'HAS_DIFFS',
      startedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsParityRun', { id: 'run-b', tenantId, adsProfileId: 'ap-b', windowStart: '2026-09-17', windowEnd: '2026-09-30', status: 'PASSED', startedAt: '2026-10-02T00:00:00Z' })
    await insertRow(h.client, 'AdsParityRun', { id: 'run-o', tenantId: otherTenantId, adsProfileId: 'ap-o', windowStart: '2026-09-17', windowEnd: '2026-09-30', status: 'PASSED' })
    const diff = (id: string, category: string, at: string) =>
      insertRow(h.client, 'AdsParityDiff', {
        id,
        tenantId,
        runId: 'run-1',
        category,
        entityKey: `2026-09-01|${id}`,
        field: 'cost',
        legacyValue: '1',
        newValue: '2',
        explanation: `原因 ${id}`,
        createdAt: at,
      })
    await diff('d-time', 'TIME_BASIS', '2026-10-01T00:00:01Z')
    await diff('d-unexplained', 'UNEXPLAINED', '2026-10-01T00:00:03Z')
    await diff('d-scope', 'SCOPE', '2026-10-01T00:00:02Z')
    const overview = await get(admin, '/ads/parity')
    expect(overview.state).toBe('OK')
    expect(overview.sunsetNote).toContain('2027 年 6 月 30 日')
    expect(overview.profiles.find((item: Row) => item.id === 'ap-a')).toMatchObject({ adsAccountReady: true, legacyEnabled: true, consecutivePasses: 3, requiredPasses: 7, lastStatus: 'HAS_DIFFS' })
    expect(overview.profiles.find((item: Row) => item.id === 'ap-u')).toMatchObject({ adsAccountReady: false, lastStatus: null, consecutivePasses: 0 })
    expect(overview.runs.find((item: Row) => item.id === 'run-1')).toMatchObject({ counts: { TIME_BASIS: 1, ATTRIBUTION_BASIS: 0, SCOPE: 1, UNEXPLAINED: 1 }, profileName: '档案 P-A' })
    expect((await get(scopedB, '/ads/parity')).runs.map((item: Row) => item.id)).toEqual(['run-b'])
    expect((await get(other, '/ads/parity')).runs.map((item: Row) => item.id)).toEqual(['run-o'])
    const detail = await get(admin, '/ads/parity/run-1/diffs')
    expect(detail.items.map((item: Row) => item.category)).toEqual(['UNEXPLAINED', 'SCOPE', 'TIME_BASIS']) // 未解释的排最前
    expect(detail.truncated).toBe(false)
    await get(scopedB, '/ads/parity/run-1/diffs', 404)
    await get(other, '/ads/parity/run-1/diffs', 404)
    const run = await post(admin, '/ads/parity/run', { profileId: 'ap-a' })
    expect(run.status, JSON.stringify(run.json)).toBe(202)
    expect((await rows<{ type: string; context: Row }>(`SELECT type, context FROM "SyncJob" WHERE id = $1`, [run.json.data.syncJobId]))[0]).toMatchObject({
      type: 'ADS_PARITY',
      context: { adsProfileId: 'ap-a' },
    })
    expect(code(await post(admin, '/ads/parity/run', { profileId: 'ap-u' }))).toBe('ADS_ACCOUNT_MISSING')
    expect((await post(scopedA, '/ads/parity/run', { profileId: 'ap-b' })).status).toBe(404)
    expect((await post(reader, '/ads/parity/run', { profileId: 'ap-a' })).status).toBe(403)
  })

  it('核对的定时排任务：只给已发现账户编号、旧通道开着、满 24 小时的档案排任务；已有没做完的不重复排；没授权的企业不排', async () => {
    const queues = { addSync: vi.fn().mockResolvedValue(undefined) }
    // 手动触发那次留下一个没做完的 ap-a 任务；ap-b 没有核对状态（视为从未核对）
    const first = await runWithTenant(tenantId, () => schedule(tenantDb, queues, tenantId, new Date()))
    expect(first).toBe(1)
    expect(queues.addSync).toHaveBeenCalledWith('ADS_PARITY', expect.objectContaining({ adsProfileId: 'ap-b', tenantId }), expect.objectContaining({ priority: expect.any(Number) }))
    expect(await runWithTenant(tenantId, () => schedule(tenantDb, queues, tenantId, new Date()))).toBe(0)
    expect(await runWithTenant(otherTenantId, () => schedule(tenantDb, queues, otherTenantId, new Date()))).toBe(0)
    await h.client.query(`UPDATE "AdsParityState" SET "legacyEnabled" = false WHERE "adsProfileId" = 'ap-a'`)
    await h.client.query(`UPDATE "SyncJob" SET status = 'SUCCEEDED' WHERE type = 'ADS_PARITY'`)
    expect(await runWithTenant(tenantId, () => schedule(tenantDb, queues, tenantId, new Date()))).toBe(1)
  })

  it('回滚与重放：rollback.sql 删掉新增的列，migration.sql 能重新加上（旧任务保持旧来源）', async () => {
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    const gone = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'AdsReportJob' AND column_name IN ('source', 'templateKey', 'retryOfId')`)
    expect(gone[0]!.n).toBe(0)
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'AdsProfile' AND column_name = 'historyFrom'`))[0]!.n).toBe(0)
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    const back = await rows<{ source: string; n: number }>(`SELECT source, count(*)::int AS n FROM "AdsReportJob" GROUP BY source`)
    expect(back).toEqual([{ source: 'LEGACY', n: expect.any(Number) }])
    await expect(h.client.query(`UPDATE "AdsReportJob" SET source = 'BOGUS' WHERE id = 'job-legacy-failed'`)).rejects.toThrow(/AdsReportJob_source_check/)
  })
})
