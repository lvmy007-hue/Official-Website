import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TYPES } from '@nova/api-contracts'
import { createTestApp, sessionStub } from '../../testing/harness'

// 消息推送订阅页（P5-05，09 章 9.7）：权限先于参数校验、接收端未配置的正式状态、店铺授权前置、只读内容不泄露接收端全貌。
// 数据范围收窄与订阅写入的真实行为由真实库测试 subscription-center.db.test.ts 覆盖。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
const ENV_KEY = 'AMAZON_NOTIFICATION_DESTINATION_ID'
beforeEach(() => {
  delete process.env[ENV_KEY]
})
afterEach(async () => {
  delete process.env[ENV_KEY]
  await harness?.close()
  harness = undefined
})

const STORES = [
  { id: 's1', displayName: '主店' },
  { id: 's2', displayName: '二店' },
]
const reads = (over: Record<string, unknown> = {}) => ({
  sellerAccount: { findMany: vi.fn().mockResolvedValue(STORES), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
  notificationSubscription: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  amazonNotificationEvent: { groupBy: vi.fn().mockResolvedValue([]) },
  platformConnection: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1' }]), findFirst: vi.fn().mockResolvedValue(null) },
  ...over,
})
const item = (data: { items: { sellerAccountId: string; notificationType: string; state: string }[] }, store: string, type: string) =>
  data.items.find(entry => entry.sellerAccountId === store && entry.notificationType === type)

describe('订阅列表', () => {
  it('没有配置接收端：每个店铺每种类型一行，全部“接收端未接入”，给出所需配置与受影响的页面，不假装有数据', async () => {
    const prisma = reads()
    harness = await createTestApp({ ...sessionStub(['connection.read']), ...prisma })
    const res = await harness.call('GET', '/notifications/subscriptions')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data
    expect(data.destination).toMatchObject({ configured: false, hint: null, envKey: ENV_KEY })
    expect(data.destination.setupSteps.length).toBeGreaterThanOrEqual(3)
    expect(data.items).toHaveLength(STORES.length * NOTIFICATION_TYPES.length)
    expect(data.items.every((entry: { state: string }) => entry.state === 'DESTINATION_MISSING')).toBe(true)
    expect(data.affectedPages.map((entry: { page: string }) => entry.page)).toEqual(expect.arrayContaining(['今日实时', '库存健康', '今日广告']))
    expect(data.canManage).toBe(false)
    expect(data.summary).toEqual({ rows: 0, active: 0, pending: 0, invalid: 0, events24h: 0, failures24h: 0 })
    expect(prisma.sellerAccount.findMany.mock.calls[0]?.[0].where).toMatchObject({ tenantId: 'tenant-1' })
  })

  it('配置了接收端：未授权的店铺显示“店铺未授权”，已授权的显示“未订阅”；只读成员的动作全部禁用；不再列受影响页面', async () => {
    process.env[ENV_KEY] = 'arn:aws:sqs:us-east-1:123456789012:nova-notifications'
    harness = await createTestApp({ ...sessionStub(['connection.read']), ...reads() })
    const data = (await harness.call('GET', '/notifications/subscriptions')).json.data
    expect(data.destination).toMatchObject({ configured: true, hint: '****ions' })
    expect(JSON.stringify(data)).not.toContain('123456789012')
    expect(data.affectedPages).toEqual([])
    expect(item(data, 's1', 'ORDER_CHANGE')?.state).toBe('NOT_SUBSCRIBED')
    expect(item(data, 's2', 'ORDER_CHANGE')?.state).toBe('STORE_NOT_AUTHORIZED')
    expect(item(data, 's2', 'SHIPMENT_TRACKING_MILESTONE_CHANGED')?.state).toBe('NOT_SUBSCRIBED') // 免授权类型
    expect(data.items.every((entry: { actions: Record<string, { allowed: boolean }> }) => Object.values(entry.actions).every(action => !action.allowed))).toBe(true)
  })

  it('没有“连接”读取权限返回 403', async () => {
    harness = await createTestApp({ ...sessionStub(['x.nothing']), ...reads() })
    expect((await harness.call('GET', '/notifications/subscriptions')).status).toBe(403)
  })

  it('已有订阅记录与近 24 小时事件：事件数与失败数现算，记录上的缓存列不参与', async () => {
    process.env[ENV_KEY] = 'dest-0001'
    const prisma = reads({
      notificationSubscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'sub1',
            sellerAccountId: 's1',
            destinationId: 'dest-0001',
            notificationType: 'ORDER_CHANGE',
            status: 'ACTIVE',
            filterJson: null,
            lastReceivedAt: new Date('2026-10-25T01:00:00Z'),
            version: 3,
          },
        ]),
        findFirst: vi.fn(),
      },
      amazonNotificationEvent: {
        groupBy: vi.fn().mockResolvedValue([
          { sellerAccountId: 's1', notificationType: 'ORDER_CHANGE', status: 'PROCESSED', _count: { _all: 40 } },
          { sellerAccountId: 's1', notificationType: 'ORDER_CHANGE', status: 'FAILED', _count: { _all: 2 } },
        ]),
      },
    })
    harness = await createTestApp({ ...sessionStub(['connection.read', 'notifications.manage']), ...prisma })
    const data = (await harness.call('GET', '/notifications/subscriptions')).json.data
    const row = item(data, 's1', 'ORDER_CHANGE') as unknown as {
      id: string
      state: string
      events24h: number
      failures24h: number
      version: number
      destinationHint: string
      lastReceivedAt: string
      actions: Record<string, { allowed: boolean }>
    }
    expect(row).toMatchObject({ id: 'sub1', state: 'ACTIVE', events24h: 42, failures24h: 2, version: 3, destinationHint: '****0001', lastReceivedAt: '2026-10-25T01:00:00.000Z' })
    expect(row.actions.unsubscribe.allowed).toBe(true)
    expect(row.actions.replay.allowed).toBe(true)
    expect(data.canManage).toBe(true)
    expect(data.summary).toMatchObject({ rows: 1, active: 1, events24h: 42, failures24h: 2 })
    const groupBy = prisma.amazonNotificationEvent.groupBy.mock.calls[0][0]
    expect(groupBy.where.tenantId).toBe('tenant-1')
    expect(groupBy.where.receivedAt.gte).toBeInstanceOf(Date)
  })
})

