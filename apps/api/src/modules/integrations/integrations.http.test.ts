import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySwitchOutcome, SWITCH_AUTO_CLOSE_FAILURES } from '@nova/api-contracts'
import { createTestApp, sessionStub } from '../../testing/harness'
import { DbSwitches } from '../../platform/write'
import { AlertService } from '../../platform/observability'
import { checkPrerequisites, prerequisitesPassed } from './switch-prerequisites'
import { SwitchOutcomeService } from './switch-outcome.service'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
  vi.unstubAllEnvs()
})

const ADMIN_ROLE = { permissions: ['settings.integration.write'], system: true, version: 2, fieldPermissions: [] }
const connection = { provider: 'AMAZON_SP_API', grantedScopes: ['public-seller', 'seller', 'fba', 'reports'], healthChecks: [{ status: 'HEALTHY' }] }

function prismaFor(permissions: string[], options: { connections?: unknown[]; existing?: Record<string, unknown> | null; enabledRows?: unknown[] } = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    platformConnection: { findMany: vi.fn().mockResolvedValue(options.connections ?? [connection]) },
    integrationSwitch: {
      findFirst: vi.fn().mockResolvedValue(options.existing ?? null),
      findMany: vi.fn().mockResolvedValue(options.enabledRows ?? []),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'sw-1', version: 1, ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }) => ({ id: where.id, version: 2, reason: data.reason ?? null, enabled: data.enabled })),
    },
    integrationSwitchLog: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
    membership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions }, tenant: { lifecycleStatus: 'ACTIVE' } }),
      findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', role: ADMIN_ROLE, user: { displayName: '管理员甲', email: 'a@example.com' } }]),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    stepUpVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  }
  return prisma
}

function stubCredentials() {
  vi.stubEnv('AMAZON_SP_LWA_CLIENT_ID', 'client')
  vi.stubEnv('AMAZON_SP_LWA_CLIENT_SECRET', 'secret')
}

describe('接口与写入开关：总览', () => {
  it('需要 settings.read；返回 20 项，默认全部关闭，模式为只读', async () => {
    stubCredentials()
    harness = await createTestApp(prismaFor(['settings.read']))
    const res = await harness.call('GET', '/settings/integrations')
    expect(res.status).toBe(200)
    expect(res.json.data.items).toHaveLength(20)
    expect(res.json.data).toMatchObject({ mode: 'READ_ONLY', enabledCount: 0, total: 20 })
    expect(res.json.data.items.every((item: { enabled: boolean }) => !item.enabled)).toBe(true)
    // 凭据、连接、范围、健康都满足时可开启
    expect(res.json.data.items.find((item: { key: string }) => item.key === 'sw.listing.update')).toMatchObject({ canEnable: true })
    await harness.close()
    harness = await createTestApp(prismaFor(['orders.read']))
    expect((await harness.call('GET', '/settings/integrations')).status).toBe(403)
  })

  it('没有授权连接时，每个开关都显示前置条件未满足，不能开启', async () => {
    stubCredentials()
    harness = await createTestApp(prismaFor(['settings.read'], { connections: [] }))
    const res = await harness.call('GET', '/settings/integrations')
    const item = res.json.data.items.find((entry: { key: string }) => entry.key === 'sw.ads.bid')
    expect(item.canEnable).toBe(false)
    expect(item.prerequisites.filter((check: { passed: boolean }) => !check.passed).length).toBeGreaterThan(0)
  })

  it('环境变量紧急强制关闭：即使数据库里是开启，也显示为关闭并说明原因，且不能开启', async () => {
    stubCredentials()
    vi.stubEnv('NOVA_WRITE_EMERGENCY_DISABLE', 'sw.listing.update')
    harness = await createTestApp(prismaFor(['settings.read'], { enabledRows: [{ switchKey: 'sw.listing.update' }] }))
    const res = await harness.call('GET', '/settings/integrations')
    const item = res.json.data.items.find((entry: { key: string }) => entry.key === 'sw.listing.update')
    expect(item).toMatchObject({ enabled: false, canEnable: false })
    expect(item.forcedOffReason).toContain('紧急强制关闭')
  })

  it('顶栏概要：登录成员即可查看，只含模式与数量', async () => {
    harness = await createTestApp(prismaFor([], { enabledRows: [{ switchKey: 'sw.listing.update' }, { switchKey: 'sw.ads.bid' }] }))
    const res = await harness.call('GET', '/settings/integrations/summary')
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ mode: 'PARTIAL', enabledCount: 2, total: 20, emergencyForced: false })
  })
})

