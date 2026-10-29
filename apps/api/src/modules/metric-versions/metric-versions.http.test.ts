import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 口径版本接口（P6-31）：权限先于参数校验、再次验证身份、读取默认口径、提交与审批的状态规则。
// 提交到生效、唯一生效版本、差异报告与企业隔离在真实库测试 apps/api/src/testing/metric-versions.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const row = (over: Record<string, unknown> = {}) => ({
  id: 'mv-1',
  kind: 'PROFIT_FORMULA',
  versionNo: 1,
  config: { gross: ['REVENUE', 'COMMISSION'], denominator: ['REVENUE'], _meta: { reason: '调整', summary: '毛利润不再计入：退款' } },
  status: 'PENDING_APPROVAL',
  effectiveFrom: null,
  approvedBy: null,
  createdBy: 'user-1',
  version: 1,
  createdAt: new Date('2026-10-26T00:00:00Z'),
  ...over,
})

interface Options {
  /** 当前生效的版本行（按 kind）。 */
  active?: Array<Record<string, unknown>>
  /** 待审批的版本行。 */
  pending?: Record<string, unknown> | null
  /** 同类型最新版本号。 */
  latest?: number
  /** 按编号取的版本行（审批、差异报告）。 */
  byId?: Record<string, unknown> | null
}

const open = async (permissions: string[], options: Options = {}) => {
  await harness?.close()
  const guards = createWriteGuardStubs()
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    ...guards,
    stepUpVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    accountingPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    membership: {
      ...sessionStub(permissions).membership,
      findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', role: { permissions: ['*'], version: 2 }, user: { displayName: '运营小李', email: 'l@example.com' } }]),
    },
    approvalRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ap-1' }),
      update: vi.fn().mockResolvedValue({ id: 'ap-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    metricVersion: {
      findMany: vi.fn().mockImplementation(async (args: { where?: { status?: unknown } }) => (args.where?.status === 'ACTIVE' ? (options.active ?? []) : [])),
      findFirst: vi.fn().mockImplementation(async (args: { where?: { status?: unknown; id?: string }; select?: { versionNo?: boolean } }) => {
        if (args.where?.id) return options.byId === undefined ? null : options.byId
        if (args.where?.status === 'PENDING_APPROVAL') return options.pending ?? null
        return options.latest ? { versionNo: options.latest } : null
      }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'mv-new', versionNo: (options.latest ?? 0) + 1, version: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  }
  prisma.$transaction = vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])))
  harness = await createTestApp(prisma)
  return { prisma: prisma as Record<string, any>, call: harness.call }
}

const FORMULA_BODY = { version: 0, gross: ['REVENUE', 'COMMISSION', 'PRODUCT_COST'], denominator: ['REVENUE'], reason: '毛利润只看三项' }
const RULE_BODY = { version: 0, value: { day: 'SUN' }, reason: '运营按周日对账' }

