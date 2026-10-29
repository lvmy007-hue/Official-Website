import { describe, expect, it, vi } from 'vitest'
import { AlertEvaluatorRegistry, evaluateAllTenants, evaluateTenantRules, type AlertEvaluator, type AlertHit } from './alert-evaluate'

const NOW = new Date('2026-10-22T08:00:00Z')
const OWNER_ROLE = { permissions: ['*'], system: true, version: 2, fieldPermissions: [] }

const rule = (over: Record<string, any> = {}) => ({
  id: 'rule1',
  code: 'DATA_STALE',
  domain: 'DATA',
  name: '数据新鲜度',
  severity: 'WARNING',
  cooldownMinutes: 60,
  currentVersion: 3,
  enabled: true,
  conditionJson: { type: 'test.hits' },
  scopeJson: {},
  ...over,
})
const hit = (id: string, over: Partial<AlertHit> = {}): AlertHit => ({ entityType: 'SKU', entityId: id, evidence: { hoursBehind: 30 }, title: `SKU ${id} 异常`, suggestedAction: '检查同步', ...over })

function makeDb(
  opts: { rules?: Array<Record<string, any>>; instances?: Array<Record<string, any>>; sla?: unknown; members?: Array<Record<string, any>>; timezone?: string; stores?: string[]; skus?: string[] } = {},
) {
  const instances = opts.instances ?? []
  const works: Array<Record<string, any>> = []
  const notifications: Array<Record<string, any>> = []
  const digests: Array<Record<string, any>> = []
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
    workItem: { create: vi.fn(async ({ data }: any) => (works.push({ id: `w${works.length + 1}`, ...data }), works[works.length - 1])) },
  }
  const db = {
    alertRule: { findMany: vi.fn(async () => opts.rules ?? [rule()]) },
    tenantSetting: { findFirst: vi.fn(async () => (opts.sla ? { valueJson: opts.sla } : null)) },
    tenant: { findFirst: vi.fn(async () => ({ timezone: opts.timezone ?? 'UTC' })) },
    sellerAccount: { findMany: vi.fn(async () => (opts.stores ?? []).map(id => ({ id }))) },
    fbaProduct: { findMany: vi.fn(async () => (opts.skus ?? []).map(sellerSku => ({ sellerSku }))) },
    membership: {
      findMany: vi.fn(async () => opts.members ?? [{ userId: 'owner', role: OWNER_ROLE }]),
      findFirst: vi.fn(async ({ where }: any) => (where.userId === 'ops' ? { userId: 'ops' } : null)),
    },
    alertDigest: {
      findFirst: vi.fn(async ({ where }: any) => digests.find(row => row.dedupKey === where.dedupKey) ?? null),
      create: vi.fn(async ({ data }: any) => (digests.push({ id: `d${digests.length + 1}`, status: 'PENDING', ...data }), digests[digests.length - 1])),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = digests.filter(row => row.id === where.id && row.status === where.status)
        rows.forEach(row => Object.assign(row, data))
        return { count: rows.length }
      }),
    },
    notification: { createMany: vi.fn(async ({ data }: any) => (notifications.push(...data), { count: data.length })) },
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
  return { db: db as never, instances, works, notifications, digests, raw: db }
}

const registryOf = (hits: AlertHit[] | (() => AlertHit[])) => new AlertEvaluatorRegistry().register({ type: 'test.hits', evaluate: async () => (typeof hits === 'function' ? hits() : hits) })
const run = (db: never, registry: AlertEvaluatorRegistry) => evaluateTenantRules({ db, registry, now: () => NOW }, 't1')

describe('评估器注册', () => {
  it('同一类型不能重复注册；能按类型找到', () => {
    const registry = registryOf([])
    expect(registry.find('test.hits')).toBeDefined()
    expect(registry.find('nope')).toBeUndefined()
    expect(() => registry.register({ type: 'test.hits', evaluate: async () => [] } as AlertEvaluator)).toThrow('重复')
  })
})