describe('接口与写入开关：开启与关闭', () => {
  const enableBody = { reason: '需要修改刊登标题', confirm: true }

  it('开启：写开关、变更记录、审计与管理员通知同事务提交', async () => {
    stubCredentials()
    const prisma = prismaFor(['settings.integration.write'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/settings/integrations/sw.listing.update/enable', { body: enableBody })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ key: 'sw.listing.update', enabled: true })
    expect(prisma.integrationSwitch.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 'tenant-1',
      switchKey: 'sw.listing.update',
      enabled: true,
      enabledBy: 'user-1',
      reason: '需要修改刊登标题',
    })
    expect(prisma.integrationSwitchLog.create.mock.calls[0][0].data).toMatchObject({ action: 'ENABLED', actorId: 'user-1', beforeJson: { enabled: false }, afterJson: { enabled: true } })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'WRITE_SWITCH_ENABLED', resourceType: 'IntegrationSwitch', reason: '需要修改刊登标题' })
    const notified = prisma.notification.createMany.mock.calls[0][0].data
    expect(notified[0]).toMatchObject({ userId: 'user-1', kind: 'WRITE_SWITCH_CHANGED' })
  })

  it('开启：没有再次验证返回 403 STEP_UP_REQUIRED；不带二次确认、没有原因返回 422；都不会写库', async () => {
    stubCredentials()
    const prisma = prismaFor(['settings.integration.write'])
    prisma.stepUpVerification.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    const noStepUp = await harness.call('POST', '/settings/integrations/sw.listing.update/enable', { body: enableBody })
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.json.error.code).toBe('STEP_UP_REQUIRED')
    prisma.stepUpVerification.findFirst.mockResolvedValue({ id: 'su-1' })
    expect((await harness.call('POST', '/settings/integrations/sw.listing.update/enable', { body: { reason: '需要修改刊登标题', confirm: false } })).status).toBe(422)
    expect((await harness.call('POST', '/settings/integrations/sw.listing.update/enable', { body: { reason: '', confirm: true } })).status).toBe(422)
    expect(prisma.integrationSwitch.create).not.toHaveBeenCalled()
  })

  it('开启：前置条件不满足返回 409，且说明缺哪一项；开关不存在返回 404；已开启返回 409', async () => {
    stubCredentials()
    const missing = prismaFor(['settings.integration.write'], { connections: [] })
    harness = await createTestApp(missing)
    const res = await harness.call('POST', '/settings/integrations/sw.listing.update/enable', { body: enableBody })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('DATA_CONDITION_FAILED')
    expect(res.json.error.message).toContain('已完成亚马逊卖家授权')
    expect(missing.integrationSwitch.create).not.toHaveBeenCalled()
    expect((await harness.call('POST', '/settings/integrations/sw.nothing/enable', { body: enableBody })).status).toBe(404)
    await harness.close()
    harness = await createTestApp(prismaFor(['settings.integration.write'], { existing: { id: 'sw-1', enabled: true, version: 3, reason: null } }))
    expect((await harness.call('POST', '/settings/integrations/sw.listing.update/enable', { body: enableBody })).status).toBe(409)
  })

  it('开启：广告开关需要广告授权范围；只有卖家授权时不能开启', async () => {
    vi.stubEnv('AMAZON_ADS_CLIENT_ID', 'client')
    vi.stubEnv('AMAZON_ADS_CLIENT_SECRET', 'secret')
    harness = await createTestApp(prismaFor(['settings.integration.write']))
    const res = await harness.call('POST', '/settings/integrations/sw.ads.bid/enable', { body: enableBody })
    expect(res.status).toBe(409)
  })

  it('环境变量紧急强制关闭时不能开启', async () => {
    stubCredentials()
    vi.stubEnv('NOVA_WRITE_EMERGENCY_DISABLE', 'all')
    harness = await createTestApp(prismaFor(['settings.integration.write']))
    const res = await harness.call('POST', '/settings/integrations/sw.listing.update/enable', { body: enableBody })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('WRITE_SWITCH_OFF')
  })

  it('关闭：必须填原因；写变更记录与审计；开关本来就是关闭时返回 409', async () => {
    const existing = { id: 'sw-1', switchKey: 'sw.listing.update', enabled: true, version: 2, reason: '之前的原因' }
    const prisma = prismaFor(['settings.integration.write'], { existing })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/settings/integrations/sw.listing.update/disable', { body: {} })).status).toBe(422)
    const res = await harness.call('POST', '/settings/integrations/sw.listing.update/disable', { body: { reason: '暂停修改' } })
    expect(res.status).toBe(200)
    expect(prisma.integrationSwitchLog.create.mock.calls[0][0].data).toMatchObject({ action: 'DISABLED', reason: '暂停修改' })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'WRITE_SWITCH_DISABLED' })
    prisma.integrationSwitch.findFirst.mockResolvedValue({ ...existing, enabled: false })
    expect((await harness.call('POST', '/settings/integrations/sw.listing.update/disable', { body: { reason: '再关一次' } })).status).toBe(409)
  })

  it('一键全部只读：关闭全部已开启项，记录每项变更；批量 PATCH 只允许关闭', async () => {
    const rows = [
      { id: 'sw-1', switchKey: 'sw.listing.update', enabled: true, version: 1, reason: null },
      { id: 'sw-2', switchKey: 'sw.ads.bid', enabled: true, version: 1, reason: null },
    ]
    const prisma = prismaFor(['settings.integration.write'], { enabledRows: rows })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/settings/integrations/readonly-all', { body: { reason: '发现异常改价' } })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ changed: 2, keys: ['sw.listing.update', 'sw.ads.bid'] })
    expect(prisma.integrationSwitchLog.create.mock.calls.map((call: [{ data: { action: string } }]) => call[0].data.action)).toEqual(['READONLY_ALL', 'READONLY_ALL'])
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'WRITE_SWITCH_READONLY_ALL', detail: { count: 2 } })
    const open = await harness.call('PATCH', '/settings/integrations', { body: { keys: ['sw.ads.bid'], enabled: true, reason: '想开启' } })
    expect(open.status).toBe(422)
    const close = await harness.call('PATCH', '/settings/integrations', { body: { keys: ['sw.ads.bid'], enabled: false, reason: '暂停调价' } })
    expect(close.status).toBe(200)
  })
})

