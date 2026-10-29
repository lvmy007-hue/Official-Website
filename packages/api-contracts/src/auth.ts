import { z } from 'zod'

// 认证加固的契约（P1-17）：多因素认证与会话。

/** 恢复码形如 ABCDE-FGHJK（去掉容易混淆的字符 0、1、O、I）。 */
export const RECOVERY_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/

/** POST /auth/mfa/verify：6 位动态验证码（首次验证完成绑定并领取恢复码），或一枚恢复码（设备丢失时使用，用后作废）。 */
export const MfaVerifyBodySchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .refine(value => /^\d{6}$/.test(value) || RECOVERY_CODE_PATTERN.test(value), '请输入 6 位动态验证码或恢复码'),
})
export type MfaVerifyBody = z.infer<typeof MfaVerifyBodySchema>

/** 恢复码的数量：绑定完成时一次性发放，只显示一次。 */
export const RECOVERY_CODE_COUNT = 10

/** 访问令牌有效期（分钟）、刷新凭据有效期（天）、无操作超时（分钟）。 */
export const ACCESS_TOKEN_MINUTES = 15
export const REFRESH_TOKEN_DAYS = 30
export const SESSION_IDLE_MINUTES = 15
/** 刷新凭据轮换后，旧凭据在这个宽限期内再次出现视为并发请求（例如两个标签页同时刷新），不当作被盗用。 */
export const REFRESH_REUSE_GRACE_SECONDS = 10