describe('权限', () => {
  it('未登录 401；读取分别需要 finance.read 与 settings.read', async () => {
    const reader = await open(['finance.read', 'settings.read'])
    expect((await reader.call('GET', '/finance/profit-formula', { auth: false })).status).toBe(401)
    const denied = await open(['seller.read'])
    for (const path of ['/finance/profit-formula', '/settings/business-rules', '/metric-versions']) expect((await denied.call('GET', path)).status, path).toBe(403)
    const onlyFinance = await open(['finance.read'])
    expect((await onlyFinance.call('GET', '/finance/profit-formula')).status).toBe(200)
    expect((await onlyFinance.call('GET', '/settings/business-rules')).status).toBe(403)
  })

  it('提交利润公式需要 finance.policy.write、业务口径需要 settings.business.write，权限先于参数校验', async () => {
    const reader = await open(['finance.read', 'settings.read'])
    expect((await reader.call('PUT', '/finance/profit-formula', { body: { nonsense: true } })).status).toBe(403)
    expect((await reader.call('PUT', '/settings/business-rules/weekStart', { body: { nonsense: true } })).status).toBe(403)
    expect((await reader.call('POST', '/metric-versions/mv-1/decision', { body: {} })).status).toBe(403)
    expect(reader.prisma.metricVersion.create).not.toHaveBeenCalled()
    // 有 finance.policy.write 但没有 settings.business.write：不能改业务口径
    const policyOnly = await open(['finance.read', 'settings.read', 'finance.policy.write'])
    expect((await policyOnly.call('PUT', '/settings/business-rules/weekStart', { body: RULE_BODY })).status).toBe(403)
  })

  it('提交与审批必须再次验证身份', async () => {
    const { call, prisma } = await open(['finance.read', 'settings.read', 'finance.policy.write', 'settings.business.write'])
    prisma.stepUpVerification.findFirst.mockResolvedValue(null)
    for (const [method, path, body] of [
      ['PUT', '/finance/profit-formula', FORMULA_BODY],
      ['PUT', '/settings/business-rules/weekStart', RULE_BODY],
      ['POST', '/metric-versions/mv-1/decision', { decision: 'APPROVED', version: 1 }],
    ] as const) {
      const res = await call(method, path, { body })
      expect(res.status, path).toBe(403)
      expect(res.json.error.code).toBe('STEP_UP_REQUIRED')
    }
    expect(prisma.metricVersion.create).not.toHaveBeenCalled()
  })

  it('差异报告：版本不存在 404；区间不合法 422；只有利润公式与业务口径能出报告', async () => {
    const { call } = await open(['finance.read', 'settings.read'], { byId: null })
    expect((await call('POST', '/metric-versions/nope/diff-report', { body: { from: '2026-10-01', to: '2026-10-31' } })).status).toBe(404)
    expect((await call('POST', '/metric-versions/nope/diff-report', { body: { from: '2026-10-31', to: '2026-10-01' } })).status).toBe(422)
    const dict = await open(['finance.read', 'settings.read'], { byId: row({ kind: 'PROFIT_DICTIONARY' }) })
    expect((await dict.call('POST', '/metric-versions/mv-1/diff-report', { body: { from: '2026-10-01', to: '2026-10-31' } })).status).toBe(422)
  })
})

describe('读取', () => {
  it('没有任何版本：利润公式是系统默认（版本 0），15 个项目一行，标签与文字齐全', async () => {
    const { call } = await open(['finance.read'])
    const res = await call('GET', '/finance/profit-formula')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.current).toMatchObject({ versionNo: 0, source: 'DEFAULT', kind: 'PROFIT_FORMULA' })
    expect(data.current.texts.gross).toContain('毛利润 = 销售额 − 退款')
    expect(data.rows).toHaveLength(15)
    expect(data.rows.find((item: { key: string }) => item.key === 'ADS')).toMatchObject({ inGross: false, inDenominator: false })
    expect(data.rows.find((item: { key: string }) => item.key === 'REVENUE')).toMatchObject({ inGross: true, inDenominator: true })
    expect(data.latestVersionNo).toBe(0)
    expect(data.pending).toBeNull()
    expect(data.canWrite).toBe(false)
  })

  it('业务口径：四项卡片带当前值、默认值与影响范围；待审批的值单独给出', async () => {
    const pending = row({ id: 'mv-2', kind: 'BUSINESS_RULES', config: { weekStart: { day: 'SUN' }, _meta: { summary: '周起始日：每周从周一开始 → 每周从周日开始' } } })
    const { call } = await open(['settings.read', 'settings.business.write'], { pending, latest: 1 })
    const res = await call('GET', '/settings/business-rules')
    expect(res.status).toBe(200)
    const cards = res.json.data.cards as Array<{ key: string; valueText: string; pendingValue: unknown; impact: string[]; defaultText: string }>
    expect(cards.map(card => card.key)).toEqual(['netSales', 'availableInventory', 'weekStart', 'multiSiteToday'])
    expect(cards.find(card => card.key === 'weekStart')).toMatchObject({ valueText: '每周从周一开始', pendingValue: { day: 'SUN' } })
    expect(cards.find(card => card.key === 'netSales')?.pendingValue).toBeNull()
    expect(cards.every(card => card.impact.length > 0 && card.defaultText.length > 0)).toBe(true)
    expect(res.json.data.pending).toMatchObject({ versionNo: 1, status: 'PENDING_APPROVAL', createdByName: '运营小李', mine: true })
    expect(res.json.data.canWrite).toBe(true)
  })

  it('生效版本：读取已存的配置并忽略审批信息', async () => {
    const active = [
      row({ id: 'mv-a', status: 'ACTIVE', versionNo: 3, effectiveFrom: new Date('2026-10-20T00:00:00Z'), config: { gross: ['REVENUE'], denominator: ['REVENUE'], _meta: { decision: 'APPROVED' } } }),
    ]
    const { call } = await open(['finance.read'], { active, latest: 3 })
    const data = (await call('GET', '/finance/profit-formula')).json.data
    expect(data.current).toMatchObject({ versionNo: 3, source: 'VERSION', effectiveFrom: '2026-10-20', config: { gross: ['REVENUE'], denominator: ['REVENUE'] } })
    expect(data.current.tags).toEqual([{ key: 'REVENUE', label: '销售额', sign: 1 }])
  })

  it('口径版本列表：分页参数不合法 422', async () => {
    const { call } = await open(['settings.read'])
    expect((await call('GET', '/metric-versions?pageSize=500')).status).toBe(422)
    expect((await call('GET', '/metric-versions?kind=NOPE')).status).toBe(422)
    expect((await call('GET', '/metric-versions?kind=PROFIT_FORMULA')).status).toBe(200)
  })
})