describe('预警评估：命中之后', () => {
  it('新命中：建预警实例、待办（来源预警、按严重度的时限）并通知负责人', async () => {
    const { db, instances, works, notifications } = makeDb()
    const result = await run(db, registryOf([hit('A')]))
    expect(result).toMatchObject({ rules: 1, created: 1, refreshed: 0, resolved: 0 })
    expect(instances[0]).toMatchObject({ ruleId: 'rule1', ruleVersionNo: 3, entityType: 'SKU', entityId: 'A', severity: 'WARNING', status: 'NEW', dedupKey: 'rule1:SKU:A', workItemId: 'w1' })
    expect(works[0]).toMatchObject({
      source: 'ALERT',
      sourceAlertId: 'a1',
      ruleCode: 'DATA_STALE',
      ownerId: 'owner',
      createdBy: 'owner',
      severity: 'WARNING',
      priority: 'HIGH',
      title: 'SKU A 异常',
      suggestedAction: '检查同步',
    })
    expect(works[0].dueAt).toEqual(new Date(NOW.getTime() + 24 * 3_600_000))
    expect(notifications[0]).toMatchObject({ userId: 'owner', kind: 'ALERT_RULE', title: 'SKU A 异常', body: '检查同步', severity: 'WARNING' })
  })

  it('待办时限用企业设置覆盖默认值；严重预警优先级为紧急', async () => {
    const { db, works } = makeDb({ rules: [rule({ severity: 'CRITICAL' })], sla: { CRITICAL: 2 } })
    await run(db, registryOf([hit('A')]))
    expect(works[0]).toMatchObject({ priority: 'URGENT' })
    expect(works[0].dueAt).toEqual(new Date(NOW.getTime() + 2 * 3_600_000))
  })

  it('负责人：规则范围指定了在职成员就用他；已离职则退回管理员', async () => {
    const named = makeDb({ rules: [rule({ scopeJson: { ownerId: 'ops' } })] })
    await run(named.db, registryOf([hit('A')]))
    expect(named.works[0].ownerId).toBe('ops')
    const gone = makeDb({ rules: [rule({ scopeJson: { ownerId: 'left' } })] })
    await run(gone.db, registryOf([hit('A')]))
    expect(gone.works[0].ownerId).toBe('owner')
  })

  it('没有任何可指派的成员：仍建预警实例，但不建待办也不通知', async () => {
    const { db, instances, works, notifications } = makeDb({ members: [] })
    await run(db, registryOf([hit('A')]))
    expect(instances).toHaveLength(1)
    expect(works).toHaveLength(0)
    expect(notifications).toHaveLength(0)
  })

  it('重复命中：只刷新次数、最近命中时间与证据，不重复建待办与通知', async () => {
    const { db, instances, works, notifications } = makeDb()
    const registry = registryOf([hit('A')])
    await run(db, registry)
    const again = await run(db, registryOf([hit('A', { evidence: { hoursBehind: 40 } })]))
    expect(again).toMatchObject({ created: 0, refreshed: 1 })
    expect(instances).toHaveLength(1)
    expect(instances[0]).toMatchObject({ triggerCount: 2, evidenceJson: { hoursBehind: 40 } })
    expect(works).toHaveLength(1)
    expect(notifications).toHaveLength(1)
  })

  it('同一轮里重复的命中只算一次；每条规则最多处理 500 条命中', async () => {
    const dup = makeDb()
    await run(dup.db, registryOf([hit('A'), hit('A')]))
    expect(dup.instances).toHaveLength(1)
    const many = makeDb()
    const result = await run(many.db, registryOf(Array.from({ length: 600 }, (_, index) => hit(`S${index}`))))
    expect(result.created).toBe(500)
  })

  it('已处理（恢复或忽略）后在冷却时间内再次命中：不再新建；超过冷却时间则重新预警', async () => {
    const recent = { id: 'old', ruleId: 'rule1', dedupKey: 'rule1:SKU:A', status: 'IGNORED', lastTriggeredAt: new Date(NOW.getTime() - 30 * 60_000) }
    const cooling = makeDb({ instances: [recent] })
    expect(await run(cooling.db, registryOf([hit('A')]))).toMatchObject({ created: 0, skippedCooldown: 1 })
    const expired = makeDb({ instances: [{ ...recent, lastTriggeredAt: new Date(NOW.getTime() - 120 * 60_000) }] })
    expect(await run(expired.db, registryOf([hit('A')]))).toMatchObject({ created: 1, skippedCooldown: 0 })
  })

  it('命中消失：开放的预警实例自动标记已恢复；待办保持不变', async () => {
    const { db, instances, works } = makeDb()
    await run(db, registryOf([hit('A'), hit('B')]))
    const result = await run(db, registryOf([hit('A')]))
    expect(result.resolved).toBe(1)
    expect(instances.find(row => row.entityId === 'B')).toMatchObject({ status: 'AUTO_CLOSED', resolvedAt: NOW })
    expect(instances.find(row => row.entityId === 'A')?.status).toBe('NEW')
    expect(works).toHaveLength(2)
  })

  it('并发的另一个进程刚创建了同一条开放实例（唯一约束冲突）：当作已存在，不报错', async () => {
    const { db, raw } = makeDb()
    raw.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    expect(await run(db, registryOf([hit('A')]))).toMatchObject({ created: 0, refreshed: 1, errors: 0 })
  })
})

