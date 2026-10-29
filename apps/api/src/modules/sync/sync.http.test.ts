import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { apiDomainLabel, providerOf, workerTypeOf } from './sync.domains'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('数据域映射', () => {
  it('同步类型映射到后台任务类型', () => {
    expect(workerTypeOf('ORDERS')).toBe('FBA_ORDERS')
    expect(workerTypeOf('FINANCE')).toBe('FBA_FINANCE')
    expect(workerTypeOf('FINANCES')).toBe('FBA_FINANCE')
    expect(workerTypeOf('ADS')).toBe('FBA_ADS')
    expect(workerTypeOf('CATALOG')).toBe('CATALOG_SYNC')
    expect(workerTypeOf('UNKNOWN_DOMAIN')).toBeNull()
    expect(providerOf('ADS')).toBe('AMAZON_ADS_API')
    expect(apiDomainLabel(providerOf('ORDERS'))).toBe('Amazon SP-API')
  })
})

describe('失败任务（死信）接口', () => {
  const entry = {
    id: 'dl-1',
    tenantId: 'tenant-1',
    queue: 'sync-orders',
    jobName: 'sync',
    payloadRef: '{"tenantId":"tenant-1","syncJobId":"job-1"}',
    errorCode: 'THROTTLED',
    errorDetail: '亚马逊限流',
    attempts: 5,
    syncJobId: 'job-1',
    createdAt: new Date('2026-10-21T00:00:00Z'),
    replayedAt: null,
    replayedBy: null,
  }

  it('列表：需要 sync.read；不返回任务载荷；无权限返回 403', async () => {
    const prisma = { ...sessionStub(['sync.read']), syncJob: { findMany: vi.fn().mockResolvedValue([{ id: 'job-1' }]) } }
    harness = await createTestApp(prisma)
    harness.workflow.listDeadLetters.mockResolvedValue([entry])
    const res = await harness.call('GET', '/sync/dead-letters')
    expect(res.status).toBe(200)
    expect(res.json.data).toHaveLength(1)
    expect(res.json.data[0]).toMatchObject({ id: 'dl-1', errorCode: 'THROTTLED', syncJobId: 'job-1' })
    expect(JSON.stringify(res.json)).not.toContain('payloadRef')
    expect(harness.workflow.listDeadLetters).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ limit: 100 }))
    await harness.close()
    harness = await createTestApp({ ...sessionStub(['orders.read']) })
    expect((await harness.call('GET', '/sync/dead-letters')).status).toBe(403)
  })

  it('数据范围：受限成员只能看到范围内同步任务的失败记录，看不到不带同步任务的失败记录', async () => {
    const prisma = { ...sessionStub(['sync.read']), syncJob: { findMany: vi.fn().mockResolvedValue([{ id: 'job-1' }]) }, sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 'store-1' }]) } }
    prisma.membershipScope.findMany.mockResolvedValue([{ legalEntityId: null, sellerAccountId: 'store-1' }])
    harness = await createTestApp(prisma)
    harness.workflow.listDeadLetters.mockResolvedValue([entry, { ...entry, id: 'dl-2', syncJobId: 'job-other' }, { ...entry, id: 'dl-3', syncJobId: null, queue: 'reports' }])
    const res = await harness.call('GET', '/sync/dead-letters')
    expect(res.status).toBe(200)
    expect(res.json.data.map((item: { id: string }) => item.id)).toEqual(['dl-1'])
  })

  it('重放：同步任务沿用重试流程并返回 202；写入审计', async () => {
    const prisma = {
      ...sessionStub(['sync.manage']),
      syncJob: {
        findFirst: vi.fn().mockResolvedValue({ id: 'job-1', type: 'FBA_ORDERS', status: 'FAILED_PERMANENT', failureCode: 'THROTTLED', priority: 1, context: {} }),
        update: vi.fn().mockResolvedValue({ id: 'job-1', status: 'PENDING' }),
      },
    }
    harness = await createTestApp(prisma)
    harness.workflow.getDeadLetter.mockResolvedValue(entry)
    harness.workflow.replayDeadLetter.mockImplementation(async (_tenant: string, _id: string, _user: string, enqueue: (target: unknown) => Promise<void>) => {
      await enqueue({ queue: entry.queue, jobName: entry.jobName, jobId: 'x', payload: {} })
      return { ...entry, replayedAt: new Date(), replayedBy: 'user-1' }
    })
    const res = await harness.call('POST', '/sync/dead-letters/dl-1/replay')
    expect(res.status).toBe(202)
    expect(res.json.data).toMatchObject({ id: 'dl-1', replayedBy: 'user-1' })
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ retry: true }), expect.stringContaining('job-1-retry-'), expect.any(Object))
    expect(harness.writeGuardStubs.auditEvent.create).toHaveBeenCalled()
    expect(harness.writeGuardStubs.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'SYNC_DEAD_LETTER_REPLAYED' })
  })

  it('重放：不带同步任务的失败记录按原载荷进原队列', async () => {
    harness = await createTestApp({ ...sessionStub(['sync.manage']) })
    const reportEntry = { ...entry, id: 'dl-9', queue: 'reports', jobName: 'report-export', syncJobId: null }
    harness.workflow.getDeadLetter.mockResolvedValue(reportEntry)
    harness.workflow.replayDeadLetter.mockImplementation(async (_t: string, _i: string, _u: string, enqueue: (target: unknown) => Promise<void>) => {
      await enqueue({ queue: 'reports', jobName: 'report-export', jobId: 'dl-9-replay', payload: { tenantId: 'tenant-1' } })
      return { ...reportEntry, replayedAt: new Date(), replayedBy: 'user-1' }
    })
    const res = await harness.call('POST', '/sync/dead-letters/dl-9/replay')
    expect(res.status).toBe(202)
    expect(harness.queue.addRaw).toHaveBeenCalledWith('reports', 'report-export', { tenantId: 'tenant-1' }, 'dl-9-replay')
  })

  it('重放：已重放过返回 409；不存在返回 404；缺少 sync.manage 返回 403', async () => {
    harness = await createTestApp({ ...sessionStub(['sync.manage']), syncJob: { findFirst: vi.fn().mockResolvedValue({ id: 'job-1' }) } })
    harness.workflow.getDeadLetter.mockResolvedValue(entry)
    harness.workflow.replayDeadLetter.mockResolvedValue(null)
    const again = await harness.call('POST', '/sync/dead-letters/dl-1/replay')
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('DEAD_LETTER_ALREADY_REPLAYED')
    harness.workflow.getDeadLetter.mockResolvedValue(null)
    const missing = await harness.call('POST', '/sync/dead-letters/none/replay')
    expect(missing.status).toBe(404)
    await harness.close()
    harness = await createTestApp({ ...sessionStub(['sync.read']) })
    expect((await harness.call('POST', '/sync/dead-letters/dl-1/replay')).status).toBe(403)
  })
})

