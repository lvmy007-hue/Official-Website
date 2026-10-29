import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 预警中心接口（P5-01）：权限先于参数校验、数据范围、列表与详情口径、处理动作（确认/忽略/分派/关闭）与并发保护、规则列表与改动（阈值校验、版本、乐观锁）。

const none = () => vi.fn().mockResolvedValue([])
const T0 = new Date('2026-10-20T00:00:00Z')
const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  tenantId: 'tenant-1',
  code: 'ADS_HIGH_SPEND_LOW_RETURN',
  domain: 'ADS',
  name: '高花费低产出',
  conditionJson: { type: 'ads.high-spend-low-return', params: { windowDays: 7, minSpend: 20, minClicks: 30, acosThreshold: 1 } },
  severity: 'WARNING',
  cooldownMinutes: 1440,
  enabled: true,
  scopeJson: {},
  currentVersion: 2,
  version: 4,
  createdAt: T0,
  updatedAt: T0,
  ...over,
})
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
  suggestedAction: '降低竞价',
  impactMin: { toString: () => '30' },
  impactMax: { toString: () => '60' },
  currency: 'USD',
  severity: 'WARNING',
  status: 'NEW',
  triggerCount: 2,
  firstTriggeredAt: T0,
  lastTriggeredAt: new Date('2026-10-21T00:00:00Z'),
  resolvedAt: null,
  closeConclusion: null,
  closeNote: null,
  closedBy: null,
  workItemId: 'w1',
  evidenceJson: { spend: 45.5, clicks: 80, acos: 1.4 },
  rule: { id: 'r1', code: 'ADS_HIGH_SPEND_LOW_RETURN', name: '高花费低产出', domain: 'ADS', enabled: true, currentVersion: 2 },
  ...over,
})
const work = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  status: 'PENDING',
  ownerId: 'user-1',
  title: '广告活动“春季促销”花费高、产出低',
  entityLabel: '春季促销',
  suggestedAction: '降低竞价',
  impactMin: null,
  impactMax: null,
  currency: 'USD',
  dueAt: new Date('2026-10-22T00:00:00Z'),
  version: 1,
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const base = sessionStub(permissions)
  const prisma: Record<string, any> = {
    ...base,
    membership: {
      findFirst: vi.fn().mockImplementation(async (args: unknown) => ({ ...(await base.membership.findFirst(args)), user: { displayName: '乙', email: 'b@x.com' } })),
      findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '甲', email: 'a@x.com' } }]),
    },
    alertInstance: {
      findMany: vi.fn().mockResolvedValue([instance()]),
      findFirst: vi.fn().mockResolvedValue(instance()),
      count: vi.fn().mockResolvedValue(1),
      groupBy: vi.fn().mockResolvedValue([{ status: 'NEW', ruleId: 'r1', _count: { _all: 1 } }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    alertRead: { findMany: none(), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    alertRule: { findMany: vi.fn().mockResolvedValue([rule()]), findFirst: vi.fn().mockResolvedValue(rule()), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    alertRuleVersion: { findFirst: vi.fn().mockResolvedValue(null), findMany: none(), create: vi.fn().mockResolvedValue({}) },
    workItem: {
      findMany: vi.fn().mockResolvedValue([work()]),
      findFirst: vi.fn().mockResolvedValue(work()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: 'w-new' }),
    },
    assignment: { upsert: vi.fn().mockResolvedValue({}) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    legalEntity: { findMany: none() },
    entityEvent: { findMany: none(), create: vi.fn().mockResolvedValue({}) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([{ categoryPath: '家居/厨房' }]) },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
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

describe('预警列表', () => {
  it('没有 alerts.read 返回 403，且不查询数据', async () => {
    const prisma = await boot([])
    const res = await harness!.call('GET', '/alerts')
    expect(res.status).toBe(403)
    expect(prisma.alertInstance.findMany).not.toHaveBeenCalled()
  })

  it('权限先于参数校验：无权限时非法参数也只返回 403', async () => {
    await boot([])
    expect((await harness!.call('GET', '/alerts?view=bogus')).status).toBe(403)
  })

  it('默认看待处理视图；返回标题、对象、影响区间、负责人，影响缺失时为 null 而不是 0', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertInstance.findMany.mockResolvedValue([instance(), instance({ id: 'a2', impactMin: null, impactMax: null, workItemId: null, title: null, entityLabel: null })])
    const res = await harness!.call('GET', '/alerts')
    expect(res.status).toBe(200)
    const [first, second] = res.json.data.items
    expect(first).toMatchObject({
      id: 'a1',
      ruleName: '高花费低产出',
      domainLabel: '广告',
      statusLabel: '新预警',
      impact: { min: 30, max: 60, currency: 'USD' },
      owner: { id: 'user-1', name: '甲' },
      storeName: '美国主店',
    })
    expect(second).toMatchObject({ id: 'a2', impact: null, owner: null, title: '高花费低产出' })
    const where = prisma.alertInstance.findMany.mock.calls[0][0].where.AND[0]
    expect(where).toMatchObject({ tenantId: 'tenant-1', status: { in: ['NEW', 'ACKED'] } })
    expect(res.json.data.counts).toMatchObject({ open: 1, all: 1 })
  })

  it('没有任何预警时是 NO_DATA 并说明原因', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertInstance.findMany.mockResolvedValue([])
    prisma.alertInstance.groupBy.mockResolvedValue([])
    const res = await harness!.call('GET', '/alerts')
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(res.json.data.note).toContain('尚无预警')
  })

  it('成员只有部分店铺的数据范围时，只查范围内的预警（含企业级预警只给全范围成员）', async () => {
    const prisma = await boot(['alerts.read'], { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } })
    await harness!.call('GET', '/alerts')
    const where = prisma.alertInstance.findMany.mock.calls[0][0].where.AND[0]
    expect(JSON.stringify(where)).toContain('s1')
  })
})

describe('预警详情', () => {
  it('返回规则触发时的阈值、证据中文名、历史与时间线；评论权限之外的处理权限体现在 can.handle', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertRuleVersion.findFirst.mockResolvedValue({
      versionNo: 2,
      conditionJson: { type: 'ads.high-spend-low-return', params: { windowDays: 14, minSpend: 50, minClicks: 30, acosThreshold: 1.2 } },
    })
    prisma.alertInstance.findMany.mockResolvedValue([
      instance({ id: 'a0', status: 'HANDLED', closeConclusion: 'HANDLED', resolvedAt: new Date('2026-10-10T00:00:00Z'), firstTriggeredAt: new Date('2026-10-09T00:00:00Z') }),
      instance(),
    ])
    const res = await harness!.call('GET', '/alerts/a1')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.rule.thresholds).toEqual(
      expect.arrayContaining([
        { label: '回看天数', value: '14 天' },
        { label: '花费下限', value: '50 美元' },
      ]),
    )
    expect(data.rule.versionNo).toBe(2)
    expect(data.evidence.length).toBeGreaterThan(0)
    expect(JSON.stringify(data.evidence)).not.toContain('acos"')
    expect(data.history).toHaveLength(2)
    expect(data.history.find((item: { current: boolean }) => item.current).id).toBe('a1')
    expect(data.ruleTrend).toHaveLength(30)
    expect(data.timeline[0].title).toContain('首次触发')
    expect(data.can.handle).toBe(false)
    expect(data.assignees).toEqual([])
  })

  it('有处理权限时返回可分派的成员', async () => {
    await boot(['alerts.read', 'alerts.handle'])
    const res = await harness!.call('GET', '/alerts/a1')
    expect(res.json.data.can.handle).toBe(true)
    expect(res.json.data.assignees).toEqual([{ id: 'user-1', name: '甲' }])
  })

  it('预警不存在或不在数据范围内返回 404', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertInstance.findFirst.mockResolvedValue(null)
    expect((await harness!.call('GET', '/alerts/nope')).status).toBe(404)
  })
})

