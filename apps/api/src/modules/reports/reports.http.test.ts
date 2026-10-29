import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObjectStorageService } from '../../platform/storage/object-storage.service'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const NOW = Date.now()
const HOUR = 3_600_000
const day = (offset: number) => new Date(NOW - offset * 86_400_000).toISOString().slice(0, 10)

const job = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
  marketplaceId: 'ATVPDKIKX0DER',
  fromDate: new Date(`${day(10)}T00:00:00Z`),
  toDate: new Date(`${day(3)}T00:00:00Z`),
  status: 'READY',
  externalReportId: 'amz-1',
  documentId: 'doc-1',
  failureCode: null,
  failureMessage: null,
  requestId: 'req-1',
  createdById: 'user-1',
  createdAt: new Date(NOW - HOUR),
  syncJobId: 'sj1',
  readRows: 12,
  importedRows: 10,
  skippedRows: 2,
  warningsJson: [{ code: 'NEW_COLUMN', message: '新出现的字段：extra' }],
  timelineJson: [
    { at: new Date(NOW - 50 * 60_000).toISOString(), stage: 'SUBMITTED', text: '亚马逊报告编号 amz-1' },
    { at: new Date(NOW - 40 * 60_000).toISOString(), stage: 'AMAZON_PROCESSING' },
    { at: new Date(NOW - 30 * 60_000).toISOString(), stage: 'AMAZON_DONE' },
    { at: new Date(NOW - 29 * 60_000).toISOString(), stage: 'DOWNLOADING' },
  ],
  retryOfId: null,
  attempt: 1,
  startedAt: new Date(NOW - 50 * 60_000),
  finishedAt: new Date(NOW - 28 * 60_000),
  updatedAt: new Date(NOW - 28 * 60_000),
  sellerAccount: { displayName: '美国店' },
  ...over,
})
const adsJob = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  templateKey: 'CAMPAIGN_DAILY',
  reportType: 'campaign',
  adProduct: 'SPONSORED_PRODUCTS',
  granularity: 'DAILY',
  dimensions: ['campaignId'],
  metricKeys: ['impressions'],
  fromDate: new Date(`${day(9)}T00:00:00Z`),
  toDate: new Date(`${day(8)}T00:00:00Z`),
  status: 'READY',
  externalReportId: 'ads-1',
  importedRows: 40,
  skippedRows: 0,
  warningSignals: null,
  failureCode: null,
  failureMessage: null,
  requestId: 'req-a',
  attempt: 1,
  retryOfId: null,
  requestedBy: null,
  createdAt: new Date(NOW - 2 * HOUR),
  startedAt: null,
  finishedAt: new Date(NOW - 2 * HOUR + 60_000),
  adsProfile: { displayName: null, profileId: '111', sellerAccount: { displayName: '美国店' } },
  ...over,
})
const kioskJob = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  status: 'SUCCEEDED',
  failureCode: null,
  requestId: 'schedule',
  context: { dataset: 'dk.economics', params: { startDate: day(30), endDate: day(1), sellerAccountId: 's1' } },
  attempts: 1,
  createdAt: new Date(NOW - 3 * HOUR),
  startedAt: new Date(NOW - 3 * HOUR),
  finishedAt: new Date(NOW - 3 * HOUR + 60_000),
  ...over,
})

