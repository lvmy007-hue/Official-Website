import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALERT_BATCH_MAX } from '@nova/api-contracts'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 预警两套状态与规则模板接口（P6-15）：已读按人记录、批量已读/已处理（上限、范围、跳过原因）、列表的已读筛选与未读数、规则模板。

const T0 = new Date('2026-10-20T00:00:00Z')
const instance = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  tenantId: 'tenant-1',
  ruleId: 'r1',
  ruleVersionNo: 2,
  dedupKey: 'campaign:c1',
  sellerAccountId: 's1',
  entityType: 'AD_CAMPAIGN',
  entityId: 'c1',
  entityLabel: '春季促销',
  title: '广告活动“春季促销”花费高、产出低',
  suggestedAction: null,
  impactMin: null,
  impactMax: null,
  currency: 'USD',
  severity: 'WARNING',
  status: 'NEW',
  triggerCount: 3,
  firstTriggeredAt: T0,
  lastTriggeredAt: new Date('2026-10-21T00:00:00Z'),
  resolvedAt: null,
  closeConclusion: null,
  closeNote: null,
  closedBy: null,
  workItemId: null,
  evidenceJson: {},
  rule: { id: 'r1', code: 'ADS_HIGH_SPEND_LOW_RETURN', name: '高花费低产出', domain: 'ADS', enabled: true, currentVersion: 2 },
  ...over,
})
const rule = (type: string, enabled = true) => ({ conditionJson: { type, params: {} }, enabled })

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const base = sessionStub(permissions)
  const prisma: Record<string, any> = {
    ...base,
    membership: { findFirst: vi.fn().mockImplementation((args: unknown) => base.membership.findFirst(args)), findMany: vi.fn().mockResolvedValue([]) },
    alertInstance: {
      findMany: vi.fn().mockResolvedValue([instance()]),
      findFirst: vi.fn().mockResolvedValue(instance()),
      count: vi.fn().mockResolvedValue(4),
      groupBy: vi.fn().mockResolvedValue([{ status: 'NEW', ruleId: 'r1', _count: { _all: 1 } }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    alertRead: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    alertRule: { findMany: vi.fn().mockResolvedValue([]) },
    workItem: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    legalEntity: { findMany: vi.fn().mockResolvedValue([]) },
    entityEvent: { create: vi.fn().mockResolvedValue({}) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    ...over,
  }
  const guards = createWriteGuardStubs()
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})
const boot = async (permissions: string[], over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma as never)
  return prisma
}

describe('预警列表：已读与未读数', () => {
  it('每条带我是否已读；未读数只算待处理且我没有已读记录的', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertInstance.findMany.mockResolvedValue([instance(), instance({ id: 'a2' })])
    prisma.alertRead.findMany.mockResolvedValue([{ alertId: 'a2' }])
    const res = await harness!.call('GET', '/alerts')
    expect(res.json.data.items.map((item: { id: string; read: boolean }) => [item.id, item.read])).toEqual([
      ['a1', false],
      ['a2', true],
    ])
    expect(res.json.data.unreadCount).toBe(4)
    expect(prisma.alertInstance.count.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', status: { in: ['NEW', 'ACKED'] }, reads: { none: { userId: 'user-1' } } })
    expect(prisma.alertRead.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1' })
  })

  it('readState=unread / read 只按我的已读记录过滤；handleState 决定处理状态视图并优先于旧的 view', async () => {
    const prisma = await boot(['alerts.read'])
    await harness!.call('GET', '/alerts?readState=unread')
    expect(prisma.alertInstance.findMany.mock.calls[0][0].where.AND[0]).toMatchObject({ reads: { none: { userId: 'user-1' } } })
    await harness!.call('GET', '/alerts?readState=read&handleState=handled&view=open')
    const where = prisma.alertInstance.findMany.mock.calls[1][0].where.AND[0]
    expect(where.reads).toEqual({ some: { userId: 'user-1' } })
    expect(where.status).toEqual({ in: ['HANDLED'] })
    expect((await harness!.call('GET', '/alerts?readState=maybe')).status).toBe(422)
    expect((await harness!.call('GET', '/alerts?handleState=bogus')).status).toBe(422)
  })

  it('没有 alerts.read：先 403，再谈参数', async () => {
    await boot([])
    expect((await harness!.call('GET', '/alerts?readState=maybe')).status).toBe(403)
  })
})

describe('批量标为已读', () => {
  it('没有权限 403（先于参数校验）；参数不合法 422，且不写库', async () => {
    const prisma = await boot([])
    expect((await harness!.call('POST', '/alerts/read', { body: {} })).status).toBe(403)
    await harness!.close()
    const prisma2 = await boot(['alerts.read'])
    expect((await harness!.call('POST', '/alerts/read', { body: {} })).status).toBe(422)
    expect((await harness!.call('POST', '/alerts/read', { body: { ids: [] } })).status).toBe(422)
    expect((await harness!.call('POST', '/alerts/read', { body: { ids: Array.from({ length: ALERT_BATCH_MAX + 1 }, (_, i) => `a${i}`) } })).status).toBe(422)
    expect(prisma.alertRead.createMany).not.toHaveBeenCalled()
    expect(prisma2.alertRead.createMany).not.toHaveBeenCalled()
  })

  it('只给范围内且我还没读过的预警写已读；范围外的当作不存在；已读的不重复写；去重后按用户写', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertInstance.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }])
    prisma.alertRead.findMany.mockResolvedValue([{ alertId: 'a2' }])
    const res = await harness!.call('POST', '/alerts/read', { body: { ids: ['a1', 'a1', 'a2', 'ghost'] } })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ marked: 1, missing: ['ghost'], unreadCount: 4 })
    expect(prisma.alertRead.createMany.mock.calls[0][0]).toEqual({ data: [{ tenantId: 'tenant-1', alertId: 'a1', userId: 'user-1' }], skipDuplicates: true })
    expect(prisma.alertInstance.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', id: { in: ['a1', 'a2', 'ghost'] } })
  })

  it('全部已读过：不写库，marked 为 0', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertRead.findMany.mockResolvedValue([{ alertId: 'a1' }])
    const res = await harness!.call('POST', '/alerts/read', { body: { ids: ['a1'] } })
    expect(res.json.data.marked).toBe(0)
    expect(prisma.alertRead.createMany).not.toHaveBeenCalled()
  })

  it('上限刚好 ALERT_BATCH_MAX 条可以通过', async () => {
    const prisma = await boot(['alerts.read'])
    const ids = Array.from({ length: ALERT_BATCH_MAX }, (_, i) => `a${i}`)
    prisma.alertInstance.findMany.mockResolvedValue(ids.map(id => ({ id })))
    const res = await harness!.call('POST', '/alerts/read', { body: { ids } })
    expect(res.status).toBe(200)
  })
})