describe('前置条件检查（纯函数）', () => {
  const spec = { key: 'sw.inbound.plan.create', label: '创建入仓计划', group: 'SELLER', permission: 'inbound.plan.write', provider: 'AMAZON_SP_API', scopes: ['seller', 'fba'] } as const
  it('四项全部满足才可开启；范围缺失、健康不良、凭据缺失分别指出', () => {
    const env = { AMAZON_SP_LWA_CLIENT_ID: 'a', AMAZON_SP_LWA_CLIENT_SECRET: 'b' }
    expect(prerequisitesPassed(checkPrerequisites(spec, [{ provider: 'AMAZON_SP_API', scopes: ['seller', 'fba'], healthy: true }], env))).toBe(true)
    const noFba = checkPrerequisites(spec, [{ provider: 'AMAZON_SP_API', scopes: ['seller'], healthy: true }], env)
    expect(noFba.filter(item => !item.passed).map(item => item.code)).toEqual(['SCOPES', 'HEALTH'])
    const unhealthy = checkPrerequisites(spec, [{ provider: 'AMAZON_SP_API', scopes: ['seller', 'fba'], healthy: false }], env)
    expect(unhealthy.filter(item => !item.passed).map(item => item.code)).toEqual(['HEALTH'])
    expect(checkPrerequisites(spec, [{ provider: 'AMAZON_SP_API', scopes: ['seller', 'fba'], healthy: true }], {}).find(item => item.code === 'APP_CREDENTIALS')?.passed).toBe(false)
    // 广告连接不能满足卖家开关
    expect(checkPrerequisites(spec, [{ provider: 'AMAZON_ADS_API', scopes: ['seller', 'fba'], healthy: true }], env).find(item => item.code === 'CONNECTION')?.passed).toBe(false)
  })
})

describe('写入开关读取（动作守卫用）', () => {
  const statusOf = (row: unknown) => new DbSwitches({ integrationSwitch: { findFirst: vi.fn().mockResolvedValue(row) } } as never).status('tenant-1', 'sw.listing.update')
  it('无记录即关闭；开启才放行；自动关闭会说明原因；环境变量强制关闭优先；未知开关视为关闭', async () => {
    expect(await statusOf(null)).toMatchObject({ enabled: false })
    expect(await statusOf({ enabled: true, autoDisabledReason: null })).toEqual({ enabled: true })
    expect((await statusOf({ enabled: false, autoDisabledReason: '连续失败 5 次' })).reason).toContain('连续失败 5 次')
    vi.stubEnv('NOVA_WRITE_EMERGENCY_DISABLE', 'all')
    expect((await statusOf({ enabled: true, autoDisabledReason: null })).enabled).toBe(false)
    vi.unstubAllEnvs()
    expect((await new DbSwitches({} as never).status('tenant-1', 'sw.unknown')).enabled).toBe(false)
  })
})

