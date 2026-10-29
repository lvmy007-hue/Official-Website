import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const NOW = Date.now()
const view = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  tenantId: 'tenant-1',
  pageKey: 'orders.list',
  name: '本周待发货',
  filterJson: { status: 'PENDING' },
  columnsJson: ['orderId'],
  sortJson: [],
  ownerId: 'user-1',
  shared: false,
  isDefault: false,
  version: 1,
  updatedAt: new Date(NOW),
  ...over,
})
const comment = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  tenantId: 'tenant-1',
  entityType: 'STORE',
  entityId: 's1',
  body: '这家店本周要补货',
  mentions: ['user-2'],
  parentId: null,
  authorId: 'user-1',
  createdAt: new Date(NOW),
  ...over,
})

function prismaFor(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    savedView: {
      findFirst: vi.fn().mockResolvedValue(view()),
      findMany: vi.fn().mockResolvedValue([view(), view({ id: 'v2', name: '团队共用', ownerId: 'user-2', shared: true })]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => view({ id: 'v-new', ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    comment: {
      findMany: vi.fn().mockResolvedValue([comment()]),
      findFirst: vi.fn().mockResolvedValue({ id: 'c0' }),
      create: vi.fn().mockImplementation(async ({ data }) => comment({ id: 'c-new', ...data })),
    },
    watch: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'w-new' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    entityEvent: { findMany: vi.fn().mockResolvedValue([]) },
    operationLog: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'log-new' }) },
    sellerAccount: { findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...over,
  }
  const base = prisma.membership
  prisma.membership = {
    ...base,
    findFirst: vi.fn().mockImplementation(async (args: any) => (args?.select?.userId ? { userId: args.where?.userId } : base.findFirst(args))),
    findMany: vi.fn().mockImplementation(async (args: any) =>
      args?.select?.userId && !args.select.user
        ? (args.where.userId.in as string[]).map(userId => ({ userId }))
        : [
            { userId: 'user-1', user: { displayName: '甲', email: 'a@x.com' } },
            { userId: 'user-2', user: { displayName: '乙', email: 'b@x.com' } },
          ],
    ),
  }
  return prisma
}

describe('保存视图', () => {
  it('列表只返回自己的和团队共享的视图，并标明是否本人、创建人', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/views?pageKey=orders.list')
    expect(res.status).toBe(200)
    expect(res.json.data.items).toHaveLength(2)
    expect(res.json.data.items[0]).toMatchObject({ id: 'v1', mine: true, owner: { name: '甲' } })
    expect(res.json.data.items[1]).toMatchObject({ id: 'v2', mine: false, shared: true, owner: { name: '乙' } })
    expect(prisma.savedView.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', pageKey: 'orders.list', OR: [{ ownerId: 'user-1' }, { shared: true }] })
    expect((await harness.call('GET', '/views')).status).toBe(422)
  })

  it('新建：设为默认时同一事务里取消原默认；同名返回 409；超过上限返回 409', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const body = { pageKey: 'orders.list', name: '新视图', filterJson: {}, columnsJson: [], sortJson: [], isDefault: true }
    const res = await harness.call('POST', '/views', { body })
    expect(res.status).toBe(201)
    expect(prisma.savedView.updateMany.mock.calls[0][0]).toMatchObject({ where: { ownerId: 'user-1', pageKey: 'orders.list', isDefault: true }, data: { isDefault: false } })
    expect(prisma.savedView.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', ownerId: 'user-1', name: '新视图', isDefault: true })
    prisma.savedView.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    expect((await harness.call('POST', '/views', { body })).status).toBe(409)
    prisma.savedView.count.mockResolvedValue(30)
    expect((await harness.call('POST', '/views', { body })).status).toBe(409)
    expect((await harness.call('POST', '/views', { body: { ...body, name: '' } })).status).toBe(422)
  })

  it('修改与删除：只有创建人可以；版本过期返回 409；别人的视图 403', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    expect((await harness.call('PATCH', '/views/v1', { body: { version: 1, name: '改名', shared: true } })).status).toBe(200)
    expect(prisma.savedView.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'v1', ownerId: 'user-1', version: 1 }, data: { name: '改名', shared: true } })
    prisma.savedView.updateMany.mockResolvedValueOnce({ count: 0 })
    prisma.savedView.findFirst.mockImplementation(async (args: any) => (args?.select ? { version: 2 } : view()))
    expect((await harness.call('PATCH', '/views/v1', { body: { version: 1, name: '再改' } })).status).toBe(409)
    prisma.savedView.findFirst.mockResolvedValue(view({ ownerId: 'user-2', shared: true }))
    expect((await harness.call('PATCH', '/views/v1', { body: { version: 1, name: '越权' } })).status).toBe(403)
    expect((await harness.call('DELETE', '/views/v1')).status).toBe(403)
    prisma.savedView.findFirst.mockResolvedValue(null)
    expect((await harness.call('DELETE', '/views/nope')).status).toBe(404)
    prisma.savedView.findFirst.mockResolvedValue(view())
    expect((await harness.call('DELETE', '/views/v1')).status).toBe(200)
    expect(prisma.savedView.deleteMany.mock.calls[0][0].where).toEqual({ id: 'v1', tenantId: 'tenant-1', ownerId: 'user-1' })
  })
})

