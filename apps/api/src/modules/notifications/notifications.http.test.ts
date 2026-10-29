import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const row = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  kind: 'WORK_ASSIGNED',
  title: '你有一条新待办',
  body: '库存数据已落后',
  link: '/my/work-items',
  severity: 'INFO',
  readAt: null,
  createdAt: new Date(),
  ...over,
})

function prismaFor(over: Record<string, any> = {}) {
  return {
    ...sessionStub([]),
    notification: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    alertInstance: { count: vi.fn().mockResolvedValue(0) },
    ...over,
  }
}

describe('消息中心接口', () => {
  it('登录成员即可查看：只查本人的通知，返回未读数与已读状态', async () => {
    const prisma = prismaFor()
    prisma.notification.findMany.mockResolvedValue([row(), row({ id: 'n2', readAt: new Date() })])
    prisma.notification.count.mockResolvedValue(1)
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/notifications')
    expect(res.status).toBe(200)
    expect(res.json.data.items.map((item: { id: string; read: boolean }) => [item.id, item.read])).toEqual([
      ['n1', false],
      ['n2', true],
    ])
    expect(res.json.data.unreadCount).toBe(1)
    const where = JSON.stringify(prisma.notification.findMany.mock.calls[0][0].where)
    expect(where).toContain('"tenantId":"tenant-1"')
    expect(where).toContain('"userId":"user-1"')
  })

  it('列表带业务域与免打扰标记；按业务域、免打扰筛选，未读筛选不含免打扰期间收到的；筛选条件不合法 422', async () => {
    const prisma = prismaFor()
    prisma.notification.findMany.mockResolvedValue([row({ domain: 'ADS' }), row({ id: 'n2', domain: null, silencedAt: new Date() })])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/notifications?domain=ADS&silenced=false&unread=true')
    expect(res.json.data.items.map((item: { id: string; domain: string | null; silenced: boolean }) => [item.id, item.domain, item.silenced])).toEqual([
      ['n1', 'ADS', false],
      ['n2', null, true],
    ])
    expect(prisma.notification.findMany.mock.calls[0][0].where.AND[0]).toMatchObject({ domain: 'ADS', silencedAt: null, readAt: null })
    await harness.call('GET', '/notifications?domain=OTHER&silenced=true')
    expect(prisma.notification.findMany.mock.calls[1][0].where.AND[0]).toMatchObject({ domain: null, silencedAt: { not: null } })
    expect((await harness.call('GET', '/notifications?domain=NOPE')).status).toBe(422)
    expect((await harness.call('GET', '/notifications?silenced=maybe')).status).toBe(422)
  })

  it('未读数只统计本人本企业的未读通知，免打扰期间收到的（有免打扰标记）不计', async () => {
    const prisma = prismaFor()
    prisma.notification.count.mockResolvedValue(7)
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/notifications/unread-count')
    // P6-01：messages 与旧字段 unreadCount 同值；没有预警查看权限时 alerts 为 null（不是 0）
    expect(res.json.data).toEqual({ unreadCount: 7, messages: 7, alerts: null })
    expect(prisma.notification.count.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', userId: 'user-1', readAt: null, silencedAt: null })
    expect(prisma.alertInstance.count).not.toHaveBeenCalled()
  })

  it('有预警查看权限：alerts 是我的未读预警数（待处理且我没有已读记录，受店铺范围限制）', async () => {
    const prisma = prismaFor({ ...sessionStub(['alerts.read']), alertInstance: { count: vi.fn().mockResolvedValue(3) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/notifications/unread-count')
    expect(res.json.data.alerts).toBe(3)
    const where = prisma.alertInstance.count.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 'tenant-1', status: { in: ['NEW', 'ACKED'] }, reads: { none: { userId: 'user-1' } } })
  })

  it('标记已读：指定编号只改本人未读的通知；不传编号视为全部；他人的通知不会被改', async () => {
    const prisma = prismaFor()
    prisma.notification.updateMany.mockResolvedValue({ count: 2 })
    harness = await createTestApp(prisma)
    const some = await harness.call('POST', '/notifications/read', { body: { ids: ['n1', 'n2'] } })
    expect(some.status).toBe(200)
    expect(some.json.data).toEqual({ updated: 2 })
    expect(prisma.notification.updateMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', userId: 'user-1', readAt: null, id: { in: ['n1', 'n2'] } })
    await harness.call('POST', '/notifications/read', { body: { all: true } })
    expect(prisma.notification.updateMany.mock.calls[1][0].where).toEqual({ tenantId: 'tenant-1', userId: 'user-1', readAt: null })
  })

  it('未登录 401；订阅管理需要“通知管理”权限，普通成员 403', async () => {
    harness = await createTestApp(prismaFor())
    expect((await harness.call('GET', '/notifications', { auth: false })).status).toBe(401)
    const denied = await harness.call('POST', '/notifications/subscriptions', { body: { eventType: 'ORDER_CHANGE' } })
    expect(denied.status).toBe(403)
  })
})
