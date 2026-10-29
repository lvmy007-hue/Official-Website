import { afterEach, describe, expect, it, vi } from 'vitest'
import { workDueGroup } from '@nova/api-contracts'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const NOW = Date.now()
const item = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  tenantId: 'tenant-1',
  title: '库存数据已落后',
  kind: 'FRESHNESS_STALE',
  source: 'ALERT',
  status: 'PENDING',
  priority: 'HIGH',
  severity: 'WARNING',
  dueAt: new Date(NOW + 3_600_000),
  slaBreachedAt: null,
  escalatedAt: null,
  sourceAlertId: 'alert-1',
  ruleCode: 'FRESHNESS_STALE',
  entityType: 'STORE',
  entityId: 's1',
  entityLabel: '美国主店',
  impactMin: null,
  impactMax: null,
  currency: 'USD',
  suggestedAction: '检查连接',
  detail: null,
  closeConclusion: null,
  closeNote: null,
  ignoreReason: null,
  deferredUntil: null,
  ackAt: null,
  closedAt: null,
  closedBy: null,
  ownerId: 'user-1',
  createdBy: 'user-2',
  version: 3,
  createdAt: new Date(NOW - 3_600_000),
  updatedAt: new Date(NOW),
  ...over,
})

function prismaFor(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    workItem: {
      findFirst: vi.fn().mockResolvedValue(item()),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => item({ id: 'w-new', version: 1, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    assignment: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
    watch: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    entityEvent: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
    alertInstance: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null) },
    membership: {
      findFirst: vi
        .fn()
        .mockImplementation(async (args: { where?: { userId?: string }; select?: { userId?: boolean } }) =>
          args?.select?.userId ? { userId: args.where?.userId } : { id: 'membership-1', tenantId: 'tenant-1', role: { permissions }, tenant: { lifecycleStatus: 'ACTIVE' } },
        ),
      findMany: vi.fn().mockResolvedValue([
        { userId: 'user-1', user: { displayName: '甲', email: 'a@x.com' }, role: { permissions: ['workitem.assign'], system: true, version: 2, fieldPermissions: [] } },
        { userId: 'user-2', user: { displayName: '乙', email: 'b@x.com' }, role: { permissions: [], system: true, version: 2, fieldPermissions: [] } },
      ]),
    },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...over,
  }
  // updateWithVersion 更新成功后会再读一次最新记录
  prisma.workItem.findFirst.mockImplementation(async (args: { select?: unknown }) => (args?.select ? { version: 3 } : item()))
  return prisma
}

describe('待办列表', () => {
  it('登录成员即可查看；按页签返回本人相关的待办，带剩余时限与分组，不含买家信息；counts 为五个页签数量', async () => {
    const prisma = prismaFor([])
    prisma.workItem.findMany.mockResolvedValue([item(), item({ id: 'w2', dueAt: new Date(NOW - 60_000), title: '已超时' })])
    prisma.workItem.count.mockResolvedValue(2)
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/work-items?tab=MINE')
    expect(res.status).toBe(200)
    expect(res.json.data.items).toHaveLength(2)
    expect(res.json.data.items[0]).toMatchObject({
      id: 'w1',
      overdue: false,
      groupKey: expect.stringMatching(/TODAY|THIS_WEEK/),
      owner: { id: 'user-1', name: '甲' },
      entity: { type: 'STORE', label: '美国主店' },
    })
    expect(res.json.data.items[1]).toMatchObject({ id: 'w2', overdue: true, groupKey: 'OVERDUE' })
    expect(Object.keys(res.json.data.counts)).toEqual(['MINE', 'ASSIGNED', 'WATCHING', 'DONE', 'IGNORED'])
    const where = prisma.workItem.findMany.mock.calls[0][0].where.AND
    expect(where[0]).toMatchObject({ tenantId: 'tenant-1' })
    expect(where[1]).toMatchObject({ ownerId: 'user-1', status: { in: ['PENDING', 'IN_PROGRESS'] } })
  })

  it('已忽略页签按关闭结论过滤；关注页签按关注记录过滤', async () => {
    const prisma = prismaFor([])
    prisma.watch.findMany.mockResolvedValue([{ entityId: 'w9' }])
    harness = await createTestApp(prisma)
    await harness.call('GET', '/work-items?tab=IGNORED')
    expect(prisma.workItem.findMany.mock.calls[0][0].where.AND[1]).toMatchObject({ ownerId: 'user-1', closeConclusion: 'IGNORED' })
    await harness.call('GET', '/work-items?tab=WATCHING')
    expect(prisma.workItem.findMany.mock.calls[1][0].where.AND[1]).toEqual({ id: { in: ['w9'] } })
  })

  it('查看全部（scope=all）需要 workitem.read；没有则 403；有则不限负责人', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('GET', '/work-items?scope=all')).status).toBe(403)
    await harness.close()
    const prisma = prismaFor(['workitem.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/work-items?scope=all&tab=MINE')
    expect(res.status).toBe(200)
    expect(prisma.workItem.findMany.mock.calls[0][0].where.AND[1]).toEqual({ status: { in: ['PENDING', 'IN_PROGRESS'] } })
    expect(res.json.data.counts).toBeNull()
  })

  it('参数不合法返回 422', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('GET', '/work-items?tab=NOPE')).status).toBe(422)
    expect((await harness.call('GET', '/work-items?limit=999')).status).toBe(422)
  })
})