function prismaFor(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    membership: {
      findFirst: sessionStub(permissions).membership.findFirst,
      findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '张三', email: 'z@example.com' } }]),
    },
    fbaReportJob: {
      findMany: vi.fn().mockResolvedValue([job()]),
      findFirst: vi.fn().mockResolvedValue(job()),
      findFirstOrThrow: vi.fn().mockResolvedValue(job({ id: 'r-new', status: 'PENDING', timelineJson: null, syncJobId: null })),
      groupBy: vi
        .fn()
        .mockImplementation(async ({ by }: { by: string[] }) =>
          by[0] === 'status' ? [{ status: 'READY', _count: { _all: 1 } }] : [{ reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', _count: { _all: 1 } }],
        ),
      create: vi.fn().mockResolvedValue({ id: 'r-new' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    adsReportJob: {
      findMany: vi.fn().mockResolvedValue([adsJob()]),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([{ status: 'READY', _count: { _all: 1 } }]),
      count: vi.fn().mockResolvedValue(1),
    },
    syncJob: {
      findMany: vi.fn().mockResolvedValue([kioskJob()]),
      findFirst: vi.fn().mockResolvedValue({ id: 'sj1', type: 'FBA_REPORT_CREATE', status: 'SUCCEEDED', attempts: 1, failureCode: null, startedAt: new Date(NOW), finishedAt: new Date(NOW) }),
      groupBy: vi.fn().mockResolvedValue([{ status: 'SUCCEEDED', _count: { _all: 1 } }]),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue({ id: 'sj-new', priority: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    rawReportFile: {
      findMany: vi.fn().mockResolvedValue([{ sourceKey: 'report:r1', retentionUntil: new Date(NOW + 30 * 86_400_000) }]),
      findFirst: vi.fn().mockResolvedValue({ objectKey: 'tenants/tenant-1/reports/r1.raw', retentionUntil: new Date(NOW + 30 * 86_400_000), sizeBytes: 2048n }),
    },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国店' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
    platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'c1', sellerAccountId: 's1' }) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...over,
  }
  return prisma
}
const audits = (_prisma?: unknown) => (harness?.writeGuardStubs.auditEvent.create.mock.calls ?? []).map((call: any[]) => call[0].data)
const WEEK = { from: '2025-10-05', to: '2025-10-11' } // 周日到周六，早已结束

describe('报表中心列表', () => {
  it('权限：没有 reports.read 是 403', async () => {
    harness = await createTestApp(prismaFor(['orders.read']))
    expect((await harness.call('GET', '/reports')).status).toBe(403)
  })

  it('合并三个来源，按创建时间从新到旧；每行带申请条件、周期、文件与解析状态', async () => {
    harness = await createTestApp(prismaFor(['reports.read']))
    const res = await harness.call('GET', '/reports')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const { items, counts, domainCounts, state, truncated } = res.json.data
    expect(state).toBe('OK')
    expect(truncated).toBe(false)
    expect(items.map((item: any) => `${item.source}:${item.id}`)).toEqual(['SP_API:r1', 'ADS:a1', 'DATA_KIOSK:k1'])
    expect(items[0]).toMatchObject({
      label: '客户退货报告',
      domain: 'LOGISTICS',
      storeName: '美国店',
      status: 'READY',
      fileState: 'STORED',
      parseState: 'DONE',
      readRows: 12,
      importedRows: 10,
      skippedRows: 2,
      canDownload: true,
      createdByName: '张三',
      analysisPath: '/app/returns',
    })
    expect(items[0].requirement).toContain('Amazon Fulfillment')
    expect(items[1]).toMatchObject({ domain: 'ADS', fileState: 'NOT_APPLICABLE', canCancel: false, canRetry: false, createPath: '/app/advertising/reports' })
    expect(items[2]).toMatchObject({ domain: 'DATA_CENTER', label: '官方单品经济（按天、按 SKU）', createdByName: '系统', storeName: '美国店' })
    expect(counts).toMatchObject({ READY: 3, FAILED: 0, CANCELLED: 0 })
    expect(domainCounts).toMatchObject({ LOGISTICS: 1, ADS: 1, DATA_CENTER: 1, BRAND: 0 })
  })

  it('业务域筛选只读对应来源：选“广告”不会去查亚马逊报告与数据中心任务', async () => {
    const prisma = prismaFor(['reports.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/reports?domain=ADS')
    expect(res.json.data.items.map((item: any) => item.id)).toEqual(['a1'])
    expect(prisma.fbaReportJob.findMany).not.toHaveBeenCalled()
    expect(prisma.syncJob.findMany).not.toHaveBeenCalled()
    const logistics = await harness.call('GET', '/reports?domain=LOGISTICS')
    expect(logistics.json.data.items.map((item: any) => item.id)).toEqual(['r1'])
    expect(prisma.fbaReportJob.findMany.mock.calls.map((call: any[]) => call[0]).find((arg: any) => arg.select)?.where.AND).toEqual([
      { reportType: { in: expect.arrayContaining(['GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA']) } },
    ])
  })

  it('没有任何任务：尚无记录并说明去哪里创建；筛选后没有则提示放宽条件', async () => {
    const prisma = prismaFor(['reports.read'], {
      fbaReportJob: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
      adsReportJob: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      syncJob: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    })
    harness = await createTestApp(prisma)
    const empty = await harness.call('GET', '/reports')
    expect(empty.json.data).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(empty.json.data.note).toContain('尚无记录')
    expect((await harness.call('GET', '/reports?status=FAILED')).json.data.note).toContain('放宽')
  })

  it('翻页：游标由服务端签名并绑定查询条件，条件变了游标失效（400）', async () => {
    harness = await createTestApp(prismaFor(['reports.read']))
    const first = await harness.call('GET', '/reports?pageSize=1')
    expect(first.json.data.items).toHaveLength(1)
    expect(first.json.data.pageInfo).toMatchObject({ hasMore: true, approxTotal: 3 })
    const cursor = encodeURIComponent(first.json.data.pageInfo.nextCursor)
    const second = await harness.call('GET', `/reports?pageSize=1&cursor=${cursor}`)
    expect(second.json.data.items.map((item: any) => item.id)).toEqual(['a1'])
    expect((await harness.call('GET', `/reports?pageSize=1&status=FAILED&cursor=${cursor}`)).status).toBe(400)
    expect((await harness.call('GET', '/reports?domain=NOPE')).status).toBe(422)
  })
})

describe('报告任务详情', () => {
  it('亚马逊报告：请求参数、时间线（含补出的创建与完成）、导入统计、解析警告、关联同步任务', async () => {
    harness = await createTestApp(prismaFor(['reports.read']))
    const res = await harness.call('GET', '/reports/r1')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data
    expect(data.report).toMatchObject({ id: 'r1', status: 'READY', parseState: 'DONE' })
    expect(data.request).toMatchObject({
      externalReportId: 'amz-1',
      requestedBy: '张三',
      params: { reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', dataStartDate: day(10), dataEndDate: day(3) },
    })
    expect(data.timeline.map((item: any) => item.stage)).toEqual(['REQUESTED', 'SUBMITTED', 'AMAZON_PROCESSING', 'AMAZON_DONE', 'DOWNLOADING', 'IMPORTED'])
    expect(data.timeline.filter((item: any) => item.side === 'AMAZON').map((item: any) => item.stage)).toEqual(['SUBMITTED', 'AMAZON_PROCESSING', 'AMAZON_DONE'])
    expect(data.stats).toEqual({ read: 12, imported: 10, skipped: 2, ignored: 0, added: null, updated: null, failed: 0 })
    expect(data.warnings).toEqual([{ code: 'NEW_COLUMN', message: '新出现的字段：extra' }])
    expect(data.syncJob).toMatchObject({ id: 'sj1', status: 'SUCCEEDED' })
    expect(data.notes.join('')).toContain('不区分新增与更新')
  })

  it('失败任务：时间线末尾是失败原因；没有记录的统计是空而不是 0', async () => {
    const failed = job({ status: 'FAILED', failureCode: 'REPORT_FATAL', failureMessage: null, readRows: null, importedRows: null, skippedRows: null, warningsJson: null, syncJobId: null })
    harness = await createTestApp(
      prismaFor(['reports.read'], { fbaReportJob: { ...prismaFor([]).fbaReportJob, findFirst: vi.fn().mockResolvedValue(failed), findMany: vi.fn().mockResolvedValue([]) } }),
    )
    const res = await harness.call('GET', '/reports/r1')
    const data = res.json.data
    expect(data.report).toMatchObject({ status: 'FAILED', failureCode: 'REPORT_FATAL', parseState: 'FAILED', canRetry: true, canCancel: false })
    expect(data.report.failureText).toContain('亚马逊')
    expect(data.timeline.at(-1)).toMatchObject({ stage: 'FAILED' })
    expect(data.stats).toEqual({ read: null, imported: null, skipped: null, ignored: null, added: null, updated: null, failed: null })
  })

  it('广告报告与数据中心任务按各自来源适配；不存在、范围外都是 404', async () => {
    const prisma = prismaFor(['reports.read'])
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(null)
    prisma.adsReportJob.findFirst.mockResolvedValueOnce(adsJob())
    harness = await createTestApp(prisma)
    const ads = await harness.call('GET', '/reports/a1')
    expect(ads.json.data.report).toMatchObject({ source: 'ADS', id: 'a1' })
    expect(ads.json.data.request).toMatchObject({ adProduct: 'SPONSORED_PRODUCTS', dimensions: ['campaignId'], metrics: ['impressions'] })
    expect(ads.json.data.notes.join('')).toContain('广告报表')
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(null)
    prisma.adsReportJob.findFirst.mockResolvedValueOnce(null)
    prisma.syncJob.findFirst.mockResolvedValueOnce(kioskJob())
    const kiosk = await harness.call('GET', '/reports/k1')
    expect(kiosk.json.data.report).toMatchObject({ source: 'DATA_KIOSK', id: 'k1' })
    expect(kiosk.json.data.request).toMatchObject({ dataset: 'dk.economics', params: { sellerAccountId: 's1' } })
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(null)
    prisma.adsReportJob.findFirst.mockResolvedValueOnce(null)
    prisma.syncJob.findFirst.mockResolvedValueOnce(null)
    const missing = await harness.call('GET', '/reports/none')
    expect(missing.status).toBe(404)
    expect(missing.json.error.code).toBe('REPORT_NOT_FOUND')
  })
})

describe('创建报告任务', () => {
  const body = (over: Record<string, unknown> = {}) => ({ reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', from: day(10), to: day(3), ...over })
  const createdPrisma = () => {
    const prisma = prismaFor(['reports.create', 'reports.read'])
    prisma.fbaReportJob.findFirst.mockResolvedValue(null)
    return prisma
  }

  it('成功：建任务与同步任务、登记写流程、入队，返回 202 与任务行', async () => {
    const prisma = createdPrisma()
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/reports', { body: body() })
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    expect(res.json.data).toMatchObject({ syncJobId: 'sj-new', report: { id: 'r-new', status: 'PENDING', source: 'SP_API' } })
    const data = prisma.fbaReportJob.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      status: 'PENDING',
      createdById: 'user-1',
      attempt: 1,
      retryOfId: null,
    })
    expect(prisma.fbaReportJob.update).toHaveBeenCalledWith({ where: { id: 'r-new' }, data: { syncJobId: 'sj-new' } })
    expect(harness.workflow.registerWriteRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'report.create', syncJobId: 'sj-new' }))
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ syncJobId: 'sj-new', reportJobId: 'r-new' }), 'sj-new', expect.objectContaining({ type: 'FBA_REPORT_CREATE' }))
    expect(audits(prisma)).toContainEqual(expect.objectContaining({ action: 'REPORT_JOB_CREATED', resourceType: 'FbaReportJob' }))
  })

  it('权限：只有 reports.read 是 403，且不建任务', async () => {
    const prisma = prismaFor(['reports.read'])
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/reports', { body: body() })).status).toBe(403)
    expect(prisma.fbaReportJob.create).not.toHaveBeenCalled()
  })

  it('报告类型必须是目录里可创建的：不存在的、只能检索的（结算、销售税）都是 422', async () => {
    const prisma = createdPrisma()
    harness = await createTestApp(prisma)
    for (const reportType of ['GET_NOPE', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 'GET_FLAT_FILE_SALES_TAX_DATA']) {
      expect((await harness.call('POST', '/reports', { body: body({ reportType }) })).status, reportType).toBe(422)
    }
    expect((await harness.call('POST', '/reports', { body: body({ marketplaceId: 'A1F83G8C2ARO7P' }) })).status).toBe(422)
    expect(prisma.fbaReportJob.create).not.toHaveBeenCalled()
  })

  it('数据周期按目录登记的类型检查：快照不带日期；区间要两头、不倒置、最长 31 天、不晚于今天；品牌分析必须是完整自然周、月或季', async () => {
    const prisma = createdPrisma()
    harness = await createTestApp(prisma)
    const code = async (payload: Record<string, unknown>) => {
      const res = await harness!.call('POST', '/reports', { body: payload })
      return [res.status, res.json?.error?.code] as const
    }
    expect(await code({ reportType: 'GET_FBA_INVENTORY_PLANNING_DATA', from: day(5), to: day(2) })).toEqual([422, 'REPORT_PERIOD_INVALID'])
    expect(await code(body({ from: undefined, to: undefined }))).toEqual([422, 'REPORT_PERIOD_INVALID'])
    expect(await code(body({ from: day(2), to: day(5) }))).toEqual([422, 'REPORT_PERIOD_INVALID'])
    expect(await code(body({ from: day(60), to: day(3) }))).toEqual([422, 'REPORT_PERIOD_INVALID'])
    expect(await code(body({ from: day(3), to: '2999-01-01' }))).toEqual([422, 'REPORT_PERIOD_INVALID'])
    expect(await code(body({ from: '2026-02-30', to: '2026-03-01' }))).toEqual([422, 'REPORT_PERIOD_INVALID'])
    expect(await code({ reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', from: '2025-10-06', to: '2025-10-12' })).toEqual([422, 'REPORT_PERIOD_INVALID'])
    expect(prisma.fbaReportJob.create).not.toHaveBeenCalled()
    expect((await harness.call('POST', '/reports', { body: { reportType: 'GET_FBA_INVENTORY_PLANNING_DATA' } })).status).toBe(202)
    expect((await harness.call('POST', '/reports', { body: { reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', ...WEEK } })).status).toBe(202)
    expect(prisma.fbaReportJob.create.mock.calls[1][0].data).toMatchObject({ fromDate: new Date('2025-10-05T00:00:00Z'), toDate: new Date('2025-10-11T00:00:00Z') })
  })

  it('同一店铺、类型、周期已有没完成的任务：409，不重复创建', async () => {
    const prisma = prismaFor(['reports.create'])
    prisma.fbaReportJob.findFirst.mockResolvedValue({ id: 'running' })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/reports', { body: body() })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('REPORT_ALREADY_RUNNING')
    expect(prisma.fbaReportJob.create).not.toHaveBeenCalled()
  })

  it('没有完成卖家授权：409；受限成员创建别的店铺的任务：403', async () => {
    const noAuth = createdPrisma()
    noAuth.platformConnection.findFirst.mockResolvedValue(null)
    harness = await createTestApp(noAuth)
    expect((await harness.call('POST', '/reports', { body: body() })).status).toBe(409)
    await harness.close()
    const scoped = createdPrisma()
    scoped.membershipScope.findMany.mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's9' }])
    scoped.sellerAccount.findMany.mockResolvedValue([{ id: 's9' }])
    harness = await createTestApp(scoped)
    expect((await harness.call('POST', '/reports', { body: body() })).status).toBe(403)
    expect(scoped.fbaReportJob.create).not.toHaveBeenCalled()
  })

  it('入队失败：任务与同步任务都标成失败（QUEUE_UNAVAILABLE），返回 503 类错误而不是留下排队中的任务', async () => {
    const prisma = createdPrisma()
    harness = await createTestApp(prisma)
    harness.queue.add.mockRejectedValueOnce(new Error('redis down'))
    const res = await harness.call('POST', '/reports', { body: body() })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(prisma.fbaReportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE' }) }))
    expect(prisma.syncJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE' }) }))
  })
})

describe('取消与重试', () => {
  it('取消：排队中或生成中的任务置为已取消并记结束时间；不向亚马逊发请求', async () => {
    const prisma = prismaFor(['reports.create'])
    prisma.fbaReportJob.findFirst
      .mockResolvedValueOnce(job({ status: 'GENERATING', timelineJson: [], finishedAt: null }))
      .mockResolvedValueOnce(job({ status: 'CANCELLED', failureCode: 'REPORT_CANCELLED', timelineJson: [] }))
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/reports/r1/cancel')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ status: 'CANCELLED', failureText: '已在报表中心取消', canCancel: false, canRetry: true })
    expect(prisma.fbaReportJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', tenantId: 'tenant-1', status: { in: ['PENDING', 'GENERATING'] } },
      data: expect.objectContaining({ status: 'CANCELLED', failureCode: 'REPORT_CANCELLED' }),
    })
    expect(audits(prisma)).toContainEqual(expect.objectContaining({ action: 'REPORT_JOB_CANCELLED' }))
  })

  it('取消：已完成的、已开始下载解析的、任务刚好结束的都是 409', async () => {
    const prisma = prismaFor(['reports.create'])
    harness = await createTestApp(prisma)
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(job({ status: 'READY' }))
    expect((await harness.call('POST', '/reports/r1/cancel')).json.error.code).toBe('REPORT_NOT_CANCELABLE')
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(job({ status: 'GENERATING' })) // 时间线里已有 DOWNLOADING
    const parsing = await harness.call('POST', '/reports/r1/cancel')
    expect(parsing.status).toBe(409)
    expect(parsing.json.error.message).toContain('下载')
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(job({ status: 'GENERATING', timelineJson: [] }))
    prisma.fbaReportJob.updateMany.mockResolvedValueOnce({ count: 0 })
    expect((await harness.call('POST', '/reports/r1/cancel')).status).toBe(409)
    expect((await harness.call('POST', '/reports/r1/cancel', { idempotencyKey: false })).status).toBeGreaterThanOrEqual(400)
  })

  it('取消：别的权限、范围外或不存在的任务', async () => {
    harness = await createTestApp(prismaFor(['reports.read']))
    expect((await harness.call('POST', '/reports/r1/cancel')).status).toBe(403)
    await harness.close()
    const prisma = prismaFor(['reports.create'])
    prisma.fbaReportJob.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/reports/none/cancel')).status).toBe(404)
  })

  it('重试：失败任务新建一个 attempt + 1 的任务并指回原任务，原任务时间线记一笔', async () => {
    const prisma = prismaFor(['reports.create'])
    prisma.fbaReportJob.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.retryOfId || where.status ? null : job({ status: 'FAILED', failureCode: 'REPORT_FATAL', attempt: 1 }),
    )
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/reports/r1/retry')
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    expect(prisma.fbaReportJob.create.mock.calls[0][0].data).toMatchObject({ attempt: 2, retryOfId: 'r1', reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA' })
    const timeline = prisma.fbaReportJob.update.mock.calls.find((call: any[]) => call[0].where.id === 'r1')?.[0].data.timelineJson
    expect(timeline.at(-1)).toMatchObject({ stage: 'RETRIED' })
    expect(audits(prisma)).toContainEqual(expect.objectContaining({ action: 'REPORT_JOB_RETRIED' }))
  })

  it('重试：已完成的、已重试过的、只能检索的报告类型都是 409，不建任务', async () => {
    const prisma = prismaFor(['reports.create'])
    harness = await createTestApp(prisma)
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(job({ status: 'READY' }))
    expect((await harness.call('POST', '/reports/r1/retry')).json.error.code).toBe('REPORT_NOT_RETRYABLE')
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(job({ status: 'FAILED', reportType: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2' }))
    expect((await harness.call('POST', '/reports/r1/retry')).json.error.code).toBe('REPORT_NOT_RETRYABLE')
    prisma.fbaReportJob.findFirst.mockResolvedValueOnce(job({ status: 'CANCELLED' })).mockResolvedValueOnce({ id: 'r2' })
    expect((await harness.call('POST', '/reports/r1/retry')).json.error.code).toBe('REPORT_ALREADY_RETRIED')
    expect(prisma.fbaReportJob.create).not.toHaveBeenCalled()
  })
})

describe('下载原始文件', () => {
  it('在保留期内：发短时签名链接并写审计', async () => {
    const prisma = prismaFor(['reports.read'])
    harness = await createTestApp(prisma)
    const signDownload = vi.fn().mockResolvedValue({ url: 'https://files.example/r1?sig=1', method: 'GET', headers: {}, expiresAt: new Date(NOW + 300_000) })
    vi.spyOn(harness.app.get(ObjectStorageService), 'forTenant').mockReturnValue({ signDownload } as never)
    const res = await harness.call('GET', '/reports/r1/download')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data.url).toBe('https://files.example/r1?sig=1')
    expect(signDownload).toHaveBeenCalledWith('tenants/tenant-1/reports/r1.raw', 300)
    expect(audits(prisma)).toContainEqual(expect.objectContaining({ action: 'REPORT_DOWNLOAD_LINK_ISSUED', resourceType: 'FbaReportJob', resourceId: 'r1' }))
  })

  it('没有留存文件、已过保留期都是 409，不发链接也不写审计；没有权限 403', async () => {
    const prisma = prismaFor(['reports.read'])
    harness = await createTestApp(prisma)
    const signDownload = vi.fn()
    vi.spyOn(harness.app.get(ObjectStorageService), 'forTenant').mockReturnValue({ signDownload } as never)
    prisma.rawReportFile.findFirst.mockResolvedValueOnce(null)
    expect((await harness.call('GET', '/reports/r1/download')).json.error.code).toBe('REPORT_FILE_UNAVAILABLE')
    prisma.rawReportFile.findFirst.mockResolvedValueOnce({ objectKey: 'k', retentionUntil: new Date(NOW - 1000), sizeBytes: 1n })
    expect((await harness.call('GET', '/reports/r1/download')).json.error.code).toBe('REPORT_FILE_UNAVAILABLE')
    expect(signDownload).not.toHaveBeenCalled()
    expect(audits(prisma)).toEqual([])
    await harness.close()
    harness = await createTestApp(prismaFor(['orders.read']))
    expect((await harness.call('GET', '/reports/r1/download')).status).toBe(403)
  })
})
