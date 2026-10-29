import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const channel = {
  sellerAccountId: 'store-1',
  domain: 'ORDERS',
  legacyEnabled: true,
  consecutivePasses: 3,
  requiredPasses: 7,
  lastRunAt: new Date('2026-10-21T00:00:00Z'),
  closedAt: null,
  closedReason: null,
  sellerAccount: { displayName: '主店铺' },
}
const run = {
  id: 'run-1',
  tenantId: 'tenant-1',
  sellerAccountId: 'store-1',
  domain: 'ORDERS',
  windowStart: new Date('2026-10-14T00:00:00Z'),
  windowEnd: new Date('2026-10-21T00:00:00Z'),
  legacyCount: 10,
  newCount: 11,
  matchedCount: 9,
  unexplainedCount: 0,
  status: 'PASSED',
  syncJobId: 'job-internal',
  startedAt: new Date('2026-10-21T00:00:00Z'),
  finishedAt: new Date('2026-10-21T00:01:00Z'),
}
const diff = {
  id: 'diff-1',
  tenantId: 'tenant-1',
  runId: 'run-1',
  category: 'SCOPE',
  entityKey: '902-1845936-5435065',
  field: 'presence',
  legacyValue: '无',
  newValue: '有',
  explanation: '发票待确认',
  createdAt: new Date(),
}

function prismaWith(permissions: string[]) {
  return {
    ...sessionStub(permissions),
    connectorChannelState: { findMany: vi.fn().mockResolvedValue([channel]) },
    connectorParityRun: { findMany: vi.fn().mockResolvedValue([run]), findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    connectorParityDiff: { findMany: vi.fn().mockResolvedValue([diff]), groupBy: vi.fn().mockResolvedValue([{ category: 'SCOPE', _count: { _all: 1 } }]) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 'store-1' }]) },
  }
}

describe('新旧接口并行核对报告', () => {
  it('列表：返回通道状态与最近核对记录；需要 sync.read；不返回内部任务编号', async () => {
    const prisma = prismaWith(['sync.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/sync/parity')
    expect(res.status).toBe(200)
    expect(res.json.data.channels[0]).toMatchObject({ sellerAccountId: 'store-1', storeName: '主店铺', domain: 'ORDERS', legacyEnabled: true, consecutivePasses: 3, requiredPasses: 7 })
    expect(res.json.data.runs[0]).toMatchObject({ id: 'run-1', status: 'PASSED', legacyCount: 10, newCount: 11, matchedCount: 9, unexplainedCount: 0 })
    expect(JSON.stringify(res.json)).not.toContain('job-internal')
    expect(res.json.data.diffs).toBeUndefined()
    expect(prisma.connectorChannelState.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1' })
    await harness.close()
    harness = await createTestApp(sessionStub(['orders.read']))
    expect((await harness.call('GET', '/sync/parity')).status).toBe(403)
  })

  it('指定核对记录：返回差异明细与各类计数', async () => {
    const prisma = prismaWith(['sync.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/sync/parity?domain=ORDERS&runId=run-1')
    expect(res.status).toBe(200)
    expect(res.json.data.diffs).toEqual([{ category: 'SCOPE', entityKey: '902-1845936-5435065', field: 'presence', legacyValue: '无', newValue: '有', explanation: '发票待确认' }])
    expect(res.json.data.diffCounts).toEqual({ TIME_BASIS: 0, ATTRIBUTION_BASIS: 0, SCOPE: 1, UNEXPLAINED: 0 })
    expect(res.json.data.diffsTruncated).toBe(false)
    expect(prisma.connectorParityRun.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'run-1', domain: 'ORDERS', tenantId: 'tenant-1' })
  })

  it('筛选类别：只返回该类差异；类别、数据域取值不合法返回 422', async () => {
    const prisma = prismaWith(['sync.read'])
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/sync/parity?runId=run-1&category=UNEXPLAINED')).status).toBe(200)
    expect(prisma.connectorParityDiff.findMany.mock.calls[0][0].where).toMatchObject({ runId: 'run-1', category: 'UNEXPLAINED' })
    expect((await harness.call('GET', '/sync/parity?category=OTHER')).status).toBe(422)
    expect((await harness.call('GET', '/sync/parity?domain=ADS')).status).toBe(422)
  })

  it('核对记录不存在或不在数据范围内：404', async () => {
    const prisma = prismaWith(['sync.read'])
    prisma.connectorParityRun.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/sync/parity?runId=run-x')).status).toBe(404)
  })

  it('数据范围：受限成员的查询条件限定在范围内店铺', async () => {
    const prisma = prismaWith(['sync.read'])
    prisma.membershipScope.findMany.mockResolvedValue([{ legalEntityId: null, sellerAccountId: 'store-1' }])
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/sync/parity')).status).toBe(200)
    expect(prisma.connectorChannelState.findMany.mock.calls[0][0].where.sellerAccountId).toEqual({ in: ['store-1'] })
    expect(prisma.connectorParityRun.findMany.mock.calls[0][0].where.sellerAccountId).toEqual({ in: ['store-1'] })
  })
})