describe('写调用统计与自动关闭', () => {
  const now = new Date('2026-10-22T08:00:00Z')

  it('统计按天累计，只保留最近 7 天；成功会清零连续失败', () => {
    const old = [
      { d: '2026-10-10', calls: 9, failures: 1 },
      { d: '2026-10-20', calls: 3, failures: 1 },
    ]
    const first = applySwitchOutcome(old, 2, false, now)
    expect(first.stats).toEqual([
      { d: '2026-10-20', calls: 3, failures: 1 },
      { d: '2026-10-22', calls: 1, failures: 1 },
    ])
    expect(first).toMatchObject({ calls7d: 4, failures7d: 2, consecutiveFailures: 3, shouldAutoClose: false })
    expect(applySwitchOutcome(first.stats, 3, true, now)).toMatchObject({ consecutiveFailures: 0, calls7d: 5, failures7d: 2 })
    expect(applySwitchOutcome([], SWITCH_AUTO_CLOSE_FAILURES - 1, false, now).shouldAutoClose).toBe(true)
  })

  function outcomeHarness(row: Record<string, unknown> | null, siblings: Record<string, unknown>[] = []) {
    const tx = {
      integrationSwitch: { findFirst: vi.fn().mockResolvedValue(row), update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue(siblings) },
      integrationSwitchLog: { create: vi.fn().mockResolvedValue({}) },
    }
    const prisma = { $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)) }
    const alerts = new AlertService()
    const raise = vi.spyOn(alerts, 'raise').mockResolvedValue(true)
    return { tx, raise, service: new SwitchOutcomeService(prisma as never, alerts) }
  }

  it('连续失败达到 5 次：关闭开关、写自动关闭记录并发出告警', async () => {
    const { tx, raise, service } = outcomeHarness({ id: 'sw-1', statsJson: [], consecutiveFailures: 4 })
    const result = await service.record('tenant-1', 'sw.pricing.update', { success: false, errorCode: 'HTTP_500' }, now)
    expect(result.autoClosed).toEqual(['sw.pricing.update'])
    expect(tx.integrationSwitch.update.mock.calls[0][0].data).toMatchObject({ enabled: false, consecutiveFailures: 5, calls7d: 1, failures7d: 1 })
    expect(tx.integrationSwitchLog.create.mock.calls[0][0].data).toMatchObject({ action: 'AUTO_DISABLED', actorId: null })
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ code: 'WRITE_SWITCH_AUTO_CLOSED', tenantId: 'tenant-1' }))
  })

  it('未达到次数只记统计；开关未开启时不记录', async () => {
    const low = outcomeHarness({ id: 'sw-1', statsJson: [], consecutiveFailures: 1 })
    expect((await low.service.record('tenant-1', 'sw.pricing.update', { success: false }, now)).autoClosed).toEqual([])
    expect(low.tx.integrationSwitch.update.mock.calls[0][0].data).not.toHaveProperty('enabled')
    expect(low.raise).not.toHaveBeenCalled()
    const off = outcomeHarness(null)
    await off.service.record('tenant-1', 'sw.pricing.update', { success: false }, now)
    expect(off.tx.integrationSwitch.update).not.toHaveBeenCalled()
  })

  it('授权失效：立即关闭，并连带关闭同一提供方其他已开启的开关（不关广告开关）', async () => {
    const { tx, service } = outcomeHarness({ id: 'sw-1', statsJson: [], consecutiveFailures: 0 }, [
      { id: 'sw-2', switchKey: 'sw.listing.update' },
      { id: 'sw-3', switchKey: 'sw.ads.bid' },
    ])
    const result = await service.record('tenant-1', 'sw.pricing.update', { success: false, authInvalid: true }, now)
    expect(result.autoClosed).toEqual(['sw.pricing.update', 'sw.listing.update'])
    expect(tx.integrationSwitch.update.mock.calls.map(call => call[0].where.id)).toEqual(['sw-1', 'sw-2'])
  })
})
