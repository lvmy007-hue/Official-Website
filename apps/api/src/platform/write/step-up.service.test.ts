import { hashSync } from 'bcryptjs'
import { describe, expect, it, vi } from 'vitest'
import type { PrismaService } from '../prisma.service'
import type { RateLimitService } from '../rate-limit.service'
import type { ApiContext } from '../http'
import { AppError } from '../http'
import { StepUpService, isStepUpAction } from './step-up.service'

const context: ApiContext = { userId: 'u1', sessionId: 's1', tenantId: 't1', membershipId: 'm1', permissions: [] }

function setup(options: { status?: string; verification?: { id: string } | null } = {}) {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ passwordHash: hashSync('right-password', 4), status: options.status ?? 'ACTIVE' }) },
    stepUpVerification: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'su-1', action: data.action, method: data.method, expiresAt: data.expiresAt })),
      findFirst: vi.fn().mockResolvedValue(options.verification ?? null),
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  }
  const rateLimit = { check: vi.fn().mockResolvedValue(undefined) }
  const service = new StepUpService(prisma as unknown as PrismaService, rateLimit as unknown as RateLimitService)
  return { service, prisma, rateLimit }
}

describe('再次验证身份', () => {
  it('密码正确：记录该操作的验证，有效期 10 分钟', async () => {
    const { service, prisma } = setup()
    const result = await service.verify(context, { action: 'role.manage', method: 'PASSWORD', password: 'right-password' })
    expect(result).toMatchObject({ id: 'su-1', action: 'role.manage', method: 'PASSWORD' })
    const data = prisma.stepUpVerification.create.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: 't1', userId: 'u1', action: 'role.manage', method: 'PASSWORD' })
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(9.9 * 60_000)
    expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000)
  })

  it('密码错误、账号停用都不通过，也不留下验证记录', async () => {
    const wrong = setup()
    const error = await wrong.service.verify(context, { action: 'role.manage', method: 'PASSWORD', password: 'bad' }).then(
      () => null,
      e => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect(error.code).toBe('STEP_UP_FAILED')
    expect(wrong.prisma.stepUpVerification.create).not.toHaveBeenCalled()
    const disabled = setup({ status: 'DISABLED' })
    await expect(disabled.service.verify(context, { action: 'role.manage', method: 'PASSWORD', password: 'right-password' })).rejects.toMatchObject({ code: 'STEP_UP_FAILED' })
  })

  it('验证请求有频率限制，防止借此猜密码', async () => {
    const { service, rateLimit } = setup()
    await service.verify(context, { action: 'role.manage', method: 'PASSWORD', password: 'right-password' })
    expect(rateLimit.check).toHaveBeenCalledWith('step-up', 'u1', 10, 300)
  })

  it('验证码方式：多因素认证未就绪前明确提示；注册验证函数后按其结果判断', async () => {
    const { service } = setup()
    await expect(service.verify(context, { action: 'role.manage', method: 'TOTP', code: '123456' })).rejects.toMatchObject({ code: 'STEP_UP_FAILED', message: expect.stringContaining('多因素') })
    service.registerTotpVerifier(async (_user, code) => code === '654321')
    await expect(service.verify(context, { action: 'role.manage', method: 'TOTP', code: '000000' })).rejects.toMatchObject({ code: 'STEP_UP_FAILED' })
    expect(await service.verify(context, { action: 'role.manage', method: 'TOTP', code: '654321' })).toMatchObject({ method: 'TOTP' })
  })

  it('执行高风险操作前检查：没有有效验证返回 403 STEP_UP_REQUIRED 并带操作名；有则返回验证记录编号', async () => {
    const missing = setup()
    const error = await missing.service.require(context, 'switch.enable').then(
      () => null,
      e => e,
    )
    expect(error.code).toBe('STEP_UP_REQUIRED')
    expect(error.getStatus()).toBe(403)
    expect(error.details).toEqual({ action: 'switch.enable' })
    expect(missing.prisma.stepUpVerification.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', userId: 'u1', action: 'switch.enable' })
    const done = setup({ verification: { id: 'su-9' } })
    expect(await done.service.require(context, 'switch.enable')).toBe('su-9')
  })

  it('清理过期记录；操作名必须是登记过的', async () => {
    expect(await setup().service.purgeExpired()).toBe(2)
    expect(isStepUpAction('member.manage')).toBe(true)
    expect(isStepUpAction('delete.everything')).toBe(false)
  })
})