describe('同步任务接口', () => {
  function syncPrisma(permissions: string[]) {
    return {
      ...sessionStub(permissions),
      platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1' }) },
      syncJob: {
        create: vi.fn().mockResolvedValue({ id: 'job-1', type: 'FBA_ORDERS', status: 'PENDING' }),
        findFirst: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
    }
  }

  it('创建订单同步任务：返回 202、入队并带数据域信息', async () => {
    const prisma = syncPrisma(['sync.manage'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/sync/jobs', { body: { type: 'ORDERS', connectionId: 'conn-1' } })
    expect(res.status).toBe(202)
    expect(res.json.data).toMatchObject({ id: 'job-1', dataDomain: 'ORDERS', apiDomain: 'Amazon SP-API' })
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ tenantId: 'tenant-1', syncJobId: 'job-1' }), 'job-1', expect.objectContaining({ type: 'FBA_ORDERS' }))
    expect(prisma.platformConnection.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', provider: 'AMAZON_SP_API', state: 'AUTHORIZED' })
  })

  it('需要走报告任务的数据域返回 409，不入队', async () => {
    harness = await createTestApp(syncPrisma(['sync.manage']))
    const res = await harness.call('POST', '/sync/jobs', { body: { type: 'RETURNS', connectionId: 'conn-1' } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('DATA_DOMAIN_NOT_IMPLEMENTED')
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('没有授权连接时返回 404', async () => {
    const prisma = syncPrisma(['sync.manage'])
    prisma.platformConnection.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/sync/jobs', { body: { type: 'ORDERS', connectionId: 'conn-1' } })
    expect(res.status).toBe(404)
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('参数不合法返回 422 与字段错误', async () => {
    harness = await createTestApp(syncPrisma(['sync.manage']))
    const res = await harness.call('POST', '/sync/jobs', { body: { type: 'NOPE' } })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('VALIDATION_FAILED')
    expect(res.json.error.fieldErrors).toBeTruthy()
  })

  it('重试：已有亚马逊报告编号的任务只轮询，不重复创建', async () => {
    const prisma = syncPrisma(['sync.manage'])
    prisma.syncJob.findFirst.mockResolvedValue({
      id: 'job-9',
      type: 'FBA_REPORT_CREATE',
      status: 'FAILED_PERMANENT',
      failureCode: 'FBA_REPORT_FAILED',
      attempts: 5,
      timelineJson: null,
      context: { reportJobId: 'rep-1', reportType: 'X', marketplaceId: 'ATVPDKIKX0DER' },
    })
    prisma.syncJob.update.mockResolvedValue({ id: 'job-9', status: 'PENDING' })
    const withReport = { ...prisma, fbaReportJob: { findFirst: vi.fn().mockResolvedValue({ externalReportId: 'amz-1' }) } }
    harness = await createTestApp(withReport)
    const res = await harness.call('POST', '/sync/jobs/job-9/retry')
    expect(res.status).toBe(202)
    expect(harness.queue.add).toHaveBeenCalledWith(
      'sync',
      expect.objectContaining({ tenantId: 'tenant-1', retry: true, poll: true, reportJobId: 'rep-1' }),
      expect.stringContaining('job-9-retry-'),
      expect.objectContaining({ type: 'FBA_REPORT_CREATE' }),
    )
  })

  it('重试：尝试次数清零，时间线记一条“已人工重试”', async () => {
    const prisma = syncPrisma(['sync.manage'])
    prisma.syncJob.findFirst.mockResolvedValue({
      id: 'job-2',
      type: 'FBA_ORDERS',
      status: 'FAILED_PERMANENT',
      failureCode: 'THROTTLED',
      attempts: 5,
      priority: 1,
      timelineJson: [{ at: '2026-10-25T00:00:00.000Z', stage: 'FAILED', text: 'THROTTLED' }],
      context: {},
    })
    prisma.syncJob.update.mockResolvedValue({ id: 'job-2', status: 'PENDING' })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/sync/jobs/job-2/retry')).status).toBe(202)
    const data = prisma.syncJob.update.mock.calls[0][0].data
    expect(data).toMatchObject({ status: 'PENDING', failureCode: null, attempts: 0, deadLettered: false })
    expect(data.timelineJson.map((event: { stage: string }) => event.stage)).toEqual(['FAILED', 'RETRY_REQUESTED'])
  })

  it('重试：排队、运行、等待中的任务与已作废的任务返回 409，不入队', async () => {
    const prisma = syncPrisma(['sync.manage'])
    harness = await createTestApp(prisma)
    const blocked: Array<[Record<string, unknown>, string]> = [
      [{ status: 'PENDING', attempts: 0, failureCode: null }, '只有失败的任务可以重试'],
      [{ status: 'RUNNING', attempts: 1, failureCode: null }, '只有失败的任务可以重试'],
      [{ status: 'PENDING', attempts: 1, failureCode: 'THROTTLED' }, '只有失败的任务可以重试'],
      [{ status: 'FAILED_PERMANENT', attempts: 1, failureCode: 'CONNECTION_DISCONNECTED' }, '连接已断开'],
      [{ status: 'FAILED_PERMANENT', attempts: 1, failureCode: 'REPORT_CANCELLED' }, '已在报表中心取消'],
    ]
    for (const [job, hint] of blocked) {
      prisma.syncJob.findFirst.mockResolvedValue({ id: 'job-3', type: 'FBA_ORDERS', priority: 1, context: {}, ...job })
      const res = await harness.call('POST', '/sync/jobs/job-3/retry')
      expect(res.status).toBe(409)
      expect(res.json.error.code).toBe('SYNC_JOB_NOT_RETRYABLE')
      expect(res.json.error.message).toContain(hint)
    }
    expect(prisma.syncJob.update).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('重试不存在或不属于当前租户的任务返回 404', async () => {
    const prisma = syncPrisma(['sync.manage'])
    prisma.syncJob.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/sync/jobs/nope/retry')
    expect(res.status).toBe(404)
    expect(prisma.syncJob.findFirst.mock.calls[0][0].where).toEqual({ id: 'nope', tenantId: 'tenant-1', connection: {} })
  })

  it('数据范围：受限成员只能对范围内店铺的连接发起同步；店铺外连接与账户级连接均为 403，且不入队', async () => {
    const prisma = syncPrisma(['sync.manage'])
    prisma.membershipScope.findMany.mockResolvedValue([{ legalEntityId: null, sellerAccountId: 'store-1' }])
    ;(prisma as any).sellerAccount = { findMany: vi.fn().mockResolvedValue([{ id: 'store-1' }]) }
    harness = await createTestApp(prisma)
    prisma.platformConnection.findFirst.mockResolvedValue({ id: 'conn-2', sellerAccountId: 'store-2' })
    const other = await harness.call('POST', '/sync/jobs', { body: { type: 'ORDERS', connectionId: 'conn-2' } })
    expect(other.status).toBe(403)
    expect(other.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
    prisma.platformConnection.findFirst.mockResolvedValue({ id: 'conn-ads', sellerAccountId: null })
    const tenantLevel = await harness.call('POST', '/sync/jobs', { body: { type: 'ADS', connectionId: 'conn-ads' } })
    expect(tenantLevel.status).toBe(403)
    expect(tenantLevel.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    expect(harness.queue.add).not.toHaveBeenCalled()
    prisma.platformConnection.findFirst.mockResolvedValue({ id: 'conn-1', sellerAccountId: 'store-1' })
    expect((await harness.call('POST', '/sync/jobs', { body: { type: 'ORDERS', connectionId: 'conn-1' } })).status).toBe(202)
  })
})
