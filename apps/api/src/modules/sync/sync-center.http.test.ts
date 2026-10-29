import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 同步中心（P5-06）的接口：任务列表、详情、队列监控、限速状态。数据库层面的范围与租户隔离见 testing/sync-center.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const at = (iso: string) => new Date(iso)
const job = (patch: Record<string, unknown> = {}) => ({
  id: 'job-1',
  type: 'FBA_ORDERS',
  status: 'FAILED_PERMANENT',
  attempts: 5,
  priority: 3,
  progressCurrent: 0,
  progressTotal: 1,
  requestId: 'req-1',
  failureCode: 'AUTH_EXPIRED',
  deadLettered: true,
  createdAt: at('2026-10-25T01:00:00Z'),
  startedAt: at('2026-10-25T01:00:05Z'),
  finishedAt: at('2026-10-25T01:01:00Z'),
  context: {},
  timelineJson: [
    { at: '2026-10-25T01:00:05.000Z', stage: 'STARTED', text: '第 5 次尝试' },
    { at: '2026-10-25T01:01:00.000Z', stage: 'FAILED', text: 'AUTH_EXPIRED' },
  ],
  connection: { provider: 'AMAZON_SP_API', sellerAccount: { displayName: '美国店' } },
  ...patch,
})

function listPrisma(rows: unknown[], total = rows.length, summary: unknown[] = rows) {
  return {
    ...sessionStub(['sync.read']),
    syncJob: {
      count: vi.fn().mockResolvedValue(total),
      findMany: vi.fn(async (args: { take?: number; where?: unknown }) => (args.take === 5001 ? summary : rows)),
    },
  }
}

