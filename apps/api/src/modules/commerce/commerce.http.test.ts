import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('官网在线购买（公开接口）', () => {
  it('套餐列表公开可读，只读取启用的套餐', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    harness = await createTestApp({ commercialPlan: { findMany } })
    const res = await harness.call('GET', '/commerce/plans', { auth: false })
    expect(res.status).toBe(200)
    expect(findMany.mock.calls[0][0].where).toEqual({ status: 'ACTIVE' })
  })

  it('支付配置公开可读', async () => {
    harness = await createTestApp({})
    expect((await harness.call('GET', '/commerce/payment-configuration', { auth: false })).status).toBe(200)
  })

  it('下单：先限流再校验；字段缺失返回 422', async () => {
    harness = await createTestApp({})
    const res = await harness.call('POST', '/commerce/orders', { auth: false, body: { planCode: 'SINGLE_COMPANY' } })
    expect(res.status).toBe(422)
    expect(harness.rateLimit.check).toHaveBeenCalledWith('commerce-order', expect.any(String), 3, 600)
  })
})

describe('平台运营后台接口', () => {
  it('全部需要登录', async () => {
    harness = await createTestApp({})
    for (const [method, path] of [
      ['GET', '/commerce/admin/plans'],
      ['GET', '/commerce/admin/orders'],
      ['GET', '/commerce/admin/refunds'],
    ] as const) {
      expect((await harness.call(method, path, { auth: false })).status).toBe(401)
    }
  })

  it('已登录但不是平台运营主体时拒绝（生产环境未配置运营租户时报配置缺失）', async () => {
    harness = await createTestApp({ ...sessionStub(['*']) })
    const previous = process.env.APP_MODE
    const previousMfa = process.env.MFA_REQUIRED_FOR_ADMINS
    process.env.APP_MODE = 'production'
    // 本用例只验证运营租户配置；管理员强制多因素认证另有专门测试
    process.env.MFA_REQUIRED_FOR_ADMINS = 'false'
    delete process.env.PLATFORM_OPERATOR_TENANT_ID
    const res = await harness.call('GET', '/commerce/admin/plans')
    process.env.APP_MODE = previous
    if (previousMfa === undefined) delete process.env.MFA_REQUIRED_FOR_ADMINS
    else process.env.MFA_REQUIRED_FOR_ADMINS = previousMfa
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('PLATFORM_OPERATOR_TENANT_NOT_CONFIGURED')
  })
})
