import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 财务口径接口（P2b-15）：权限先于参数校验、读取（默认口径与待审批）、提交与审批的状态规则。
// 提交到生效的完整流程、关账期间保护与企业隔离在真实库测试 apps/api/src/testing/finance-policy.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const versionRow = (over: Record<string, unknown> = {}) => ({
  id: 'fp-1',
  versionNo: 1,
  effectiveFrom: new Date('2026-10-01T00:00:00Z'),
  revenueRecognition: 'ORDERED',
  inventoryCostMethod: 'FIFO',
  fxRateRule: 'SALE_DAY',
  adsAllocationMode: 'BY_SALES',
  storeFeeAllocation: 'BY_SALES',
  status: 'PENDING',
  reason: '改成移动加权',
  version: 1,
  createdBy: 'user-1',
  createdAt: new Date('2026-10-22T00:00:00Z'),
  decidedBy: null,
  decidedAt: null,
  decisionComment: null,
  replacedAt: null,
  ...over,
})

const open = async (permissions: string[], pending: Record<string, unknown> | null = null) => {
  await harness?.close()
  const guards = createWriteGuardStubs()
  const prisma = {
    ...sessionStub(permissions),
    ...guards,
    stepUpVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    accountingPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    membership: { ...sessionStub(permissions).membership, findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '财务小王', email: 'w@example.com' } }]) },
    financePolicyVersion: {
      // 待审批版本与最新版本号读取共用 findFirst：按查询条件区分
      findFirst: vi.fn().mockImplementation(async (args: { where?: { status?: unknown } }) => {
        const status = args.where?.status
        if (status === 'PENDING') return pending
        if (status === 'ACTIVE') return null
        return pending ? { versionNo: pending.versionNo, ...pending } : null
      }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  }
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}

const BODY = {
  version: 0,
  effectiveFrom: '2026-10-01',
  revenueRecognition: 'ORDERED',
  inventoryCostMethod: 'MOVING_AVG',
  fxRateRule: 'SALE_DAY',
  adsAllocationMode: 'BY_SALES',
  storeFeeAllocation: 'BY_SALES',
  reason: '改成移动加权',
}

describe('权限', () => {
  it('未登录 401；没有 settings.read 读取 403；没有 finance.policy.write 提交与审批 403 且先于参数校验', async () => {
    const reader = await open(['settings.read'])
    expect((await reader.call('GET', '/settings/finance-policy', { auth: false })).status).toBe(401)
    const denied = await open(['seller.read'])
    expect((await denied.call('GET', '/settings/finance-policy')).status).toBe(403)
    expect(denied.prisma.financePolicyVersion.findFirst).not.toHaveBeenCalled()
    const readOnly = await open(['settings.read'])
    expect((await readOnly.call('PUT', '/settings/finance-policy', { body: { nonsense: true } })).status).toBe(403)
    expect((await readOnly.call('POST', '/settings/finance-policy/1/approve', { body: {} })).status).toBe(403)
    expect(readOnly.prisma.financePolicyVersion.create).not.toHaveBeenCalled()
  })

  it('提交与审批必须再次验证身份', async () => {
    const { call, prisma } = await open(['settings.read', 'finance.policy.write'])
    prisma.stepUpVerification.findFirst.mockResolvedValue(null)
    const put = await call('PUT', '/settings/finance-policy', { body: BODY })
    expect(put.status).toBe(403)
    expect(put.json.error.code).toBe('STEP_UP_REQUIRED')
    expect(prisma.stepUpVerification.findFirst.mock.calls[0]![0].where).toMatchObject({ action: 'finance.policy' })
    const approve = await call('POST', '/settings/finance-policy/1/approve', { body: { decision: 'APPROVED', version: 1 } })
    expect(approve.json.error.code).toBe('STEP_UP_REQUIRED')
    expect(prisma.financePolicyVersion.create).not.toHaveBeenCalled()
  })
})

