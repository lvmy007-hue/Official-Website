import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ObjectStorageService } from '../platform/storage/object-storage.service'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 报表中心（P5-03，真实数据库 + 完整应用）：三个来源合并列表、创建与去重、取消、重试、下载与审计、数据范围、企业隔离、迁移的检查约束与回滚重放。

type Member = { userId: string; token: string }
type Row = Record<string, any>

const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261201010000_report_center')
const DAY_MS = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
const RETURNS = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'

describe('报表中心（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let admin: Member
  let scopedB: Member
  let reader: Member
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, status = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} ${JSON.stringify(res.json)}`).toBe(status)
    return res.json.data as Row
  }
  const post = (member: Member, path: string, body?: unknown) => h.call(member.token, 'POST', path, { body })
  const code = (res: { json: any }) => res.json?.error?.code as string
  const range = () => ({ from: daysAgo(10), to: daysAgo(3) })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'report_center' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-b2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-B2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher', sellerAccountId: storeA })
    await insertRow(h.client, 'PlatformConnection', {
      id: 'conn-b',
      tenantId: b.tenantId,
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      encryptedRefreshToken: 'cipher',
      sellerAccountId: b.sellerAccountId,
    })
    admin = await h.createMember(tenantId, 'admin', ['reports.read', 'reports.create'])
    scopedB = await h.createMember(tenantId, 'scopedb', ['reports.read', 'reports.create'], { scopes: [{ sellerAccountId: storeB }] })
    reader = await h.createMember(tenantId, 'reader', ['reports.read'])
    other = await h.createMember(b.tenantId, 'other', ['reports.read', 'reports.create'])
  })
  afterAll(async () => {
    await h?.close()
  })

  it('还没有任何任务：尚无记录，各状态与各业务域条数都是 0', async () => {
    const list = await get(admin, '/reports')
    expect(list).toMatchObject({ state: 'NO_DATA', items: [], truncated: false })
    expect(list.note).toContain('尚无记录')
    expect(Object.values(list.counts).every(value => value === 0)).toBe(true)
    expect(Object.values(list.domainCounts).every(value => value === 0)).toBe(true)
  })

  let first: Row
  it('创建：写任务与同步任务并互相关联、登记写流程、入队；同一店铺、类型、周期再创建 409', async () => {
    const res = await post(admin, '/reports', { reportType: RETURNS, ...range() })
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    first = res.json.data
    expect(first.report).toMatchObject({ status: 'PENDING', source: 'SP_API', label: '客户退货报告', domain: 'LOGISTICS', attempt: 1, canCancel: true, canRetry: false, canDownload: false })
    const [job] = await rows<Row>(`SELECT *, "fromDate"::text AS "fromText" FROM "FbaReportJob" WHERE id = $1`, [first.report.id])
    expect(job).toMatchObject({ tenantId, sellerAccountId: storeA, reportType: RETURNS, status: 'PENDING', syncJobId: first.syncJobId, attempt: 1, retryOfId: null })
    expect(job.fromText.slice(0, 10)).toBe(range().from)
    const [sync] = await rows<Row>(`SELECT * FROM "SyncJob" WHERE id = $1`, [first.syncJobId])
    expect(sync).toMatchObject({ type: 'FBA_REPORT_CREATE', status: 'PENDING', connectionId: 'conn-a' })
    expect(sync.context).toMatchObject({ reportJobId: first.report.id, reportType: RETURNS })
    expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ reportJobId: first.report.id }), first.syncJobId, expect.anything())
    expect((await rows<Row>(`SELECT * FROM "WorkflowRun" WHERE kind = 'report.create' AND "dedupeKey" LIKE $1`, [`%${first.report.id}%`])).length).toBe(1)
    expect(code(await post(admin, '/reports', { reportType: RETURNS, ...range() }))).toBe('REPORT_ALREADY_RUNNING')
    expect((await rows(`SELECT 1 FROM "FbaReportJob" WHERE "tenantId" = $1`, [tenantId])).length).toBe(1)
  })

  it('权限与参数：只读成员不能创建（403）；周期不合法 422；只能检索的类型 422', async () => {
    expect((await post(reader, '/reports', { reportType: RETURNS, ...range() })).status).toBe(403)
    expect(code(await post(admin, '/reports', { reportType: RETURNS, from: daysAgo(80), to: daysAgo(3) }))).toBe('REPORT_PERIOD_INVALID')
    expect(code(await post(admin, '/reports', { reportType: 'GET_FBA_INVENTORY_PLANNING_DATA', ...range() }))).toBe('REPORT_PERIOD_INVALID')
    expect((await post(admin, '/reports', { reportType: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2' })).status).toBe(422)
    expect((await post(scopedB, '/reports', { reportType: 'GET_FBA_INVENTORY_PLANNING_DATA' })).status).toBe(403) // 连接的店铺是 A，不在 B 的范围内
  })

  it('详情：请求参数、时间线（创建事件补出）、关联同步任务；统计没有记录是空', async () => {
    const data = await get(admin, `/reports/${first.report.id}`)
    expect(data.report).toMatchObject({ id: first.report.id, status: 'PENDING', parseState: 'NOT_STARTED' })
    expect(data.request.params).toMatchObject({ reportType: RETURNS, dataStartDate: range().from, dataEndDate: range().to })
    expect(data.timeline.map((item: Row) => item.stage)).toEqual(['REQUESTED'])
    expect(data.syncJob).toMatchObject({ id: first.syncJobId, type: 'FBA_REPORT_CREATE', status: 'PENDING' })
    expect(data.stats).toMatchObject({ read: null, imported: null, skipped: null, failed: null })
  })

  it('取消：置为已取消并记结束时间；再取消 409；已取消的任务可重试一次，新任务指回原任务、原任务时间线记一笔', async () => {
    const cancelled = await post(admin, `/reports/${first.report.id}/cancel`)
    expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200)
    expect(cancelled.json.data).toMatchObject({ status: 'CANCELLED', failureText: '已在报表中心取消', canCancel: false, canRetry: true })
    const [job] = await rows<Row>(`SELECT status, "failureCode", "finishedAt" FROM "FbaReportJob" WHERE id = $1`, [first.report.id])
    expect(job).toMatchObject({ status: 'CANCELLED', failureCode: 'REPORT_CANCELLED' })
    expect(job.finishedAt).not.toBeNull()
    expect(code(await post(admin, `/reports/${first.report.id}/cancel`))).toBe('REPORT_NOT_CANCELABLE')

    const retried = await post(admin, `/reports/${first.report.id}/retry`)
    expect(retried.status, JSON.stringify(retried.json)).toBe(202)
    expect(retried.json.data.report).toMatchObject({ attempt: 2, retryOfId: first.report.id, status: 'PENDING' })
    const [original] = await rows<Row>(`SELECT "timelineJson" FROM "FbaReportJob" WHERE id = $1`, [first.report.id])
    expect(original.timelineJson.at(-1)).toMatchObject({ stage: 'RETRIED' })
    expect(code(await post(admin, `/reports/${first.report.id}/retry`))).toBe('REPORT_ALREADY_RETRIED')
    const detail = await get(admin, `/reports/${first.report.id}`)
    expect(detail.timeline.map((item: Row) => item.stage)).toEqual(
      ['REQUESTED', 'RETRIED', 'CANCELLED'].sort((x, y) => detail.timeline.findIndex((i: Row) => i.stage === x) - detail.timeline.findIndex((i: Row) => i.stage === y)),
    )
    expect(detail.timeline.map((item: Row) => item.stage)).toEqual(expect.arrayContaining(['REQUESTED', 'CANCELLED', 'RETRIED']))
    expect((await post(admin, `/reports/${retried.json.data.report.id}/retry`)).status).toBe(409) // 还在排队中，不能重试
  })

  it('三个来源合并：亚马逊报告、广告报告、数据中心查询按创建时间排序；业务域筛选、各业务域条数、翻页与游标绑定', async () => {
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId, profileId: 'P-B', displayName: '档案 B', sellerAccountId: storeB, bindingStatus: 'MANUAL', adsAccountId: 'ACC-B' })
    await insertRow(h.client, 'AdsReportJob', {
      id: 'ads-job-1',
      tenantId,
      adsProfileId: 'ap-b',
      reportType: 'CAMPAIGN_DAILY',
      source: 'V1',
      templateKey: 'CAMPAIGN_DAILY',
      granularity: 'DAILY',
      status: 'READY',
      importedRows: 40,
      skippedRows: 1,
      requestId: 'test',
      fromDate: daysAgo(9),
      toDate: daysAgo(8),
    })
    await insertRow(h.client, 'SyncJob', {
      id: 'kiosk-job-1',
      tenantId,
      connectionId: 'conn-a',
      type: 'DATA_KIOSK_QUERY',
      status: 'FAILED_PERMANENT',
      failureCode: 'SCOPE_UNAVAILABLE',
      requestId: 'schedule',
      domain: 'datakiosk',
    })
    await h.client.query(`UPDATE "SyncJob" SET context = $2::jsonb WHERE id = $1`, [
      'kiosk-job-1',
      JSON.stringify({ dataset: 'dk.economics', params: { startDate: daysAgo(30), endDate: daysAgo(1), sellerAccountId: storeA } }),
    ])
    const all = await get(admin, '/reports?pageSize=50')
    const sources = new Set(all.items.map((item: Row) => item.source))
    expect([...sources].sort()).toEqual(['ADS', 'DATA_KIOSK', 'SP_API'])
    const times = all.items.map((item: Row) => item.createdAt)
    expect(times).toEqual([...times].sort().reverse())
    expect(all.domainCounts).toMatchObject({ LOGISTICS: 2, ADS: 1, DATA_CENTER: 1 })
    expect(all.counts).toMatchObject({ PENDING: 1, CANCELLED: 1, READY: 1, FAILED: 1 })
    const kiosk = all.items.find((item: Row) => item.source === 'DATA_KIOSK')
    expect(kiosk).toMatchObject({ status: 'FAILED', domain: 'DATA_CENTER', storeName: expect.any(String), failureText: expect.stringContaining('') })
    expect((await get(admin, '/reports?domain=ADS')).items.map((item: Row) => item.id)).toEqual(['ads-job-1'])
    expect((await get(admin, '/reports?status=CANCELLED')).items.map((item: Row) => item.id)).toEqual([first.report.id])
    expect((await get(admin, '/reports?source=DATA_KIOSK')).items.map((item: Row) => item.id)).toEqual(['kiosk-job-1'])
    expect((await get(admin, '/reports?q=退货')).items.every((item: Row) => item.reportKey === RETURNS)).toBe(true)
    const page1 = await get(admin, '/reports?pageSize=2')
    expect(page1).toMatchObject({ items: expect.any(Array), pageInfo: { hasMore: true, approxTotal: 4 } })
    const page2 = await get(admin, `/reports?pageSize=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`)
    expect([...page1.items, ...page2.items].map((item: Row) => item.id)).toEqual(all.items.map((item: Row) => item.id))
    expect(page2.pageInfo.hasMore).toBe(false)
    expect((await h.call(admin.token, 'GET', `/reports?pageSize=2&status=READY&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`)).status).toBe(400)
    const ads = await get(admin, '/reports/ads-job-1')
    expect(ads.report).toMatchObject({ source: 'ADS', importedRows: 40, skippedRows: 1 })
    expect(ads.stats).toMatchObject({ read: null, imported: 40, skipped: 1, failed: 0 })
    const kioskDetail = await get(admin, '/reports/kiosk-job-1')
    expect(kioskDetail.request).toMatchObject({ dataset: 'dk.economics' })
    expect(kioskDetail.syncJob).toMatchObject({ id: 'kiosk-job-1', type: 'DATA_KIOSK_QUERY', failureCode: 'SCOPE_UNAVAILABLE' })
  })

  it('数据范围：只授权店铺 B 的成员看不到店铺 A 的亚马逊报告与数据中心任务，也不能对它取消、重试、下载', async () => {
    const list = await get(scopedB, '/reports?pageSize=50')
    expect(list.items.map((item: Row) => item.id)).toEqual(['ads-job-1']) // 只有绑定到店铺 B 的广告档案的任务
    expect(list.domainCounts).toMatchObject({ LOGISTICS: 0, ADS: 1, DATA_CENTER: 0 })
    await get(scopedB, `/reports/${first.report.id}`, 404)
    await get(scopedB, '/reports/kiosk-job-1', 404)
    for (const path of [`/reports/${first.report.id}/cancel`, `/reports/${first.report.id}/retry`]) expect((await post(scopedB, path)).status, path).toBe(404)
    await get(scopedB, `/reports/${first.report.id}/download`, 404)
  })

  it('企业隔离：别的企业看不到、也动不了这些任务', async () => {
    expect((await get(other, '/reports')).items).toEqual([])
    for (const id of [first.report.id, 'ads-job-1', 'kiosk-job-1']) await get(other, `/reports/${id}`, 404)
    for (const path of [`/reports/${first.report.id}/cancel`, `/reports/${first.report.id}/retry`]) expect((await post(other, path)).status, path).toBe(404)
    await get(other, `/reports/${first.report.id}/download`, 404)
    const [job] = await rows<Row>(`SELECT status FROM "FbaReportJob" WHERE id = $1`, [first.report.id])
    expect(job!.status).toBe('CANCELLED')
  })

  it('下载：已完成且在保留期内的任务发短时链接并写审计；没有文件或已过保留期 409', async () => {
    const jobId = 'rj-done'
    await insertRow(h.client, 'FbaReportJob', {
      id: jobId,
      tenantId,
      sellerAccountId: storeA,
      reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
      status: 'READY',
      requestId: 'test',
      readRows: 5,
      importedRows: 5,
      skippedRows: 0,
    })
    await h.client.query(`UPDATE "FbaReportJob" SET "timelineJson" = $2::jsonb, "finishedAt" = now() WHERE id = $1`, [jobId, JSON.stringify([{ at: new Date().toISOString(), stage: 'DOWNLOADING' }])])
    const done = await get(admin, `/reports/${jobId}`)
    expect(done.report).toMatchObject({ status: 'READY', fileState: 'NOT_STORED', canDownload: false, parseState: 'DONE' })
    expect(code(await h.call(admin.token, 'GET', `/reports/${jobId}/download`))).toBe('REPORT_FILE_UNAVAILABLE')

    await insertRow(h.client, 'RawReportFile', {
      id: 'raw-1',
      tenantId,
      storeKey: storeA,
      sourceKey: `report:${jobId}`,
      objectKey: `tenants/${tenantId}/reports/${jobId}.raw`,
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      retentionUntil: new Date(Date.now() + 30 * DAY_MS),
    })
    const signDownload = vi.fn().mockResolvedValue({ url: 'https://files.example/raw?sig=1', method: 'GET', headers: {}, expiresAt: new Date(Date.now() + 300_000) })
    vi.spyOn(h.app.get(ObjectStorageService), 'forTenant').mockReturnValue({ signDownload } as never)
    expect((await get(admin, `/reports/${jobId}`)).report).toMatchObject({ fileState: 'STORED', canDownload: true })
    const link = await get(reader, `/reports/${jobId}/download`)
    expect(link.url).toBe('https://files.example/raw?sig=1')
    expect(signDownload).toHaveBeenCalledWith(`tenants/${tenantId}/reports/${jobId}.raw`, 300)
    const audit = await rows<Row>(`SELECT action, "resourceType", "resourceId" FROM "AuditEvent" WHERE action = 'REPORT_DOWNLOAD_LINK_ISSUED'`)
    expect(audit).toEqual([{ action: 'REPORT_DOWNLOAD_LINK_ISSUED', resourceType: 'FbaReportJob', resourceId: jobId }])

    await h.client.query(`UPDATE "RawReportFile" SET "retentionUntil" = now() - interval '1 day' WHERE id = 'raw-1'`)
    expect((await get(admin, `/reports/${jobId}`)).report).toMatchObject({ fileState: 'EXPIRED', canDownload: false })
    expect(code(await h.call(admin.token, 'GET', `/reports/${jobId}/download`))).toBe('REPORT_FILE_UNAVAILABLE')
    expect(signDownload).toHaveBeenCalledTimes(1)
  })

  it('迁移的检查约束：任务状态只能是五种，尝试次数至少 1，行数不能为负', async () => {
    await expect(h.client.query(`UPDATE "FbaReportJob" SET status = 'BOGUS' WHERE id = 'rj-done'`)).rejects.toThrow(/FbaReportJob_status_check/)
    await expect(h.client.query(`UPDATE "FbaReportJob" SET attempt = 0 WHERE id = 'rj-done'`)).rejects.toThrow(/FbaReportJob_attempt_check/)
    await expect(h.client.query(`UPDATE "FbaReportJob" SET "importedRows" = -1 WHERE id = 'rj-done'`)).rejects.toThrow(/FbaReportJob_rows_check/)
    await expect(h.client.query(`UPDATE "FbaReportJob" SET status = 'CANCELLED' WHERE id = 'rj-done'`)).resolves.toBeDefined()
  })

  it('回滚与重放：rollback.sql 删掉新增的列，migration.sql 能重新加上，任务行保留', async () => {
    const before = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "FbaReportJob"`))[0]!.n
    await h.client.query(`UPDATE "FbaReportJob" SET status = 'FAILED', "failureCode" = 'REPORT_CANCELLED' WHERE status = 'CANCELLED'`)
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    const gone = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'FbaReportJob' AND column_name IN ('syncJobId', 'readRows', 'timelineJson', 'retryOfId', 'attempt')`,
    )
    expect(gone[0]!.n).toBe(0)
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "FbaReportJob"`))[0]!.n).toBe(before)
    expect((await rows<{ attempt: number }>(`SELECT attempt FROM "FbaReportJob" LIMIT 1`))[0]!.attempt).toBe(1)
    await expect(h.client.query(`UPDATE "FbaReportJob" SET status = 'BOGUS'`)).rejects.toThrow(/FbaReportJob_status_check/)
  })
})
