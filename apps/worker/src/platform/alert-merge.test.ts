import { describe, expect, it, vi } from 'vitest'
import { AlertEvaluatorRegistry, evaluateTenantRules, type AlertHit } from './alert-evaluate'

// 预警合并（P6-15）：同一规则同一对象在未处理时再次命中并入上一条（次数加一、刷新最近触发时间）；
// 冷却期之内安静并入；冷却期之外并入后清掉所有人的已读并提醒负责人一次；处理之后冷却期内不新建、冷却期外新建一条。

const NOW = new Date('2026-10-22T08:00:00Z')
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const OWNER_ROLE = { permissions: ['*'], system: true, version: 2, fieldPermissions: [] }

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'rule1',
  code: 'ADS_CPC_SURGE',
  domain: 'ADS',
  name: '单次点击成本突增',
  severity: 'WARNING',
  cooldownMinutes: 60,
  currentVersion: 1,
  enabled: true,
  conditionJson: { type: 'test.hits' },
  scopeJson: {},
  ...over,
})
const hit = (id = 'A', over: Partial<AlertHit> = {}): AlertHit => ({ entityType: 'AD_CAMPAIGN', entityId: id, evidence: { cpc: 2 }, title: `活动 ${id} 点击成本突增`, ...over })
const open = (over: Record<string, unknown> = {}) => ({
  id: 'a-open',
  ruleId: 'rule1',
  dedupKey: 'rule1:AD_CAMPAIGN:A',
  status: 'NEW',
  triggerCount: 2,
  lastTriggeredAt: minutesAgo(10),
  workItemId: 'w1',
  ...over,
})

function makeDb(opts: { rules?: Array<Record<string, unknown>>; instances?: Array<Record<string, any>>; workOwner?: string | null; failClearRead?: boolean } = {}) {
  const instances = opts.instances ?? []
  const notifications: Array<Record<string, any>> = []
  const works: Array<Record<string, any>> = []
  const match = (row: Record<string, any>, where: Record<string, any>) =>
    (!where.ruleId || row.ruleId === where.ruleId) &&
    (!where.dedupKey || (typeof where.dedupKey === 'string' ? row.dedupKey === where.dedupKey : !where.dedupKey.notIn.includes(row.dedupKey))) &&
    (!where.status || (where.status.in ? where.status.in.includes(row.status) : !where.status.notIn.includes(row.status))) &&
    (!where.lastTriggeredAt || row.lastTriggeredAt > where.lastTriggeredAt.gt) &&
    (!where.id || (where.id.in ? where.id.in.includes(row.id) : row.id === where.id))
  const tx = {
    alertInstance: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `a${instances.length + 1}`, triggerCount: 1, lastTriggeredAt: NOW, ...data }
        instances.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = instances.find(item => item.id === where.id)!
        const { triggerCount, ...rest } = data
        Object.assign(row, rest, triggerCount ? { triggerCount: row.triggerCount + 1 } : {})
      }),
    },
    workItem: { create: vi.fn(async ({ data }: any) => (works.push({ id: `w-new${works.length + 1}`, ...data }), works[works.length - 1])) },
  }
  const alertRead = {
    deleteMany: vi.fn(async () => {
      if (opts.failClearRead) throw new Error('db down')
      return { count: 2 }
    }),
  }
  const db = {
    alertRule: { findMany: vi.fn(async () => opts.rules ?? [rule()]) },
    tenantSetting: { findFirst: vi.fn(async () => null) },
    tenant: { findFirst: vi.fn(async () => ({ timezone: 'UTC' })) },
    sellerAccount: { findMany: vi.fn(async () => []) },
    fbaProduct: { findMany: vi.fn(async () => []) },
    membership: {
      findMany: vi.fn(async () => [{ userId: 'owner', role: OWNER_ROLE }]),
      findFirst: vi.fn(async () => null),
    },
    notification: { createMany: vi.fn(async ({ data }: any) => (notifications.push(...data), { count: data.length })) },
    workItem: { ...tx.workItem, findFirst: vi.fn(async () => (opts.workOwner === null ? null : { id: 'w1', ownerId: opts.workOwner ?? 'work-owner' })) },
    alertRead,
    alertInstance: {
      ...tx.alertInstance,
      findFirst: vi.fn(async ({ where }: any) => instances.find(row => match(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => instances.filter(row => match(row, where))),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = instances.filter(row => match(row, where))
        rows.forEach(row => Object.assign(row, data))
        return { count: rows.length }
      }),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  }
  return { db: db as never, instances, notifications, works, alertRead }
}

const run = (db: never, hits: AlertHit[] = [hit()]) =>
  evaluateTenantRules({ db, registry: new AlertEvaluatorRegistry().register({ type: 'test.hits', evaluate: async () => hits }), now: () => NOW }, 't1')

