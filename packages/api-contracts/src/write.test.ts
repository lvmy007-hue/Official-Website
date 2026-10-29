import { describe, expect, it } from 'vitest'
import { ERROR_CODES, IdempotencyKeySchema, ReasonBodySchema, STEP_UP_ACTIONS, STEP_UP_TTL_MINUTES, StepUpBodySchema, VersionBodySchema, isErrorCode } from './index.js'

describe('幂等键', () => {
  it('随机 UUID、带前缀的键合法；过短、过长、含空格或中文不合法', () => {
    expect(IdempotencyKeySchema.safeParse('3f2b8c1e-5d6a-4b7c-9e0f-1a2b3c4d5e6f').success).toBe(true)
    expect(IdempotencyKeySchema.safeParse('web:orders:create:0001').success).toBe(true)
    expect(IdempotencyKeySchema.safeParse('short').success).toBe(false)
    expect(IdempotencyKeySchema.safeParse('a'.repeat(129)).success).toBe(false)
    expect(IdempotencyKeySchema.safeParse('has space 12345').success).toBe(false)
    expect(IdempotencyKeySchema.safeParse('键值键值键值键值键值').success).toBe(false)
  })
})

describe('再次验证身份契约', () => {
  it('密码方式需要密码，验证码方式需要 6 位数字，操作必须是登记过的', () => {
    expect(StepUpBodySchema.safeParse({ action: 'role.manage', password: 'x' }).success).toBe(true)
    expect(StepUpBodySchema.parse({ action: 'role.manage', password: 'x' }).method).toBe('PASSWORD')
    expect(StepUpBodySchema.safeParse({ action: 'role.manage' }).success).toBe(false)
    expect(StepUpBodySchema.safeParse({ action: 'role.manage', method: 'TOTP', code: '123456' }).success).toBe(true)
    expect(StepUpBodySchema.safeParse({ action: 'role.manage', method: 'TOTP', code: '12345' }).success).toBe(false)
    expect(StepUpBodySchema.safeParse({ action: 'drop.database', password: 'x' }).success).toBe(false)
  })

  it('权限文档第七节列出的操作都已登记，有效期 10 分钟', () => {
    for (const action of ['switch.enable', 'finance.period.reopen', 'connection.disconnect', 'member.manage', 'role.manage', 'pii.access', 'export.sensitive', 'fx.write', 'finance.policy']) {
      expect(action in STEP_UP_ACTIONS, action).toBe(true)
    }
    expect(STEP_UP_TTL_MINUTES).toBe(10)
  })
})

describe('原因与版本契约', () => {
  it('原因至少 2 个字、最多 500 字；版本号为正整数', () => {
    expect(ReasonBodySchema.safeParse({ reason: '客户要求停用' }).success).toBe(true)
    expect(ReasonBodySchema.safeParse({ reason: ' ' }).success).toBe(false)
    expect(ReasonBodySchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false)
    expect(VersionBodySchema.safeParse({ version: 3 }).success).toBe(true)
    expect(VersionBodySchema.safeParse({ version: 0 }).success).toBe(false)
    expect(VersionBodySchema.safeParse({ version: 1.5 }).success).toBe(false)
  })
})

describe('错误码目录', () => {
  it('乐观锁冲突、再次验证、幂等相关的错误码与接口清单一致', () => {
    expect(ERROR_CODES.CONFLICT.status).toBe(409)
    expect(ERROR_CODES.STEP_UP_REQUIRED.status).toBe(403)
    expect(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED.status).toBe(400)
    expect(ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.retryable).toBe(true)
    expect(isErrorCode('CONFLICT')).toBe(true)
    expect(isErrorCode('NOT_A_CODE')).toBe(false)
  })
})