describe('评论', () => {
  it('读评论随对象读权限：没有 overview.read 不能看店铺评论', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('GET', '/comments?entityType=STORE&entityId=s1')).status).toBe(403)
  })

  it('列表返回作者、被 @ 的成员、关注状态；不支持的对象类型 422', async () => {
    const prisma = prismaFor(['overview.read'])
    prisma.watch.findFirst.mockResolvedValue({ id: 'w1' })
    prisma.watch.count.mockResolvedValue(3)
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/comments?entityType=STORE&entityId=s1')
    expect(res.status).toBe(200)
    expect(res.json.data.items[0]).toMatchObject({ id: 'c1', mine: true, author: { name: '甲' }, mentions: [{ id: 'user-2', name: '乙' }] })
    expect(res.json.data.watch).toEqual({ watching: true, watchId: 'w1', watchers: 3 })
    expect((await harness.call('GET', '/comments?entityType=NOPE&entityId=s1')).status).toBe(422)
  })

  it('发表评论：需要 collab.write；@ 的必须是在职成员；被 @ 的人收到站内通知，自己 @ 自己不通知', async () => {
    const prisma = prismaFor(['collab.write', 'overview.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/comments', { body: { entityType: 'STORE', entityId: 's1', body: '请看一下', mentions: ['user-2', 'user-1'] } })
    expect(res.status).toBe(201)
    expect(prisma.comment.create.mock.calls[0][0].data).toMatchObject({ authorId: 'user-1', mentions: ['user-2', 'user-1'] })
    const notified = prisma.notification.createMany.mock.calls[0][0].data
    expect(notified).toHaveLength(1)
    expect(notified[0]).toMatchObject({ userId: 'user-2', kind: 'MENTION', title: '甲 在店铺评论里提到了你' })
    prisma.membership.findMany.mockImplementationOnce(async () => [])
    expect((await harness.call('POST', '/comments', { body: { entityType: 'STORE', entityId: 's1', body: '你好', mentions: ['stranger'] } })).status).toBe(422)
    expect((await harness.call('POST', '/comments', { body: { entityType: 'STORE', entityId: 's1', body: '   ' } })).status).toBe(422)
  })

  it('没有 collab.write 不能发表评论；回复的评论必须在同一对象下', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('POST', '/comments', { body: { entityType: 'STORE', entityId: 's1', body: 'x' } })).status).toBe(403)
    await harness.close()
    const prisma = prismaFor(['collab.write', 'overview.read'])
    prisma.comment.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/comments', { body: { entityType: 'STORE', entityId: 's1', body: '回复', parentId: 'other' } })).status).toBe(422)
  })
})

describe('关注', () => {
  it('关注：幂等（已关注不重复创建）；超过上限 409；店铺必须存在', async () => {
    const prisma = prismaFor(['collab.write', 'overview.read'])
    harness = await createTestApp(prisma)
    const body = { entityType: 'STORE', entityId: 's1' }
    expect((await harness.call('POST', '/watches', { body })).json.data).toEqual({ id: 'w-new', created: true })
    prisma.watch.findFirst.mockResolvedValue({ id: 'w-old' })
    expect((await harness.call('POST', '/watches', { body })).json.data).toEqual({ id: 'w-old', created: false })
    prisma.watch.findFirst.mockResolvedValue(null)
    prisma.watch.count.mockResolvedValue(2000)
    expect((await harness.call('POST', '/watches', { body })).status).toBe(409)
    prisma.sellerAccount.findFirst.mockResolvedValue(null)
    expect((await harness.call('POST', '/watches', { body: { entityType: 'STORE', entityId: 'gone' } })).status).toBe(404)
  })

  it('取消关注只能取消本人的；没有权限 403', async () => {
    const prisma = prismaFor(['collab.write'])
    harness = await createTestApp(prisma)
    expect((await harness.call('DELETE', '/watches/w1')).status).toBe(200)
    expect(prisma.watch.deleteMany.mock.calls[0][0].where).toEqual({ id: 'w1', tenantId: 'tenant-1', userId: 'user-1' })
    prisma.watch.deleteMany.mockResolvedValue({ count: 0 })
    expect((await harness.call('DELETE', '/watches/w2')).status).toBe(404)
    await harness.close()
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('DELETE', '/watches/w1')).status).toBe(403)
  })
})

// 对象事件时间线已并入统一事件接口 GET /events（P6-06），测试见 modules/events/events.http.test.ts。
describe('运营日志', () => {
  it('运营日志：范围按对象读权限；手工记录需要 collab.write，发生时间不能晚于现在', async () => {
    const prisma = prismaFor(['collab.write', 'overview.read'])
    prisma.operationLog.findMany.mockResolvedValue([{ id: 'l1', occurredAt: new Date(NOW), category: 'PRICE', text: '降价 2 美元', authorId: 'user-1' }])
    harness = await createTestApp(prisma)
    const list = await harness.call('GET', '/operation-logs?scope=STORE&scopeRef=s1')
    expect(list.json.data.items[0]).toMatchObject({ categoryLabel: '价格', mine: true, author: { name: '甲' } })
    const body = { scope: 'STORE', scopeRef: 's1', occurredAt: new Date(NOW - 60_000).toISOString(), category: 'PRICE', text: '降价 2 美元' }
    expect((await harness.call('POST', '/operation-logs', { body })).status).toBe(201)
    expect(prisma.operationLog.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', authorId: 'user-1', scope: 'STORE' })
    expect((await harness.call('POST', '/operation-logs', { body: { ...body, occurredAt: new Date(NOW + 3_600_000).toISOString() } })).status).toBe(422)
    expect((await harness.call('POST', '/operation-logs', { body: { ...body, text: '好' } })).status).toBe(422)
    await harness.close()
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('POST', '/operation-logs', { body })).status).toBe(403)
  })
})
