import { JwtService } from '@nestjs/jwt'
import { hash } from 'bcryptjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { platformJwtSecret } from '../auth'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

type Admin = {
  id: string
  email: string
  name: string
  role: string
  status: string
  tokenValidAfter: Date | null
  passwordHash?: string
  mfaVerifiedAt?: Date | null
  mfaSecretCiphertext?: string | null
}

function adminRow(extra: Partial<Admin> = {}): Admin {
  return { id: 'pa-1', email: 'ops@dzanx.example', name: '平台运营', role: 'PLATFORM_OPS', status: 'ACTIVE', tokenValidAfter: null, ...extra }
}

function platformPrisma(admin: Admin | null) {
  return {
    ...sessionStub(['*']),
    platformAdmin: { findUnique: vi.fn().mockResolvedValue(admin), update: vi.fn().mockResolvedValue({}) },
    tenant: { findMany: vi.fn().mockResolvedValue([]) },
    sellerAccount: { groupBy: vi.fn().mockResolvedValue([]) },
    membership: { groupBy: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    platformAuditEvent: { create: vi.fn().mockResolvedValue({}) },
    platformSupportAccess: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

async function platformToken(payload: Record<string, unknown> = {}, iatSeconds?: number) {
  const jwt = harness!.app.get(JwtService)
  return jwt.signAsync({ typ: 'platform', adminId: 'pa-1', ...(iatSeconds ? { iat: iatSeconds } : {}), ...payload }, { secret: platformJwtSecret(), expiresIn: '1h' })
}

describe('平台账号访问控制', () => {
  it('没有令牌、或用企业成员的令牌访问平台接口，一律 401（令牌密钥不同）', async () => {
    harness = await createTestApp(platformPrisma(adminRow()))
    const anonymous = await harness.call('GET', '/platform/tenants', { auth: false })
    expect(anonymous.status).toBe(401)
    expect(anonymous.json.error.code).toBe('PLATFORM_AUTH_REQUIRED')
    const member = await harness.call('GET', '/platform/tenants')
    expect(member.status).toBe(401)
    expect(member.json.error.code).toBe('PLATFORM_AUTH_REQUIRED')
  })

  it('平台令牌：按角色放行；支持角色能看企业列表，但不能暂停企业（403）', async () => {
    harness = await createTestApp(platformPrisma(adminRow({ role: 'PLATFORM_SUPPORT' })))
    const headers = { authorization: `Bearer ${await platformToken()}` }
    const list = await harness.call('GET', '/platform/tenants', { auth: false, headers })
    expect(list.status).toBe(200)
    const suspend = await harness.call('POST', '/platform/tenants/t1/suspend', { auth: false, headers, body: { reason: '欠费催缴无果' } })
    expect(suspend.status).toBe(403)
    expect(suspend.json.error.code).toBe('PLATFORM_PERMISSION_DENIED')
  })

  it('账号已停用、或令牌签发早于“全部失效时间”，令牌立即失效', async () => {
    harness = await createTestApp(platformPrisma(adminRow({ status: 'DISABLED' })))
    const headers = { authorization: `Bearer ${await platformToken()}` }
    expect((await harness.call('GET', '/platform/tenants', { auth: false, headers })).status).toBe(401)
    await harness.close()

    const nowSeconds = Math.floor(Date.now() / 1000)
    harness = await createTestApp(platformPrisma(adminRow({ tokenValidAfter: new Date((nowSeconds + 60) * 1000) })))
    const stale = { authorization: `Bearer ${await platformToken({}, nowSeconds)}` }
    expect((await harness.call('GET', '/platform/tenants', { auth: false, headers: stale })).status).toBe(401)
  })

  it('支持访问令牌、验证挑战令牌不能当作平台登录令牌使用', async () => {
    harness = await createTestApp(platformPrisma(adminRow()))
    for (const typ of ['support', 'platform-mfa']) {
      const headers = { authorization: `Bearer ${await platformToken({ typ })}` }
      expect((await harness.call('GET', '/platform/tenants', { auth: false, headers })).status).toBe(401)
    }
  })
})

describe('平台账号登录（密码 + 动态验证码）', () => {
  it('账号不存在或密码错误：同样的提示（不泄露账号是否存在），并记录失败次数', async () => {
    const prisma = platformPrisma(null)
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/platform/auth/login', { auth: false, body: { email: 'nobody@dzanx.example', password: 'whatever-123' } })
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('PLATFORM_LOGIN_FAILED')
    expect(harness.rateLimit.recordFailure).toHaveBeenCalledWith('platform-login', 'nobody@dzanx.example', expect.any(Number), expect.any(Number))
  })

  it('已绑定动态验证码的账号：密码正确只进入“输入验证码”阶段，不返回令牌与密钥；验证码错误被拒绝', async () => {
    const passwordHash = await hash('Correct-Horse-9', 4)
    harness = await createTestApp(platformPrisma(adminRow({ passwordHash, mfaVerifiedAt: new Date(), mfaSecretCiphertext: 'cipher' })))
    const login = await harness.call('POST', '/platform/auth/login', { auth: false, body: { email: 'ops@dzanx.example', password: 'Correct-Horse-9' } })
    expect(login.status).toBe(200)
    expect(login.json.data.stage).toBe('VERIFY')
    expect(login.json.data.challengeToken).toBeTruthy()
    expect(login.json.data.token).toBeUndefined()
    expect(login.json.data.secret).toBeUndefined()

    const wrongPassword = await harness.call('POST', '/platform/auth/login', { auth: false, body: { email: 'ops@dzanx.example', password: 'Wrong-Password-1' } })
    expect(wrongPassword.json.error.code).toBe('PLATFORM_LOGIN_FAILED')

    const badChallenge = await harness.call('POST', '/platform/auth/mfa/verify', { auth: false, body: { challengeToken: 'not-a-token-but-long-enough', code: '123456' } })
    expect(badChallenge.json.error.code).toBe('PLATFORM_MFA_CHALLENGE_INVALID')
  })
})