describe('待办详情', () => {
  it('负责人可见；返回触发规则与证据（只展示有中文名的字段）、时间线、指派记录与可执行动作', async () => {
    const prisma = prismaFor(['workitem.handle'])
    prisma.alertInstance.findFirst.mockResolvedValue({
      evidenceJson: { source: '订单', hoursBehind: 30, internalToken: 'secret' },
      triggerCount: 3,
      firstTriggeredAt: new Date(NOW - 86_400_000),
      rule: { name: '数据新鲜度', domain: 'DATA' },
    })
    prisma.entityEvent.findMany.mockResolvedValue([{ id: 'e1', occurredAt: new Date(NOW - 1000), title: '创建待办', actorKind: 'SYSTEM', actorId: null }])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/work-items/w1')
    expect(res.status).toBe(200)
    expect(res.json.data.trigger).toMatchObject({
      ruleName: '数据新鲜度',
      triggerCount: 3,
      evidence: [
        { label: '数据来源', value: '订单' },
        { label: '已落后（小时）', value: '30' },
      ],
    })
    expect(JSON.stringify(res.json)).not.toContain('internalToken')
    expect(res.json.data.timeline).toEqual([expect.objectContaining({ title: '创建待办', actor: '系统' })])
    expect(res.json.data.can).toEqual({ handle: true, assign: false })
  })

  it('与自己无关的待办按“不存在”处理（没有 workitem.read 时）；有 workitem.read 可看', async () => {
    const other = item({ ownerId: 'user-2', createdBy: 'user-2' })
    const prisma = prismaFor([])
    prisma.workItem.findFirst.mockResolvedValue(other)
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/work-items/w1')).status).toBe(404)
    await harness.close()
    const readable = prismaFor(['workitem.read'])
    readable.workItem.findFirst.mockResolvedValue(other)
    harness = await createTestApp(readable)
    expect((await harness.call('GET', '/work-items/w1')).status).toBe(200)
  })
})