describe('预警评估：展示列、通知对象、静默时段与范围展开（P5-01）', () => {
  it('预警实例带标题、对象名称、建议与影响金额区间；重新命中时刷新为最新值', async () => {
    const { db, instances } = makeDb()
    const first = hit('A', { entityLabel: '店铺甲', impact: { min: 30, max: 10, currency: 'EUR' } })
    await run(db, registryOf([first]))
    expect(instances[0]).toMatchObject({ title: 'SKU A 异常', entityLabel: '店铺甲', suggestedAction: '检查同步', impactMin: 10, impactMax: 30, currency: 'EUR' })
    await run(db, registryOf([hit('A', { title: '新标题', impact: undefined })]))
    expect(instances[0]).toMatchObject({ title: '新标题', entityLabel: null, impactMin: null, impactMax: null, currency: null })
  })

  it('通知对象：负责人之外再通知规则里配置的在职成员；没配置只通知负责人', async () => {
    const members = [
      { userId: 'owner', role: OWNER_ROLE },
      { userId: 'ops', role: { permissions: [], system: false, version: 1, fieldPermissions: [] } },
    ]
    const plain = makeDb({ members })
    await run(plain.db, registryOf([hit('A')]))
    expect(plain.notifications.map(item => item.userId)).toEqual(['owner'])
    const extra = makeDb({ members, rules: [rule({ scopeJson: { notifyUserIds: ['ops'] } })] })
    await run(extra.db, registryOf([hit('A')]))
    expect(extra.notifications.map(item => item.userId).sort()).toEqual(['ops', 'owner'])
  })

  it('静默时段内（企业时区）不发站内通知，预警与待办照常生成；严重级别不受静默限制', async () => {
    const quiet = { start: '22:00', end: '08:30' }
    // 08:00 UTC 在 UTC 时区的静默时段内
    const silent = makeDb({ rules: [rule({ scopeJson: { quiet } })] })
    await run(silent.db, registryOf([hit('A')]))
    expect(silent.instances).toHaveLength(1)
    expect(silent.works).toHaveLength(1)
    expect(silent.notifications).toHaveLength(0)
    // 静默期的通知不丢：并入静默批次，静默结束后补发一条汇总（P6-16）
    expect(silent.digests).toEqual([expect.objectContaining({ kind: 'QUIET', status: 'PENDING', itemCount: 1, dedupKey: 'quiet:rule1:pending' })])
    // 同一时刻换成东八区是 16:00，不在静默时段内
    const other = makeDb({ rules: [rule({ scopeJson: { quiet } })], timezone: 'Asia/Shanghai' })
    await run(other.db, registryOf([hit('A')]))
    expect(other.notifications).toHaveLength(1)
    const critical = makeDb({ rules: [rule({ severity: 'CRITICAL', scopeJson: { quiet } })] })
    await run(critical.db, registryOf([hit('A')]))
    expect(critical.notifications).toHaveLength(1)
  })

  it('范围里的主体与品类在评估前展开成店铺与 SKU，评估器拿到展开后的范围', async () => {
    const seen: Array<Record<string, unknown>> = []
    const registry = new AlertEvaluatorRegistry().register({
      type: 'test.hits',
      evaluate: async ({ rule: view }) => {
        seen.push(view.scope)
        return []
      },
    })
    const { db } = makeDb({ rules: [rule({ scopeJson: { legalEntityIds: ['e1'], sellerAccountIds: ['s9'], categories: ['Home'], ownerId: 'ops' } })], stores: ['s1', 's2'], skus: ['K1'] })
    await run(db, registry)
    expect(seen[0]).toMatchObject({ sellerAccountIds: ['s9', 's1', 's2'], skus: ['K1'], ownerId: 'ops' })
    // 展开后一个也找不到：用占位值而不是空列表（空列表在评估器里等于不限制）
    const empty = makeDb({ rules: [rule({ scopeJson: { legalEntityIds: ['e1'], categories: ['Home'] } })] })
    await run(empty.db, registry)
    expect(seen[1]).toMatchObject({ sellerAccountIds: ['__NO_MATCH__'], skus: ['__NO_MATCH__'] })
  })
})

