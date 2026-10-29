import { describe, expect, it, vi } from 'vitest'
import type { PrismaService } from '../prisma.service'
import type { ApiContext } from '../http'
import { AppError } from '../http'
import { ActionGuardService, IntegrationSwitchPort, ReadOnlySwitches } from './action-guard.service'

const context = (permissions: string[]): ApiContext => ({ userId: 'u1', sessionId: 's1', tenantId: 't1', membershipId: 'm1', permissions })

function guard(options: { connection?: unknown; switchEnabled?: boolean; switchReason?: string } = {}) {
  const findFirst = vi.fn().mockResolvedValue(options.connection ?? null)
  const switches: IntegrationSwitchPort = { status: vi.fn().mockResolvedValue({ enabled: options.switchEnabled ?? false, reason: options.switchReason }) }
  const prisma = { platformConnection: { findFirst } } as unknown as PrismaService
  return { service: new ActionGuardService(prisma, switches), findFirst, switches }
}

const healthyConnection = { lastErrorCode: null, healthChecks: [{ status: 'HEALTHY' }] }

describe('动作守卫：权限 → 连接 → 写入开关 → 数据条件', () => {
  it('没有权限：直接在第一步停下，不再查连接与开关', async () => {
    const { service, findFirst, switches } = guard()
    const decision = await service.evaluate(context(['orders.read']), { permission: 'ads.bid.write', connection: { provider: 'AMAZON_ADS_API' }, switchKey: 'ads.bid' })
    expect(decision).toMatchObject({ allowed: false, passed: [], blockedBy: { step: 'PERMISSION', code: 'TENANT_ACCESS_DENIED' } })
    expect(findFirst).not.toHaveBeenCalled()
    expect(switches.status).not.toHaveBeenCalled()
  })

  it('连接不可用：有权限管理连接的人带“前往连接中心”，没有的人只看到原因', async () => {
    const { service } = guard()
    const spec = { permission: 'ads.bid.write', connection: { provider: 'AMAZON_ADS_API' as const }, switchKey: 'ads.bid' }
    const manager = await service.evaluate(context(['ads.bid.write', 'connection.manage']), spec)
    expect(manager.blockedBy).toMatchObject({ step: 'CONNECTION', code: 'CONNECTION_UNAVAILABLE', remedy: { kind: 'GO_CONNECT', path: '/app/connections' } })
    expect(manager.blockedBy?.message).toContain('广告')
    const ordinary = await service.evaluate(context(['ads.bid.write']), spec)
    expect(ordinary.blockedBy?.step).toBe('CONNECTION')
    expect(ordinary.blockedBy?.remedy).toBeUndefined()
  })

  it('连接健康检查失败同样视为不可用', async () => {
    const { service } = guard({ connection: { lastErrorCode: null, healthChecks: [{ status: 'UNHEALTHY' }] } })
    const decision = await service.evaluate(context(['pricing.price.write']), { permission: 'pricing.price.write', connection: { provider: 'AMAZON_SP_API', sellerAccountId: 'store-1' } })
    expect(decision.blockedBy).toMatchObject({ step: 'CONNECTION' })
    expect(decision.blockedBy?.message).toContain('健康检查未通过')
  })

  it('指定店铺时，只认该店铺的连接', async () => {
    const { service, findFirst } = guard({ connection: healthyConnection })
    await service.evaluate(context(['pricing.price.write']), { permission: 'pricing.price.write', connection: { provider: 'AMAZON_SP_API', sellerAccountId: 'store-1' } })
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', provider: 'AMAZON_SP_API', state: 'AUTHORIZED', sellerAccountId: 'store-1' })
  })

  it('写入开关关闭（默认全部只读）：有开关管理权限的人带“前往开启”', async () => {
    const { service } = guard({ connection: healthyConnection })
    const decision = await service.evaluate(context(['pricing.price.write', 'settings.integration.write']), {
      permission: 'pricing.price.write',
      connection: { provider: 'AMAZON_SP_API' },
      switchKey: 'pricing.price',
    })
    expect(decision).toMatchObject({
      allowed: false,
      passed: ['PERMISSION', 'CONNECTION'],
      blockedBy: { step: 'SWITCH', code: 'WRITE_SWITCH_OFF', remedy: { kind: 'GO_ENABLE', path: '/app/settings/integrations' } },
    })
  })

  it('数据条件按顺序判断，第一个不满足的即停止；有处理入口的带“前往处理”', async () => {
    const { service } = guard({ connection: healthyConnection, switchEnabled: true })
    const second = vi.fn().mockReturnValue(false)
    const decision = await service.evaluate(context(['pricing.price.write']), {
      permission: 'pricing.price.write',
      connection: { provider: 'AMAZON_SP_API' },
      switchKey: 'pricing.price',
      conditions: [
        { code: 'A', message: '价格不能低于护栏下限', check: () => false, remedyPath: '/app/pricing/guardrails' },
        { code: 'B', message: '第二个条件', check: second },
      ],
    })
    expect(decision.blockedBy).toMatchObject({ step: 'DATA', code: 'DATA_CONDITION_FAILED', message: '价格不能低于护栏下限', remedy: { kind: 'GO_HANDLE', path: '/app/pricing/guardrails' } })
    expect(second).not.toHaveBeenCalled()
  })

  it('全部满足：允许，并列出通过的环节', async () => {
    const { service } = guard({ connection: healthyConnection, switchEnabled: true })
    const decision = await service.evaluate(context(['pricing.price.write']), {
      permission: 'pricing.price.write',
      connection: { provider: 'AMAZON_SP_API' },
      switchKey: 'pricing.price',
      conditions: [{ code: 'A', message: 'x', check: async () => true }],
    })
    expect(decision).toEqual({ allowed: true, passed: ['PERMISSION', 'CONNECTION', 'SWITCH', 'DATA'] })
  })

  it('不涉及亚马逊写入的动作可以只判断权限', async () => {
    const { service } = guard()
    expect(await service.evaluate(context(['export.create']), { permission: 'export.create' })).toEqual({ allowed: true, passed: ['PERMISSION'] })
    expect(await service.evaluate(context(['*']), { permission: 'anything.at.all' })).toMatchObject({ allowed: true })
  })

  it('服务端执行前用 assert：权限不足 403，其余环节 409，并带失败环节与处理入口', async () => {
    const { service } = guard({ connection: healthyConnection })
    const denied = await service.assert(context([]), { permission: 'ads.bid.write' }).then(
      () => null,
      e => e,
    )
    expect(denied).toBeInstanceOf(AppError)
    expect(denied.getStatus()).toBe(403)
    expect(denied.details).toEqual({ step: 'PERMISSION' })
    const off = await service
      .assert(context(['pricing.price.write', 'settings.integration.write']), { permission: 'pricing.price.write', connection: { provider: 'AMAZON_SP_API' }, switchKey: 'pricing.price' })
      .then(
        () => null,
        e => e,
      )
    expect(off.getStatus()).toBe(409)
    expect(off.code).toBe('WRITE_SWITCH_OFF')
    expect(off.details).toEqual({ step: 'SWITCH', remedyPath: '/app/settings/integrations' })
  })

  it('默认的写入开关实现是“全部只读”', async () => {
    expect(await new ReadOnlySwitches().status()).toMatchObject({ enabled: false })
  })
})