describe('待办处理动作', () => {
  it('确认：待处理 → 处理中，记时间线与审计，同步预警为已确认', async () => {
    const prisma = prismaFor(['workitem.handle'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/work-items/w1/ack', { body: { version: 3 } })
    expect(res.status).toBe(200)
    // 更新条件不带状态：更新后要按同一条件重读，带旧状态会读不到（真实库测试发现，见 CR-022）；并发修改由版本号检测
    const where = prisma.workItem.updateMany.mock.calls[0][0].where
    expect(where).toMatchObject({ id: 'w1', tenantId: 'tenant-1', version: 3 })
    expect(where).not.toHaveProperty('status')
    expect(prisma.workItem.updateMany.mock.calls[0][0]).toMatchObject({ data: { status: 'IN_PROGRESS' } })
    expect(prisma.entityEvent.create.mock.calls[0][0].data).toMatchObject({ entityType: 'WORK_ITEM', entityId: 'w1', actorId: 'user-1', title: '确认，开始处理' })
    expect(prisma.alertInstance.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'alert-1' }, data: { status: 'ACKED' } })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'WORK_ITEM_ACKED', resourceId: 'w1' })
  })

  it('版本已被别人推进返回 409 并带当前版本；已确认的不能再确认', async () => {
    const prisma = prismaFor(['workitem.handle'])
    prisma.workItem.updateMany.mockResolvedValue({ count: 0 })
    harness = await createTestApp(prisma)
    const conflict = await harness.call('POST', '/work-items/w1/ack', { body: { version: 2 } })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.details).toMatchObject({ currentVersion: 3, expectedVersion: 2 })
    prisma.workItem.findFirst.mockImplementation(async () => item({ status: 'IN_PROGRESS' }))
    expect((await harness.call('POST', '/work-items/w1/ack', { body: { version: 3 } })).status).toBe(409)
  })

  it('他人的待办：没有指派权限不能处理；有指派权限（上级）可以处理', async () => {
    const mine = item({ ownerId: 'user-2', createdBy: 'user-2' })
    const prisma = prismaFor(['workitem.handle', 'workitem.read'])
    prisma.workItem.findFirst.mockImplementation(async (args: { select?: unknown }) => (args?.select ? { version: 3 } : mine))
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/work-items/w1/ack', { body: { version: 3 } })).status).toBe(403)
    await harness.close()
    const boss = prismaFor(['workitem.handle', 'workitem.assign', 'workitem.read'])
    boss.workItem.findFirst.mockImplementation(async (args: { select?: unknown }) => (args?.select ? { version: 3 } : mine))
    harness = await createTestApp(boss)
    expect((await harness.call('POST', '/work-items/w1/ack', { body: { version: 3 } })).status).toBe(200)
  })

  it('忽略必须填原因；成功后状态为已关闭、结论为已忽略，预警同步为已忽略', async () => {
    const prisma = prismaFor(['workitem.handle'])
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/work-items/w1/ignore', { body: { version: 3 } })).status).toBe(422)
    expect((await harness.call('POST', '/work-items/w1/ignore', { body: { version: 3, reason: ' ' } })).status).toBe(422)
    const res = await harness.call('POST', '/work-items/w1/ignore', { body: { version: 3, reason: '已在别处处理' } })
    expect(res.status).toBe(200)
    expect(prisma.workItem.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED', closeConclusion: 'IGNORED', ignoreReason: '已在别处处理', closedBy: 'user-1' })
    expect(prisma.alertInstance.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'IGNORED' })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'WORK_ITEM_IGNORED', reason: '已在别处处理' })
  })

  it('关闭：已处理 → 已完成；误报 → 已关闭；已结束的不能再关闭', async () => {
    const prisma = prismaFor(['workitem.handle'])
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/work-items/w1/close', { body: { version: 3, conclusion: 'HANDLED' } })).status).toBe(200)
    expect(prisma.workItem.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'DONE', closeConclusion: 'HANDLED' })
    expect((await harness.call('POST', '/work-items/w1/close', { body: { version: 3, conclusion: 'FALSE_POSITIVE', note: '检查后确认' } })).status).toBe(200)
    expect(prisma.workItem.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'CLOSED', closeConclusion: 'FALSE_POSITIVE', closeNote: '检查后确认' })
    expect(prisma.alertInstance.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'IGNORED' })
    expect((await harness.call('POST', '/work-items/w1/close', { body: { version: 3, conclusion: 'IGNORED' } })).status).toBe(422)
    prisma.workItem.findFirst.mockImplementation(async () => item({ status: 'DONE' }))
    expect((await harness.call('POST', '/work-items/w1/close', { body: { version: 3, conclusion: 'HANDLED' } })).status).toBe(409)
  })

  it('延期：必须晚于现在、不超过 90 天、填原因；成功后截止时间改为延期时间', async () => {
    const prisma = prismaFor(['workitem.handle'])
    harness = await createTestApp(prisma)
    const until = new Date(NOW + 2 * 86_400_000).toISOString()
    expect((await harness.call('POST', '/work-items/w1/defer', { body: { version: 3, until: new Date(NOW - 1000).toISOString(), reason: '等供应商' } })).status).toBe(422)
    expect((await harness.call('POST', '/work-items/w1/defer', { body: { version: 3, until: new Date(NOW + 100 * 86_400_000).toISOString(), reason: '等供应商' } })).status).toBe(422)
    expect((await harness.call('POST', '/work-items/w1/defer', { body: { version: 3, until } })).status).toBe(422)
    expect((await harness.call('POST', '/work-items/w1/defer', { body: { version: 3, until, reason: '等供应商回复' } })).status).toBe(200)
    expect(prisma.workItem.updateMany.mock.calls[0][0].data).toMatchObject({ dueAt: new Date(until), deferredUntil: new Date(until), slaBreachedAt: null })
  })

  it('指派：需要 workitem.assign；对象必须是在职成员；重置为待处理并通知被指派人；已结束不能指派', async () => {
    const prisma = prismaFor(['workitem.assign'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/work-items/w1/assign', { body: { version: 3, assigneeId: 'user-2', note: '请跟进' } })
    expect(res.status).toBe(200)
    expect(prisma.workItem.updateMany.mock.calls[0][0].data).toMatchObject({ ownerId: 'user-2', status: 'PENDING', ackAt: null })
    expect(prisma.assignment.upsert.mock.calls[0][0].create).toMatchObject({ workItemId: 'w1', assigneeId: 'user-2', assignedBy: 'user-1' })
    expect(prisma.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ userId: 'user-2', kind: 'WORK_ASSIGNED', link: '/app/my/work-items?item=w1' })
    prisma.membership.findFirst.mockImplementation(async (args: { select?: { userId?: boolean } }) =>
      args?.select?.userId ? null : { id: 'm', tenantId: 'tenant-1', role: { permissions: ['workitem.assign'] }, tenant: { lifecycleStatus: 'ACTIVE' } },
    )
    expect((await harness.call('POST', '/work-items/w1/assign', { body: { version: 3, assigneeId: 'stranger' } })).status).toBe(422)
    await harness.close()
    harness = await createTestApp(prismaFor(['workitem.handle']))
    expect((await harness.call('POST', '/work-items/w1/assign', { body: { version: 3, assigneeId: 'user-2' } })).status).toBe(403)
  })

  it('手工创建：需要 workitem.assign；按严重度给默认时限；指派给他人时通知；关联对象类型必须在白名单内', async () => {
    const prisma = prismaFor(['workitem.assign'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/work-items', { body: { title: '核对本周广告花费', severity: 'CRITICAL', ownerId: 'user-2' } })
    expect(res.status).toBe(201)
    const data = prisma.workItem.create.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: 'tenant-1', source: 'MANUAL', kind: 'MANUAL', ownerId: 'user-2', createdBy: 'user-1', severity: 'CRITICAL' })
    expect(Math.round((data.dueAt.getTime() - Date.now()) / 3_600_000)).toBe(4)
    expect(prisma.notification.createMany).toHaveBeenCalled()
    expect((await harness.call('POST', '/work-items', { body: { title: '核对', entityType: 'NOT_A_TYPE', entityId: 'x' } })).status).toBe(422)
    expect((await harness.call('POST', '/work-items', { body: { title: 'x' } })).status).toBe(422)
  })

  it('批量：逐条处理，部分失败不影响其他；忽略必须有原因；指派需要指派权限', async () => {
    const prisma = prismaFor(['workitem.handle'])
    prisma.workItem.findFirst.mockImplementation(async (args: { where: { id: string }; select?: unknown }) =>
      args?.select ? { version: 3 } : item({ id: args.where.id, status: args.where.id === 'w2' ? 'IN_PROGRESS' : 'PENDING' }),
    )
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/work-items', {
      body: {
        action: 'ACK',
        items: [
          { id: 'w1', version: 3 },
          { id: 'w2', version: 3 },
        ],
      },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ total: 2, succeeded: 1 })
    expect(res.json.data.results[1]).toMatchObject({ id: 'w2', ok: false, code: 'CONFLICT' })
    expect((await harness.call('PATCH', '/work-items', { body: { action: 'IGNORE', items: [{ id: 'w1', version: 3 }] } })).status).toBe(422)
    expect((await harness.call('PATCH', '/work-items', { body: { action: 'ASSIGN', items: [{ id: 'w1', version: 3 }], assigneeId: 'user-2' } })).status).toBe(403)
  })
})

describe('待办时间分组', () => {
  it('按截止时间划分：已超时、今天、本周内、更晚、无截止时间', () => {
    const now = new Date('2026-10-22T08:00:00Z')
    expect(workDueGroup(null, now)).toBe('NONE')
    expect(workDueGroup(new Date('2026-10-22T07:00:00Z'), now)).toBe('OVERDUE')
    expect(workDueGroup(new Date('2026-10-22T20:00:00Z'), now)).toBe('TODAY')
    expect(workDueGroup(new Date('2026-10-25T10:00:00Z'), now)).toBe('THIS_WEEK')
    expect(workDueGroup(new Date('2026-11-30T10:00:00Z'), now)).toBe('LATER')
  })
})
