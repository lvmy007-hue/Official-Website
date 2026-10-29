import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const emptyReads = () => ({
  sellerAccount: { findMany: vi.fn().mockResolvedValue([]) },
  adsProfile: { findMany: vi.fn().mockResolvedValue([]) },
  legalEntity: { findMany: vi.fn().mockResolvedValue([{ id: 'le1', name: '星河贸易有限公司' }]) },
  alertRule: { findFirst: vi.fn().mockResolvedValue(null) },
  oAuthState: { findMany: vi.fn().mockResolvedValue([]) },
  dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
})

describe('连接中心总览', () => {
  it('不读刷新令牌（含密文），只列出明确允许的字段；响应里只有“有没有令牌”', async () => {
    const row = {
      id: 'c1',
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      externalAccountId: 'SELLER-A',
      refreshTokenUpdatedAt: new Date('2026-09-01T00:00:00Z'),
      grantedScopes: ['seller'],
      lastSuccessfulSyncAt: null,
      lastErrorCode: null,
      sellerAccountId: 's1',
      sellerAccount: { id: 's1', displayName: '主店', sellerId: 'SELLER-A', legalEntity: { name: '星河贸易有限公司' } },
      adsProfile: null,
      healthChecks: [],
    }
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ id: 'c1' }])
    const stub = sessionStub(['connection.read'])
    harness = await createTestApp({ ...stub, ...emptyReads(), membership: { findFirst: stub.membership.findFirst, findMany: vi.fn().mockResolvedValue([]) }, platformConnection: { findMany } })
    const res = await harness.call('GET', '/connections')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const main = findMany.mock.calls[0][0]
    expect(main.where).toEqual({ tenantId: 'tenant-1' })
    expect(main.select.encryptedRefreshToken).toBeUndefined()
    expect(findMany.mock.calls[1][0].select).toEqual({ id: true })
    expect(findMany.mock.calls[1][0].where.encryptedRefreshToken).toEqual({ not: null })
    expect(JSON.stringify(res.json)).not.toMatch(/encryptedRefreshToken|ciphertext/i)
    const item = res.json.data.items.find((entry: { id: string }) => entry.id === 'c1')
    expect(item).toMatchObject({ kind: 'SELLER', hasToken: true, accountLabel: '主店（SELLER-A）', subject: '星河贸易有限公司' })
    expect(res.json.data.canManage).toBe(false) // 只有读取权限：不能管理，授权主体清单不下发
    expect(res.json.data.legalEntities).toEqual([])
    expect(res.json.data.roles.modules.length).toBeGreaterThan(10)
  })

  it('没有读取权限返回 403', async () => {
    harness = await createTestApp({ ...sessionStub(['x.nothing']) })
    expect((await harness.call('GET', '/connections')).status).toBe(403)
  })
})

describe('连接动作的权限与顺序', () => {
  it('健康检查、重新授权、断开都需要“管理连接”权限；只有读取权限一律 403（先于参数校验）', async () => {
    harness = await createTestApp({ ...sessionStub(['connection.read']), stepUpVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() } })
    expect((await harness.call('POST', '/connections/c1/health-check')).status).toBe(403)
    expect((await harness.call('POST', '/connections/c1/reauthorize')).status).toBe(403)
    expect((await harness.call('POST', '/connections/c1/disconnect', { body: {} })).status).toBe(403)
  })

  it('断开要先通过再次验证身份：没验证过返回 STEP_UP_REQUIRED，不会走到业务', async () => {
    const findFirst = vi.fn()
    harness = await createTestApp({ ...sessionStub(['connection.manage']), platformConnection: { findFirst } })
    const res = await harness.call('POST', '/connections/c1/disconnect', { body: { reason: '不再使用这个店铺' } })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('STEP_UP_REQUIRED')
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('断开不写原因：422，且不去查连接', async () => {
    const findFirst = vi.fn()
    harness = await createTestApp({
      ...sessionStub(['connection.manage']),
      stepUpVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() },
      platformConnection: { findFirst },
    })
    const res = await harness.call('POST', '/connections/c1/disconnect', { body: {} })
    expect(res.status).toBe(422)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('写动作缺少幂等键：400', async () => {
    harness = await createTestApp({ ...sessionStub(['connection.manage']) })
    const res = await harness.call('POST', '/connections/c1/health-check', { idempotencyKey: false })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('找不到的连接（含不在数据范围内与别的企业的）一律 404', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    harness = await createTestApp({ ...sessionStub(['connection.manage']), platformConnection: { findFirst } })
    const res = await harness.call('POST', '/connections/other-tenant-conn/health-check')
    expect(res.status).toBe(404)
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: 'other-tenant-conn', tenantId: 'tenant-1' })
  })
})

describe('授权回调', () => {
  it('授权被拒绝：跳回前端并带错误码，不泄露细节', async () => {
    harness = await createTestApp({})
    const res = await harness.call('GET', '/sp-api/oauth/callback?error=access_denied', { auth: false })
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/app/connections')
    expect(location).toContain('provider=sp-api&status=error&code=OAUTH_CALLBACK_DENIED')
  })

  it('广告授权回调缺少参数同样跳回前端', async () => {
    harness = await createTestApp({})
    const res = await harness.call('GET', '/ads/oauth/callback', { auth: false })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('provider=ads&status=error&code=ADS_OAUTH_CALLBACK_INVALID')
  })

  it('发起授权需要连接管理权限', async () => {
    harness = await createTestApp({ ...sessionStub(['seller.read']) })
    expect((await harness.call('POST', '/ads/oauth/start')).status).toBe(403)
  })
})