describe('提交', () => {
  const WRITER = ['finance.read', 'settings.read', 'finance.policy.write', 'settings.business.write']

  it('利润公式：生成待审批的新版本，不改任何生效版本；写审计', async () => {
    const { call, prisma } = await open(WRITER)
    const res = await call('PUT', '/finance/profit-formula', { body: FORMULA_BODY })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ kind: 'PROFIT_FORMULA', versionNo: 1, status: 'PENDING_APPROVAL' })
    const data = prisma.metricVersion.create.mock.calls[0]![0].data
    expect(data).toMatchObject({ kind: 'PROFIT_FORMULA', versionNo: 1, status: 'PENDING_APPROVAL', createdBy: 'user-1' })
    expect(data.config).toMatchObject({ gross: ['REVENUE', 'COMMISSION', 'PRODUCT_COST'], denominator: ['REVENUE'], _meta: { reason: '毛利润只看三项' } })
    expect(data.config._meta.summary).toContain('毛利润不再计入')
    expect(prisma.metricVersion.updateMany).not.toHaveBeenCalled()
    const audits = prisma.auditEvent.create.mock.calls.map(([args]: [{ data: Record<string, unknown> }]) => args.data)
    expect(audits.find((item: Record<string, unknown>) => item.action === 'METRIC_VERSION_SUBMITTED')).toMatchObject({ resourceType: 'MetricVersion', reason: '毛利润只看三项' })
  })

  it('利润公式：不合法 422（空公式、分母是花费、不认识的项目）；与当前相同 422；版本号过期 409；已有待审批 409', async () => {
    const { call, prisma } = await open(WRITER)
    expect((await call('PUT', '/finance/profit-formula', { body: { ...FORMULA_BODY, gross: [] } })).status).toBe(422)
    expect((await call('PUT', '/finance/profit-formula', { body: { ...FORMULA_BODY, denominator: ['COMMISSION'] } })).status).toBe(422)
    expect((await call('PUT', '/finance/profit-formula', { body: { ...FORMULA_BODY, gross: ['NET_PROFIT'] } })).status).toBe(422)
    expect((await call('PUT', '/finance/profit-formula', { body: { ...FORMULA_BODY, reason: '' } })).status).toBe(422)
    const same = await call('PUT', '/finance/profit-formula', {
      body: {
        version: 0,
        gross: ['REVENUE', 'REFUNDS', 'COMMISSION', 'FULFILLMENT', 'STORAGE', 'AGED_SURCHARGE', 'INBOUND_PLACEMENT', 'OTHER_FEES', 'PROMOTION', 'PRODUCT_COST', 'FIRST_MILE', 'DUTY'],
        denominator: ['REVENUE'],
        reason: '没有变化',
      },
    })
    expect(same.status).toBe(422)
    expect(prisma.metricVersion.create).not.toHaveBeenCalled()
    const stale = await open(WRITER, { latest: 2 })
    expect((await stale.call('PUT', '/finance/profit-formula', { body: FORMULA_BODY })).status).toBe(409)
    const busy = await open(WRITER, { latest: 0, pending: row() })
    expect((await busy.call('PUT', '/finance/profit-formula', { body: FORMULA_BODY })).status).toBe(409)
    expect(busy.prisma.metricVersion.create).not.toHaveBeenCalled()
  })

  it('业务口径：只改这一项，其余项沿用当前值；值不合法 422；没有这项口径 422；相同 422', async () => {
    const { call, prisma } = await open(WRITER)
    const res = await call('PUT', '/settings/business-rules/weekStart', { body: RULE_BODY })
    expect(res.status).toBe(200)
    const data = prisma.metricVersion.create.mock.calls[0]![0].data
    expect(data).toMatchObject({ kind: 'BUSINESS_RULES', status: 'PENDING_APPROVAL' })
    expect(data.config).toMatchObject({ weekStart: { day: 'SUN' }, netSales: { deduct: ['REFUNDS'] }, availableInventory: { components: ['FULFILLABLE'] }, multiSiteToday: { mode: 'LATEST_SITE' } })
    expect(data.config._meta.summary).toBe('周起始日：每周从周一开始 → 每周从周日开始')
    prisma.metricVersion.create.mockClear()
    expect((await call('PUT', '/settings/business-rules/weekStart', { body: { ...RULE_BODY, value: { day: 'FRI' } } })).status).toBe(422)
    expect((await call('PUT', '/settings/business-rules/availableInventory', { body: { ...RULE_BODY, value: { components: [] } } })).status).toBe(422)
    expect((await call('PUT', '/settings/business-rules/nothing', { body: RULE_BODY })).status).toBe(422)
    expect((await call('PUT', '/settings/business-rules/weekStart', { body: { ...RULE_BODY, value: { day: 'MON' } } })).status).toBe(422)
    expect(prisma.metricVersion.create).not.toHaveBeenCalled()
  })
})