describe('处理动作', () => {
  it('没有 alerts.handle 一律 403', async () => {
    const prisma = await boot(['alerts.read'])
    for (const [path, body] of [
      ['ack', {}],
      ['ignore', { reason: '已知问题' }],
      ['assign', { assigneeId: 'user-1' }],
      ['close', { conclusion: 'HANDLED' }],
    ] as const)
      expect((await harness!.call('POST', `/alerts/a1/${path}`, { body })).status).toBe(403)
    expect(prisma.alertInstance.updateMany).not.toHaveBeenCalled()
  })

  it('确认：新预警 → 处理中，同步待办为处理中，写时间线与审计', async () => {
    const prisma = await boot(['alerts.handle'])
    const res = await harness!.call('POST', '/alerts/a1/ack', { body: {} })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ id: 'a1', status: 'ACKED', statusLabel: '处理中' })
    expect(prisma.alertInstance.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'a1', status: 'NEW' }, data: { status: 'ACKED' } })
    expect(prisma.workItem.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'IN_PROGRESS' })
    expect(prisma.entityEvent.create).toHaveBeenCalledTimes(2)
  })

  it('已经确认过的预警再确认返回 409', async () => {
    const prisma = await boot(['alerts.handle'])
    prisma.alertInstance.findFirst.mockResolvedValue(instance({ status: 'ACKED' }))
    expect((await harness!.call('POST', '/alerts/a1/ack', { body: {} })).status).toBe(409)
  })

  it('忽略必须写原因；写了原因则关闭预警与待办，并记结论为已忽略', async () => {
    const prisma = await boot(['alerts.handle'])
    const bad = await harness!.call('POST', '/alerts/a1/ignore', { body: { reason: ' ' } })
    expect(bad.status).toBe(422)
    const res = await harness!.call('POST', '/alerts/a1/ignore', { body: { reason: '促销期间的预期花费' } })
    expect(res.status).toBe(200)
    expect(res.json.data.status).toBe('IGNORED')
    expect(prisma.alertInstance.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'IGNORED', closeConclusion: 'IGNORED', closeNote: '促销期间的预期花费', closedBy: 'user-1' })
    expect(prisma.workItem.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED', closeConclusion: 'IGNORED', ignoreReason: '促销期间的预期花费' })
  })

  it('关闭必须选结论；误报记为 IGNORED 状态但结论保留 FALSE_POSITIVE（误报率据此统计）；处理完成的待办置为 DONE', async () => {
    const prisma = await boot(['alerts.handle'])
    expect((await harness!.call('POST', '/alerts/a1/close', { body: {} })).status).toBe(422)
    const fp = await harness!.call('POST', '/alerts/a1/close', { body: { conclusion: 'FALSE_POSITIVE', note: '数据延迟导致' } })
    expect(fp.json.data.status).toBe('IGNORED')
    expect(prisma.alertInstance.updateMany.mock.calls[0][0].data).toMatchObject({ closeConclusion: 'FALSE_POSITIVE' })
    const done = await harness!.call('POST', '/alerts/a1/close', { body: { conclusion: 'HANDLED' } })
    expect(done.json.data.status).toBe('HANDLED')
    expect(prisma.workItem.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'DONE', closeConclusion: 'HANDLED' })
  })

  it('已结束的预警不能再关闭或忽略（409）；条件更新没命中说明被他人抢先处理（409）', async () => {
    const prisma = await boot(['alerts.handle'])
    prisma.alertInstance.findFirst.mockResolvedValue(instance({ status: 'HANDLED' }))
    expect((await harness!.call('POST', '/alerts/a1/close', { body: { conclusion: 'HANDLED' } })).status).toBe(409)
    prisma.alertInstance.findFirst.mockResolvedValue(instance())
    prisma.alertInstance.updateMany.mockResolvedValue({ count: 0 })
    expect((await harness!.call('POST', '/alerts/a1/ignore', { body: { reason: '已知问题' } })).status).toBe(409)
  })

  it('分派给在职成员：改待办负责人并通知；没有待办时新建待办并回写预警', async () => {
    const prisma = await boot(['alerts.handle'])
    const res = await harness!.call('POST', '/alerts/a1/assign', { body: { assigneeId: 'user-2' } })
    expect(res.status).toBe(200)
    expect(prisma.workItem.update.mock.calls[0][0].data).toMatchObject({ ownerId: 'user-2', status: 'PENDING' })
    expect(prisma.assignment.upsert).toHaveBeenCalledTimes(1)
    prisma.alertInstance.findFirst.mockResolvedValue(instance({ workItemId: null }))
    await harness!.call('POST', '/alerts/a1/assign', { body: { assigneeId: 'user-2' } })
    expect(prisma.workItem.create.mock.calls[0][0].data).toMatchObject({ source: 'ALERT', sourceAlertId: 'a1', ownerId: 'user-2', severity: 'WARNING' })
    expect(prisma.alertInstance.update.mock.calls[0][0]).toMatchObject({ where: { id: 'a1' }, data: { workItemId: 'w-new' } })
  })

  it('分派对象不是在职成员返回 422', async () => {
    const base = sessionStub(['alerts.handle'])
    const first = base.membership.findFirst
    const membershipFindFirst = vi.fn().mockImplementation(async (args: { select?: { userId?: boolean } }) => (args?.select?.userId ? null : first()))
    await boot(['alerts.handle'], { membership: { findFirst: membershipFindFirst, findMany: none() } })
    const res = await harness!.call('POST', '/alerts/a1/assign', { body: { assigneeId: 'ghost' } })
    expect(res.status).toBe(422)
  })
})