describe('批量标为已处理', () => {
  it('需要 alerts.handle，只有 alerts.read 返回 403', async () => {
    const prisma = await boot(['alerts.read'])
    expect((await harness!.call('POST', '/alerts/handled', { body: { ids: ['a1'] } })).status).toBe(403)
    expect(prisma.alertInstance.updateMany).not.toHaveBeenCalled()
  })

  it('逐条按“关闭，结论已处理”执行；不存在的与已被处理的记入 skipped，不让整批失败；超上限 422', async () => {
    const prisma = await boot(['alerts.handle'])
    prisma.alertInstance.findFirst.mockImplementation(async (args: { where: { id?: string } }) => {
      if (args.where.id === 'ghost') return null
      if (args.where.id === 'done') return instance({ id: 'done', status: 'HANDLED' })
      return instance({ id: args.where.id })
    })
    const res = await harness!.call('POST', '/alerts/handled', { body: { ids: ['a1', 'ghost', 'done'], note: '已核实' } })
    expect(res.status).toBe(200)
    expect(res.json.data.handled).toBe(1)
    expect(res.json.data.skipped.map((item: { id: string }) => item.id)).toEqual(['ghost', 'done'])
    expect(res.json.data.unreadCount).toBe(4)
    expect(prisma.alertInstance.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'HANDLED', closeConclusion: 'HANDLED', closeNote: '已核实', closedBy: 'user-1' })
    const tooMany = Array.from({ length: ALERT_BATCH_MAX + 1 }, (_, i) => `a${i}`)
    expect((await harness!.call('POST', '/alerts/handled', { body: { ids: tooMany } })).status).toBe(422)
  })
})

describe('规则模板', () => {
  it('需要 alerts.read；返回五组模板，统计企业里同评估逻辑的规则数；can.create 看 alerts.manage', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertRule.findMany.mockResolvedValue([rule('ads.cpc-surge'), rule('ads.cpc-surge', false), rule('inventory.stockout-risk')])
    const res = await harness!.call('GET', '/alerts/templates')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    expect(new Set(data.items.map((item: { group: string }) => item.group))).toEqual(new Set(['INVENTORY', 'ADS', 'SALES', 'TRAFFIC', 'STORE']))
    const cpc = data.items.find((item: { type: string }) => item.type === 'ads.cpc-surge')
    expect(cpc).toMatchObject({ ruleCount: 2, enabledCount: 1 })
    expect(cpc.condition.length).toBeGreaterThan(5)
    expect(data.items.find((item: { type: string }) => item.type === 'ads.high-spend-low-return')).toMatchObject({ ruleCount: 0, enabledCount: 0 })
    expect(data.can.create).toBe(false)
  })

  it('有 alerts.manage 时 can.create 为 true；没有 alerts.read 403', async () => {
    await boot(['alerts.read', 'alerts.manage'])
    expect((await harness!.call('GET', '/alerts/templates')).json.data.can.create).toBe(true)
    await harness!.close()
    await boot([])
    expect((await harness!.call('GET', '/alerts/templates')).status).toBe(403)
  })
})