describe('订阅写入的权限与前置条件', () => {
  it('只有读取权限：订阅、改过滤条件、取消、重放一律 403，且先于参数校验', async () => {
    harness = await createTestApp({ ...sessionStub(['connection.read']), ...reads() })
    expect((await harness.call('POST', '/notifications/subscriptions', { body: {} })).status).toBe(403)
    expect((await harness.call('PATCH', '/notifications/subscriptions/sub1', { body: {} })).status).toBe(403)
    expect((await harness.call('DELETE', '/notifications/subscriptions/sub1')).status).toBe(403)
    expect((await harness.call('POST', '/notifications/subscriptions/sub1/replay', { body: {} })).status).toBe(403)
  })

  it('接收端没配置：订阅返回 503 且不写任何记录、不排任务', async () => {
    const create = vi.fn()
    harness = await createTestApp({ ...sessionStub(['notifications.manage']), ...reads({ notificationSubscription: { findMany: vi.fn(), findFirst: vi.fn(), create } }) })
    const res = await harness.call('POST', '/notifications/subscriptions', { body: { sellerAccountId: 's1', notificationType: 'ORDER_CHANGE' } })
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('DEPENDENCY_UNAVAILABLE')
    expect(create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('店铺没有有效的卖家授权：订阅返回 409，不写记录', async () => {
    process.env[ENV_KEY] = 'dest-0001'
    const create = vi.fn()
    const noConnection = reads({ notificationSubscription: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null), create } })
    harness = await createTestApp({ ...sessionStub(['notifications.manage']), ...noConnection })
    const res = await harness.call('POST', '/notifications/subscriptions', { body: { sellerAccountId: 's1', notificationType: 'ORDER_CHANGE' } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('FBA_CONNECTION_REQUIRED')
    expect(create).not.toHaveBeenCalled()
    expect(noConnection.platformConnection.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', state: 'AUTHORIZED' })
  })

  it('改过滤条件时接收端没配置：503，不改记录', async () => {
    const update = vi.fn()
    const row = { id: 'sub1', tenantId: 'tenant-1', sellerAccountId: 's1', notificationType: 'ANY_OFFER_CHANGED', filterJson: null }
    harness = await createTestApp({
      ...sessionStub(['notifications.manage']),
      ...reads({ notificationSubscription: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(row), updateMany: update } }),
    })
    const res = await harness.call('PATCH', '/notifications/subscriptions/sub1', { body: { version: 1, filter: { aggregationTimePeriod: 'FiveMinutes' } } })
    expect(res.status).toBe(503)
    expect(update).not.toHaveBeenCalled()
  })

  it('订阅不存在或在数据范围外：取消与重放都是 404', async () => {
    harness = await createTestApp({ ...sessionStub(['notifications.manage']), ...reads() })
    expect((await harness.call('DELETE', '/notifications/subscriptions/nope')).status).toBe(404)
    expect((await harness.call('POST', '/notifications/subscriptions/nope/replay', { body: { allFailed: true } })).status).toBe(404)
  })
})