describe('预警规则', () => {
  it('列表带阈值、默认阈值、范围支持、质量统计（误报率、平均处理时长）与版本；没有被处理的预警时误报率是 null', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertInstance.findMany.mockResolvedValue([
      { ruleId: 'r1', status: 'IGNORED', closeConclusion: 'FALSE_POSITIVE', firstTriggeredAt: T0, resolvedAt: new Date(T0.getTime() + 2 * 3_600_000) },
      { ruleId: 'r1', status: 'HANDLED', closeConclusion: 'HANDLED', firstTriggeredAt: T0, resolvedAt: new Date(T0.getTime() + 4 * 3_600_000) },
      { ruleId: 'r1', status: 'NEW', closeConclusion: null, firstTriggeredAt: T0, resolvedAt: null },
    ])
    prisma.alertRuleVersion.findMany.mockResolvedValue([
      {
        ruleId: 'r1',
        versionNo: 2,
        conditionJson: { type: 'ads.high-spend-low-return', params: { windowDays: 7 }, severity: 'CRITICAL', cooldownMinutes: 60, enabled: true, scope: {} },
        changedBy: 'user-1',
        changeReason: '加严',
        createdAt: T0,
      },
      { ruleId: 'r1', versionNo: 1, conditionJson: { type: 'ads.high-spend-low-return', params: { windowDays: 7 } }, changedBy: 'system', changeReason: '系统预置规则', createdAt: T0 },
    ])
    const res = await harness!.call('GET', '/alerts/rules')
    expect(res.status).toBe(200)
    const view = res.json.data.items[0]
    expect(view).toMatchObject({ code: 'ADS_HIGH_SPEND_LOW_RETURN', custom: false, version: 4, scopeSupport: { stores: true, skus: false } })
    expect(view.stats).toMatchObject({ hits: 3, open: 1, handled: 2, falsePositive: 1, falsePositiveRate: 0.5, avgHandleHours: 3, truncated: false })
    expect(view.versions[0]).toMatchObject({ versionNo: 2, changedByName: '甲', severity: 'CRITICAL' })
    expect(view.versions[1]).toMatchObject({ changedByName: '系统', severity: null, scope: null })
    expect(res.json.data.unconnected.length).toBe(1)
    expect(res.json.data.categories).toEqual(['家居/厨房'])
    expect(res.json.data.can.manage).toBe(false)
  })

  it('没有规则时是 NO_DATA；规则没有被处理的预警时误报率与平均时长是 null', async () => {
    const prisma = await boot(['alerts.read'])
    prisma.alertInstance.findMany.mockResolvedValue([])
    const res = await harness!.call('GET', '/alerts/rules')
    expect(res.json.data.items[0].stats).toMatchObject({ hits: 0, handled: 0, falsePositiveRate: null, avgHandleHours: null })
    prisma.alertRule.findMany.mockResolvedValue([])
    expect((await harness!.call('GET', '/alerts/rules')).json.data.state).toBe('NO_DATA')
  })

  it('改规则需要 alerts.manage；先鉴权再校验参数', async () => {
    await boot(['alerts.read', 'alerts.handle'])
    expect((await harness!.call('PATCH', '/alerts/rules/r1', { body: {} })).status).toBe(403)
  })

  it('改阈值：超出范围、不认识的键、没有改动、没填原因都被拒绝', async () => {
    const prisma = await boot(['alerts.manage'])
    const patch = (body: unknown) => harness!.call('PATCH', '/alerts/rules/r1', { body })
    const range = await patch({ version: 4, changeReason: '调整', params: { windowDays: 999 } })
    expect(range.status).toBe(422)
    expect(range.json.error.fieldErrors['params.windowDays']).toBeTruthy()
    expect((await patch({ version: 4, changeReason: '调整', params: { nope: 1 } })).status).toBe(422)
    expect((await patch({ version: 4, changeReason: '调整', params: { windowDays: 7 } })).status).toBe(422)
    expect((await patch({ version: 4, params: { windowDays: 14 } })).status).toBe(422)
    expect(prisma.alertRule.updateMany).not.toHaveBeenCalled()
  })

  it('改阈值成功：版本号加一，版本快照存全部设置，审计带原因', async () => {
    const prisma = await boot(['alerts.manage'])
    prisma.alertRule.findFirst.mockImplementation(async (args: { select?: unknown }) => (args?.select ? { version: 4 } : rule({ currentVersion: 3, version: 5 })))
    const res = await harness!.call('PATCH', '/alerts/rules/r1', {
      body: { version: 4, changeReason: '大促期间放宽', params: { minSpend: 80 }, severity: 'CRITICAL', scope: { sellerAccountIds: ['s1'], quiet: { start: '22:00', end: '07:00' } } },
    })
    expect(res.status).toBe(200)
    expect(prisma.alertRule.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'r1', tenantId: 'tenant-1', version: 4 } })
    const data = prisma.alertRule.updateMany.mock.calls[0][0].data
    expect(data).toMatchObject({ severity: 'CRITICAL', currentVersion: 4 })
    expect(data.conditionJson.params).toMatchObject({ minSpend: 80, windowDays: 7 })
    const snapshot = prisma.alertRuleVersion.create.mock.calls[0][0].data
    expect(snapshot).toMatchObject({ versionNo: 4, changedBy: 'user-1', changeReason: '大促期间放宽' })
    expect(snapshot.conditionJson).toMatchObject({ severity: 'CRITICAL', scope: { sellerAccountIds: ['s1'], quiet: { start: '22:00', end: '07:00' } } })
  })

  it('别人先改过（乐观锁没命中）返回 409，不写版本', async () => {
    const prisma = await boot(['alerts.manage'])
    prisma.alertRule.updateMany.mockResolvedValue({ count: 0 })
    prisma.alertRule.findFirst.mockImplementation(async (args: { select?: unknown }) => (args?.select ? { version: 9 } : rule()))
    const res = await harness!.call('PATCH', '/alerts/rules/r1', { body: { version: 4, changeReason: '调整', enabled: false } })
    expect(res.status).toBe(409)
    expect(prisma.alertRuleVersion.create).not.toHaveBeenCalled()
  })

  it('范围里的店铺或负责人不属于本企业返回 422', async () => {
    const prisma = await boot(['alerts.manage'])
    prisma.sellerAccount.findMany.mockResolvedValue([])
    const res = await harness!.call('PATCH', '/alerts/rules/r1', { body: { version: 4, changeReason: '调整', scope: { sellerAccountIds: ['other-tenant-store'] } } })
    expect(res.status).toBe(422)
    expect(res.json.error.fieldErrors['scope.sellerAccountIds']).toBeTruthy()
  })

  it('新建自定义规则：沿用评估器与默认阈值，编号 CUSTOM_ 递增，第一个版本写入快照', async () => {
    const prisma = await boot(['alerts.manage'])
    prisma.alertRule.findMany.mockResolvedValue([{ code: 'CUSTOM_001' }, { code: 'CUSTOM_004' }])
    prisma.alertRule.create.mockResolvedValue({ id: 'r-new', currentVersion: 1, version: 1 })
    const res = await harness!.call('POST', '/alerts/rules', { body: { type: 'ads.cpc-surge', name: '核心词点击成本突增', params: { ratio: 2 }, scope: { skus: ['SKU-1'] } } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ id: 'r-new', code: 'CUSTOM_005' })
    expect(prisma.alertRule.create.mock.calls[0][0].data).toMatchObject({ code: 'CUSTOM_005', domain: 'ADS', name: '核心词点击成本突增' })
    expect(prisma.alertRuleVersion.create.mock.calls[0][0].data).toMatchObject({ versionNo: 1, changeReason: '新建自定义规则' })
  })

  it('新建：不支持的类型 422；超过 50 条上限 422', async () => {
    const prisma = await boot(['alerts.manage'])
    expect((await harness!.call('POST', '/alerts/rules', { body: { type: 'made.up', name: '随便' } })).status).toBe(422)
    prisma.alertRule.findMany.mockResolvedValue(Array.from({ length: 50 }, (_, index) => ({ code: `CUSTOM_${String(index + 1).padStart(3, '0')}` })))
    expect((await harness!.call('POST', '/alerts/rules', { body: { type: 'ads.cpc-surge', name: '第五十一条' } })).status).toBe(422)
  })
})