describe('审批', () => {
  const APPROVER = ['finance.read', 'settings.read', 'finance.policy.write']

  it('发起人不能审批自己的修改；驳回必须写意见；撤回不需要别人', async () => {
    const { call, prisma } = await open(APPROVER, { byId: row() })
    const self = await call('POST', '/metric-versions/mv-1/decision', { body: { decision: 'APPROVED', version: 1 } })
    expect(self.status).toBe(409)
    expect(self.json.error.message).toContain('发起人不能审批自己的修改')
    expect((await call('POST', '/metric-versions/mv-1/decision', { body: { decision: 'REJECTED', comment: '', version: 1 } })).status).toBe(422)
    expect(prisma.metricVersion.updateMany).not.toHaveBeenCalled()
    const withdrawn = await call('POST', '/metric-versions/mv-1/decision', { body: { decision: 'REJECTED', comment: '写错了', version: 1 } })
    expect(withdrawn.status).toBe(201)
    expect(withdrawn.json.data.message).toContain('已撤回')
    const update = prisma.metricVersion.updateMany.mock.calls[0]![0]
    expect(update.data).toMatchObject({ status: 'RETIRED' })
    expect(update.data.config._meta).toMatchObject({ decision: 'WITHDRAWN', comment: '写错了' })
  })

  it('别人批准：旧生效版本失效、新版本生效并记录审批人；已不在待审批 409；版本不存在 404', async () => {
    const old = { id: 'mv-old', version: 4, versionNo: 0 }
    const { call, prisma } = await open(APPROVER, { byId: row({ createdBy: 'someone-else' }) })
    prisma.metricVersion.findMany.mockResolvedValue([old])
    const res = await call('POST', '/metric-versions/mv-1/decision', { body: { decision: 'APPROVED', version: 1 } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ kind: 'PROFIT_FORMULA', versionNo: 1, status: 'ACTIVE' })
    const calls = prisma.metricVersion.updateMany.mock.calls.map(([args]: [{ where: Record<string, unknown>; data: Record<string, unknown> }]) => args)
    expect(calls[0]).toMatchObject({ where: { id: 'mv-old', version: 4 }, data: { status: 'RETIRED' } })
    expect(calls[1]).toMatchObject({ where: { id: 'mv-1', version: 1 }, data: { status: 'ACTIVE', approvedBy: 'user-1' } })
    expect(calls[1]!.data.config._meta).toMatchObject({ decision: 'APPROVED', reason: '调整' })
    const done = await open(APPROVER, { byId: row({ status: 'ACTIVE', createdBy: 'someone-else' }) })
    expect((await done.call('POST', '/metric-versions/mv-1/decision', { body: { decision: 'APPROVED', version: 1 } })).status).toBe(409)
    const missing = await open(APPROVER, { byId: null })
    expect((await missing.call('POST', '/metric-versions/nope/decision', { body: { decision: 'APPROVED', version: 1 } })).status).toBe(404)
  })
})