describe('GET /sync/jobs 任务列表', () => {
  it('需要 sync.read（403）；未知参数与非法筛选值返回 422', async () => {
    harness = await createTestApp({ ...sessionStub(['orders.read']) })
    expect((await harness.call('GET', '/sync/jobs')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(listPrisma([]))
    expect((await harness.call('GET', '/sync/jobs?foo=1')).status).toBe(422)
    expect((await harness.call('GET', '/sync/jobs?domain=NOPE')).status).toBe(422)
    expect((await harness.call('GET', '/sync/jobs?state=NOPE')).status).toBe(422)
  })

  it('行：状态、数据域、失败原因（中文）、日志摘要、能否重试；概况里 19 个数据域齐全', async () => {
    const waiting = job({
      id: 'job-2',
      type: 'FBA_REPORT_POLL',
      status: 'PENDING',
      attempts: 1,
      failureCode: null,
      deadLettered: false,
      finishedAt: null,
      context: { reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT' },
    })
    const prisma = listPrisma([job(), waiting])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/sync/jobs')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    const [failed, polling] = data.items
    expect(failed).toMatchObject({
      id: 'job-1',
      state: 'FAILED',
      domain: 'ORDERS',
      domainLabel: '订单',
      apiLabel: 'Amazon SP-API',
      storeName: '美国店',
      maxAttempts: 5,
      failureCode: 'AUTH_EXPIRED',
      canRetry: true,
      retryBlockedReason: null,
      writeType: false,
    })
    expect(failed.failureText).toMatch(/授权/)
    expect(failed.logSummary).toMatch(/^任务失败：/)
    expect(failed.logSummary).not.toContain('AUTH_EXPIRED')
    expect(polling).toMatchObject({ state: 'POLL_WAIT', domain: 'ACCOUNT_HEALTH', canRetry: false })
    expect(polling.retryBlockedReason).toMatch(/只有失败的任务/)
    expect(data.domains).toHaveLength(19)
    expect(data.domains.find((item: { domain: string }) => item.domain === 'ADS_STREAM')).toMatchObject({ availability: 'NOT_CONNECTED', hasJobs: false, lastSuccessAt: null })
    expect(data.domains.find((item: { domain: string }) => item.domain === 'ORDERS')).toMatchObject({ hasJobs: true, failed: 1, succeeded: 0 })
    expect(data.domains.find((item: { domain: string }) => item.domain === 'ACCOUNT_HEALTH')).toMatchObject({ hasJobs: true, active: 1 })
    expect(Object.keys(data.counts).sort()).toEqual(['FAILED', 'POLL_WAIT', 'QUEUED', 'RETRY_WAIT', 'RUNNING', 'SUCCEEDED'])
    const where = prisma.syncJob.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 'tenant-1', connection: {} })
  })

  it('筛选：数据域、状态、搜索词都进入数据库查询；各状态条数不带状态筛选', async () => {
    const prisma = listPrisma([])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/sync/jobs?domain=ORDERS&state=FAILED&q=订单')
    expect(res.status).toBe(200)
    const rowsWhere = JSON.stringify(prisma.syncJob.findMany.mock.calls[0][0].where)
    expect(rowsWhere).toContain('FBA_ORDERS')
    expect(rowsWhere).toContain('"notIn":["PENDING","RUNNING","SUCCEEDED"]') // 状态“失败”的条件
    expect(rowsWhere).toContain('订单')
    // 6 次各状态条数 + 1 次总数：各状态条数只带自己的状态条件，不带当前选中的“失败”筛选；只有“失败”那一次和总数里出现失败条件
    const countWheres = prisma.syncJob.count.mock.calls.map(call => JSON.stringify(call[0].where))
    expect(countWheres).toHaveLength(7)
    expect(countWheres.filter(where => where.includes('"notIn"'))).toHaveLength(2)
    expect(countWheres.every(where => where.includes('FBA_ORDERS'))).toBe(true)
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', note: '没有符合筛选条件的同步任务；可以放宽筛选条件' })
  })

  it('没有任何任务时写“尚无记录”', async () => {
    harness = await createTestApp(listPrisma([]))
    const res = await harness.call('GET', '/sync/jobs')
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(res.json.data.note).toContain('尚无记录')
    expect(res.json.data.domains.every((item: { hasJobs: boolean }) => item.hasJobs === false)).toBe(true)
  })

  it('翻页：游标带位置并绑定查询条件，条件变化后失效（400）', async () => {
    const prisma = listPrisma([job()], 2)
    harness = await createTestApp(prisma)
    const first = await harness.call('GET', '/sync/jobs?pageSize=1')
    expect(first.json.data.pageInfo).toMatchObject({ pageSize: 1, hasMore: true, approxTotal: 2 })
    const cursor = first.json.data.pageInfo.nextCursor as string
    expect(cursor).toBeTruthy()
    const second = await harness.call('GET', `/sync/jobs?pageSize=1&cursor=${encodeURIComponent(cursor)}`)
    expect(second.status).toBe(200)
    expect(prisma.syncJob.findMany.mock.calls.at(-2)![0]).toMatchObject({ skip: 1, take: 1 })
    expect(second.json.data.pageInfo.hasMore).toBe(false)
    const changed = await harness.call('GET', `/sync/jobs?pageSize=1&domain=ORDERS&cursor=${encodeURIComponent(cursor)}`)
    expect(changed.status).toBe(400)
    expect(changed.json.error.code).toBe('CURSOR_INVALID')
  })
})

describe('GET /sync/jobs/:id 任务详情', () => {
  function detailPrisma(found: unknown, extra: Record<string, unknown> = {}) {
    return {
      ...sessionStub(['sync.read']),
      syncJob: { findFirst: vi.fn().mockResolvedValue(found) },
      platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', provider: 'AMAZON_SP_API', state: 'AUTHORIZED', lastErrorCode: null }) },
      workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
      deadLetterJob: { findFirst: vi.fn().mockResolvedValue(null) },
      fbaReportJob: { findFirst: vi.fn().mockResolvedValue(null) },
      adsReportJob: { findFirst: vi.fn().mockResolvedValue(null) },
      ...extra,
    }
  }
  const full = (patch: Record<string, unknown> = {}) =>
    job({ sourceKey: 'conn-1:FBA_ORDERS', checkpointJson: { cursor: 'x' }, resultJson: { imported: 12, skipped: 3 }, connectionId: 'conn-1', ...patch })

  it('不存在或不在范围内返回 404；查询条件带租户与范围', async () => {
    const prisma = detailPrisma(null)
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/sync/jobs/nope')
    expect(res.status).toBe(404)
    expect(prisma.syncJob.findFirst.mock.calls[0][0].where).toEqual({ id: 'nope', tenantId: 'tenant-1', connection: {} })
    await harness.close()
    harness = await createTestApp({ ...sessionStub(['orders.read']) })
    expect((await harness.call('GET', '/sync/jobs/job-1')).status).toBe(403)
  })

  it('详情：参数、时间线、写入统计、死信、分步', async () => {
    const prisma = detailPrisma(full({ context: { marketplaceId: 'ATVPDKIKX0DER', window: { after: '2026-10-01T00:00:00Z', before: '2026-10-02T00:00:00Z' }, secretToken: 'must-not-leak' } }), {
      deadLetterJob: { findFirst: vi.fn().mockResolvedValue({ id: 'dl-1', queue: 'sync-orders', attempts: 5, errorCode: 'AUTH_EXPIRED', createdAt: at('2026-10-25T01:01:00Z'), replayedAt: null }) },
      workflowRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            kind: 'ORDER_SYNC',
            status: 'FAILED',
            errorCode: 'AUTH_EXPIRED',
            startedAt: at('2026-10-25T01:00:06Z'),
            finishedAt: at('2026-10-25T01:01:00Z'),
            steps: [{ seq: 1, name: 'fetch', status: 'FAILED', attempt: 1, errorCode: 'AUTH_EXPIRED', startedAt: at('2026-10-25T01:00:07Z'), finishedAt: null }],
          },
        ]),
      },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/sync/jobs/job-1')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.job).toMatchObject({ id: 'job-1', state: 'FAILED', domain: 'ORDERS' })
    expect(data.queue).toBe('sync-orders')
    expect(data.sourceKey).toBe('conn-1:FBA_ORDERS')
    expect(data.hasCheckpoint).toBe(true)
    expect(data.stats).toEqual([
      { key: 'imported', label: '导入行数', value: 12 },
      { key: 'skipped', label: '跳过行数', value: 3 },
    ])
    expect(data.timeline.map((item: { label: string }) => item.label)).toEqual(['开始执行', '任务失败'])
    expect(data.timeline[1]).toMatchObject({ tone: 'error' })
    expect(data.timeline[1].text).not.toContain('AUTH_EXPIRED')
    expect(data.params).toEqual(
      expect.arrayContaining([
        { label: '站点', value: 'ATVPDKIKX0DER' },
        { label: '时间窗口', value: '2026-10-01 至 2026-10-02' },
      ]),
    )
    expect(JSON.stringify(data)).not.toContain('must-not-leak')
    expect(data.deadLetter).toMatchObject({ id: 'dl-1', queue: 'sync-orders', errorCode: 'AUTH_EXPIRED' })
    expect(data.workflows[0]).toMatchObject({ kind: 'ORDER_SYNC', steps: [{ seq: 1, name: 'fetch', errorCode: 'AUTH_EXPIRED', finishedAt: null }] })
    expect(data.reports).toEqual([])
    expect(data.notes).toEqual([])
  })

  it('没有统计、没有过程记录的旧任务如实说明，不写 0；报告任务带出关联的亚马逊报告', async () => {
    const prisma = detailPrisma(
      full({
        type: 'FBA_REPORT_CREATE',
        status: 'SUCCEEDED',
        failureCode: null,
        deadLettered: false,
        resultJson: null,
        timelineJson: null,
        context: { reportJobId: 'rep-1', reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL' },
      }),
      { fbaReportJob: { findFirst: vi.fn().mockResolvedValue({ id: 'rep-1', reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', status: 'READY' }) } },
    )
    harness = await createTestApp(prisma)
    const data = (await harness.call('GET', '/sync/jobs/job-1')).json.data
    expect(data.stats).toBeNull()
    expect(data.timeline).toEqual([])
    expect(data.notes.join('')).toContain('没有过程记录')
    expect(data.notes.join('')).toContain('没有记录写入统计')
    expect(data.reports).toMatchObject([{ id: 'rep-1', kind: 'SP_API', status: 'READY', path: '/app/reports/rep-1' }])
  })

  it('写入类任务提醒重试会重新提交一次写入；数据中心查询的任务本身就是报表中心的一行', async () => {
    harness = await createTestApp(detailPrisma(full({ type: 'LISTING_WRITE' })))
    expect((await harness.call('GET', '/sync/jobs/job-1')).json.data.notes.join('')).toContain('重新提交一次写入')
    await harness.close()
    harness = await createTestApp(detailPrisma(full({ type: 'DATA_KIOSK_QUERY', context: { dataset: 'x' } })))
    const data = (await harness.call('GET', '/sync/jobs/job-1')).json.data
    expect(data.reports).toMatchObject([{ id: 'job-1', kind: 'DATA_KIOSK', path: '/app/reports/job-1' }])
  })
})

describe('GET /sync/queues 队列监控', () => {
  const queuePrisma = (groups: unknown[] = []) => ({ ...sessionStub(['sync.read']), syncJob: { groupBy: vi.fn().mockResolvedValue(groups) } })

  it('积压来自队列，本企业的占用来自同步任务记录；不适用的队列没有本企业数据', async () => {
    const prisma = queuePrisma()
    prisma.syncJob.groupBy.mockResolvedValueOnce([
      { type: 'FBA_ORDERS', status: 'PENDING', _count: { _all: 3 } },
      { type: 'FBA_ORDERS', status: 'RUNNING', _count: { _all: 1 } },
    ])
    prisma.syncJob.groupBy.mockResolvedValueOnce([
      { type: 'FBA_ORDERS', status: 'SUCCEEDED', _count: { _all: 20 } },
      { type: 'FBA_ORDERS', status: 'FAILED_PERMANENT', _count: { _all: 2 } },
    ])
    harness = await createTestApp(prisma)
    harness.queue.counts.mockResolvedValue({ 'sync-orders': { waiting: 6, active: 2, delayed: 1, failed: 4 } })
    harness.rateLimit.tenantSlots.mockResolvedValue(2)
    const res = await harness.call('GET', '/sync/queues')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    const orders = data.queues.find((item: { queue: string }) => item.queue === 'sync-orders')
    expect(orders).toMatchObject({ label: '订单同步', waiting: 6, active: 2, delayed: 1, failed: 4, tenant: { waiting: 3, active: 1, completedLastHour: 20, failedLastHour: 2 }, tenantShare: 0.5 })
    expect(data.queues.find((item: { queue: string }) => item.queue === 'sync-inventory')).toMatchObject({ waiting: 0, tenant: { waiting: 0, active: 0 }, tenantShare: null })
    expect(data.queues.find((item: { queue: string }) => item.queue === 'exports')).toMatchObject({ tenant: null, tenantShare: null })
    expect(data.concurrency).toEqual({ active: 2, limit: 2 })
    expect(data.notes.join('')).toContain('整个平台')
  })

  it('队列读不到时如实返回 UNAVAILABLE，不拿 0 冒充；缺少 sync.read 返回 403', async () => {
    harness = await createTestApp(queuePrisma())
    harness.queue.counts.mockRejectedValue(new Error('redis down'))
    const res = await harness.call('GET', '/sync/queues')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'UNAVAILABLE', queues: [], concurrency: null })
    expect(res.json.data.note).toContain('暂时读不到')
    await harness.close()
    harness = await createTestApp({ ...sessionStub(['orders.read']) })
    expect((await harness.call('GET', '/sync/queues')).status).toBe(403)
  })
})

describe('GET /sync/rate-limits 限速状态', () => {
  const NOW = Date.now()
  const bucket = (patch: Record<string, unknown> = {}) => ({
    connectionId: 'conn-1',
    family: 'orders',
    tokens: 0,
    updatedAt: NOW - 4000,
    rate: 0.5,
    burst: 2,
    blockedUntil: 0,
    limitedAt: null,
    ...patch,
  })
  const ratePrisma = (connections: unknown[]) => ({ ...sessionStub(['sync.read']), platformConnection: { findMany: vi.fn().mockResolvedValue(connections) } })

  it('每个店铺、每个接口族一行：令牌按速率折算到现在，冻结与最近限速时间如实给出', async () => {
    const prisma = ratePrisma([{ id: 'conn-1', provider: 'AMAZON_SP_API', sellerAccount: { displayName: '美国店' } }])
    harness = await createTestApp(prisma)
    harness.rateLimit.buckets.mockResolvedValue({
      items: [bucket(), bucket({ family: 'finance', tokens: 2, blockedUntil: NOW + 30_000, limitedAt: NOW - 60_000 }), bucket({ connectionId: 'conn-other' })],
      truncated: false,
    })
    const res = await harness.call('GET', '/sync/rate-limits')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    expect(data.items).toHaveLength(2) // 其他店铺（不在范围内或已删除）的桶不显示
    const orders = data.items.find((item: { family: string }) => item.family === 'orders')
    expect(orders).toMatchObject({ storeName: '美国店', apiLabel: 'Amazon SP-API', ratePerSecond: 0.5, burst: 2, blocked: false, blockedUntil: null, lastLimitedAt: null })
    expect(orders.tokens).toBeGreaterThan(1.9) // 4 秒 × 0.5/秒 = 2 个令牌
    const finance = data.items.find((item: { family: string }) => item.family === 'finance')
    expect(finance).toMatchObject({ blocked: true, tokens: 2 })
    expect(finance.blockedUntil).toBeTruthy()
    expect(finance.lastLimitedAt).toBeTruthy()
    expect(harness.rateLimit.buckets).toHaveBeenCalledWith('tenant-1', 200)
    expect(prisma.platformConnection.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', id: { in: ['conn-1', 'conn-other'] } })
  })

  it('没有令牌桶写“尚无记录”；缓存读不到返回 UNAVAILABLE', async () => {
    harness = await createTestApp(ratePrisma([]))
    const none = await harness.call('GET', '/sync/rate-limits')
    expect(none.json.data).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(none.json.data.note).toContain('尚无记录')
    harness.rateLimit.buckets.mockRejectedValue(new Error('redis down'))
    const down = await harness.call('GET', '/sync/rate-limits')
    expect(down.json.data).toMatchObject({ state: 'UNAVAILABLE', items: [] })
    await harness.close()
    harness = await createTestApp({ ...sessionStub(['orders.read']) })
    expect((await harness.call('GET', '/sync/rate-limits')).status).toBe(403)
  })
})