describe('读取', () => {
  it('没有任何版本：当前口径是系统默认，五项口径标明是否已用于计算，动作按权限给出', async () => {
    const { call } = await open(['settings.read'])
    const res = await call('GET', '/settings/finance-policy')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.current).toMatchObject({ source: 'DEFAULT', versionNo: 0, inventoryMethodValid: true })
    expect(data.current.values).toMatchObject({ revenueRecognition: 'ORDERED', inventoryCostMethod: 'FIFO', adsAllocationMode: 'BY_SALES', storeFeeAllocation: 'BY_SALES' })
    expect(data.pending).toBeNull()
    expect(data.latestVersionNo).toBe(0)
    expect(data.fields).toHaveLength(5)
    const consumers = Object.fromEntries(data.fields.map((field: { key: string; consumer: string }) => [field.key, field.consumer]))
    expect(consumers).toMatchObject({ inventoryCostMethod: 'WIRED', adsAllocationMode: 'WIRED', storeFeeAllocation: 'WIRED', revenueRecognition: 'RECORDED' })
    expect(data.actions.submit.allowed).toBe(false)
  })

  it('有待审批的版本：返回变化来源与发起人名字，发起人本人不能批准', async () => {
    const { call } = await open(['settings.read', 'finance.policy.write'], versionRow({ inventoryCostMethod: 'MOVING_AVG' }))
    const res = await call('GET', '/settings/finance-policy')
    expect(res.status).toBe(200)
    expect(res.json.data.pending).toMatchObject({ versionNo: 1, status: 'PENDING', createdByName: '财务小王', mine: true, inventoryCostMethod: 'MOVING_AVG' })
    expect(res.json.data.actions.approve.allowed).toBe(false)
    expect(res.json.data.actions.reject.allowed).toBe(true)
  })
})

describe('提交与审批的校验', () => {
  it('参数不合法 422：取值、日期格式、原因太短；不写库', async () => {
    const { call, prisma } = await open(['settings.read', 'finance.policy.write'])
    expect((await call('PUT', '/settings/finance-policy', { body: { ...BODY, inventoryCostMethod: 'LIFO' } })).status).toBe(422)
    expect((await call('PUT', '/settings/finance-policy', { body: { ...BODY, effectiveFrom: '10/01' } })).status).toBe(422)
    expect((await call('PUT', '/settings/finance-policy', { body: { ...BODY, reason: '改' } })).status).toBe(422)
    expect(prisma.financePolicyVersion.create).not.toHaveBeenCalled()
    expect((await call('POST', '/settings/finance-policy/1/approve', { body: { decision: 'REJECTED', version: 1 } })).status).toBe(422)
  })

  it('生效日晚于今天或太久以前 422', async () => {
    const { call, prisma } = await open(['settings.read', 'finance.policy.write'])
    expect((await call('PUT', '/settings/finance-policy', { body: { ...BODY, effectiveFrom: '2999-01-01' } })).status).toBe(422)
    expect((await call('PUT', '/settings/finance-policy', { body: { ...BODY, effectiveFrom: '2001-01-01' } })).status).toBe(422)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('审批：版本不存在 404；不是待审批 409；发起人不能批准自己的修改 409', async () => {
    const { call, prisma } = await open(['settings.read', 'finance.policy.write'])
    expect((await call('POST', '/settings/finance-policy/9/approve', { body: { decision: 'APPROVED', version: 1 } })).status).toBe(404)
    prisma.financePolicyVersion.findFirst.mockResolvedValue(versionRow({ status: 'ACTIVE' }))
    const done = await call('POST', '/settings/finance-policy/1/approve', { body: { decision: 'APPROVED', version: 1 } })
    expect(done.status).toBe(409)
    prisma.financePolicyVersion.findFirst.mockResolvedValue(versionRow())
    const own = await call('POST', '/settings/finance-policy/1/approve', { body: { decision: 'APPROVED', version: 1 } })
    expect(own.status).toBe(409)
    expect(own.json.error.message).toContain('发起人不能审批')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