describe('预警合并：未处理时再次命中', () => {
  it('冷却期之内：并入上一条，次数加一、刷新最近触发时间；不通知、不动已读、不建待办', async () => {
    const { db, instances, notifications, works, alertRead } = makeDb({ instances: [open()] })
    expect(await run(db)).toMatchObject({ created: 0, refreshed: 1, errors: 0 })
    expect(instances).toHaveLength(1)
    expect(instances[0]).toMatchObject({ triggerCount: 3, lastTriggeredAt: NOW, evidenceJson: { cpc: 2 } })
    expect(notifications).toHaveLength(0)
    expect(works).toHaveLength(0)
    expect(alertRead.deleteMany).not.toHaveBeenCalled()
  })

  it('冷却期之外（距上次命中超过冷却分钟数）、上一条仍没处理：并入后清掉所有人的已读，并提醒待办负责人一次', async () => {
    const { db, instances, notifications, alertRead } = makeDb({ instances: [open({ lastTriggeredAt: minutesAgo(120), status: 'ACKED' })] })
    expect(await run(db)).toMatchObject({ created: 0, refreshed: 1 })
    expect(instances).toHaveLength(1)
    expect(instances[0]).toMatchObject({ triggerCount: 3, lastTriggeredAt: NOW, status: 'ACKED' })
    expect(alertRead.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't1', alertId: 'a-open' } })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ userId: 'work-owner', kind: 'ALERT_RULE', severity: 'WARNING', dedupKey: 'alert-rule-merge:a-open:2026-10-22' })
    expect(notifications[0].body).toContain('累计 3 次')
    // 紧接着的下一轮（距上次命中只有 0 分钟）又回到冷却期之内：不再提醒
    await run(db)
    expect(notifications).toHaveLength(1)
    expect(instances[0].triggerCount).toBe(4)
  })

  it('冷却分钟数为 0 的规则没有冷却期：一律安静并入', async () => {
    const { db, notifications, alertRead } = makeDb({ rules: [rule({ cooldownMinutes: 0 })], instances: [open({ lastTriggeredAt: minutesAgo(600) })] })
    await run(db)
    expect(notifications).toHaveLength(0)
    expect(alertRead.deleteMany).not.toHaveBeenCalled()
  })

  it('静默时段内不提醒（但已读照样清掉）；严重级别不受静默限制', async () => {
    const quiet = { start: '22:00', end: '08:30' }
    const silent = makeDb({ rules: [rule({ scopeJson: { quiet } })], instances: [open({ lastTriggeredAt: minutesAgo(120) })] })
    await run(silent.db)
    expect(silent.alertRead.deleteMany).toHaveBeenCalledTimes(1)
    expect(silent.notifications).toHaveLength(0)
    const critical = makeDb({ rules: [rule({ severity: 'CRITICAL', scopeJson: { quiet } })], instances: [open({ lastTriggeredAt: minutesAgo(120) })] })
    await run(critical.db)
    expect(critical.notifications).toHaveLength(1)
  })

  it('上一条没有关联待办：只清已读，不通知', async () => {
    const { db, notifications, alertRead } = makeDb({ instances: [open({ lastTriggeredAt: minutesAgo(120), workItemId: null })] })
    await run(db)
    expect(alertRead.deleteMany).toHaveBeenCalledTimes(1)
    expect(notifications).toHaveLength(0)
  })

  it('重新提醒失败只是尽力而为：并入照常完成，不计入规则错误数', async () => {
    const { db, instances, notifications } = makeDb({ instances: [open({ lastTriggeredAt: minutesAgo(120) })], failClearRead: true })
    expect(await run(db)).toMatchObject({ refreshed: 1, errors: 0 })
    expect(instances[0].triggerCount).toBe(3)
    expect(notifications).toHaveLength(0)
  })

  it('通知对象沿用规则配置：负责人之外再加规则里指定的在职成员', async () => {
    const { db, notifications } = makeDb({ rules: [rule({ scopeJson: { notifyUserIds: ['ops'] } })], instances: [open({ lastTriggeredAt: minutesAgo(120) })] })
    ;(db as any).membership.findMany.mockImplementation(async ({ where }: any) => (where.userId ? [{ userId: 'ops' }] : [{ userId: 'owner', role: OWNER_ROLE }]))
    await run(db)
    expect(notifications.map(item => item.userId).sort()).toEqual(['ops', 'work-owner'])
  })
})

describe('预警合并：处理之后', () => {
  it('处理后冷却期内再次命中：不新建也不并入；冷却期外新建一条，没有任何已读记录被清', async () => {
    const closed = open({ id: 'a-old', status: 'HANDLED', lastTriggeredAt: minutesAgo(30) })
    const cooling = makeDb({ instances: [closed] })
    expect(await run(cooling.db)).toMatchObject({ created: 0, skippedCooldown: 1 })
    expect(cooling.instances).toHaveLength(1)
    expect(cooling.instances[0].triggerCount).toBe(2)

    const expired = makeDb({ instances: [{ ...closed, lastTriggeredAt: minutesAgo(180) }] })
    expect(await run(expired.db)).toMatchObject({ created: 1, skippedCooldown: 0 })
    expect(expired.instances).toHaveLength(2)
    expect(expired.instances[1]).toMatchObject({ status: 'NEW', dedupKey: 'rule1:AD_CAMPAIGN:A', workItemId: 'w-new1' })
    expect(expired.instances[0].triggerCount).toBe(2)
    expect(expired.alertRead.deleteMany).not.toHaveBeenCalled()
  })

  it('不同对象各自合并，互不影响', async () => {
    const { db, instances } = makeDb({ instances: [open(), open({ id: 'a-b', dedupKey: 'rule1:AD_CAMPAIGN:B', triggerCount: 7 })] })
    await run(db, [hit('A')])
    expect(instances.find(row => row.id === 'a-open')?.triggerCount).toBe(3)
    expect(instances.find(row => row.id === 'a-b')?.triggerCount).toBe(7)
    expect(instances.find(row => row.id === 'a-b')?.status).toBe('AUTO_CLOSED')
  })
})