describe('预警评估：规则与调度', () => {
  it('没有评估器的规则、停用的规则、条件格式不对的规则都不评估；没有任何评估器时不访问数据库', async () => {
    const { db, raw } = makeDb({ rules: [rule({ conditionJson: { type: 'unknown.type' } }), rule({ id: 'r2', conditionJson: 'bad' }), rule({ id: 'r3', conditionJson: null })] })
    expect(await run(db, registryOf([hit('A')]))).toMatchObject({ rules: 0, created: 0 })
    const empty = await run(db, new AlertEvaluatorRegistry())
    expect(empty.rules).toBe(0)
    expect(raw.alertRule.findMany).toHaveBeenCalledTimes(1)
    expect(raw.alertRule.findMany.mock.calls[0][0].where).toEqual({ tenantId: 't1', enabled: true })
  })

  it('一条规则评估出错不影响其他规则，错误只计数', async () => {
    const { db, instances } = makeDb({ rules: [rule({ id: 'bad', conditionJson: { type: 'boom' } }), rule({ id: 'good', conditionJson: { type: 'test.hits' } })] })
    const registry = registryOf([hit('A')]).register({
      type: 'boom',
      evaluate: async () => {
        throw new Error('x')
      },
    })
    expect(await run(db, registry)).toMatchObject({ rules: 2, created: 1, errors: 1 })
    expect(instances[0].ruleId).toBe('good')
  })

  it('定时扫描：没有评估器时直接返回；有评估器时逐个试用/正常企业评估，单个企业失败不影响其他企业', async () => {
    const { db } = makeDb()
    const findMany = vi.fn(async () => [{ id: 't1' }, { id: 't2' }])
    const logger = { info: vi.fn(), warn: vi.fn() }
    expect(await evaluateAllTenants({ systemDb: { tenant: { findMany } } as never, db, registry: new AlertEvaluatorRegistry(), logger })).toEqual({ tenants: 0, created: 0 })
    expect(findMany).not.toHaveBeenCalled()
    let first = true
    const registry = registryOf(() => {
      if (first) {
        first = false
        return [hit('A')]
      }
      return [hit('B')]
    })
    const result = await evaluateAllTenants({ systemDb: { tenant: { findMany } } as never, db, registry, now: () => NOW, logger })
    expect(findMany.mock.calls[0][0].where).toEqual({ lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } })
    expect(result).toEqual({ tenants: 2, created: 2 })
  })
})
