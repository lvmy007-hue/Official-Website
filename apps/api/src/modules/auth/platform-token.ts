import { createHmac } from 'node:crypto'

// 平台运营账号与支持访问使用的令牌（P1-19）。
// 与租户成员的访问令牌分开签名：密钥由 PLATFORM_JWT_SECRET 指定；没有单独配置时，用 JWT_SECRET 派生出另一把密钥。
// 因此租户令牌无法冒充平台令牌，反之亦然。

export function platformJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env.PLATFORM_JWT_SECRET
  if (dedicated && dedicated.length >= 32) return dedicated
  const base = env.JWT_SECRET
  if (!base) throw new Error('JWT_SECRET 未配置，无法签发平台令牌')
  return createHmac('sha256', base).update('nova-platform-token-v1').digest('hex')
}

/** 平台账号的登录令牌：只能访问 /platform/* 接口。 */
export interface PlatformTokenPayload {
  typ: 'platform'
  adminId: string
}

/** 登录第一步（密码通过）后的验证挑战：只能用于提交动态验证码。 */
export interface PlatformChallengePayload {
  typ: 'platform-mfa'
  adminId: string
  /** ENROLL：尚未绑定动态验证码，本次需要先绑定；VERIFY：已绑定，只需验证 */
  stage: 'ENROLL' | 'VERIFY'
}

/** 支持访问会话令牌：绑定到一条企业授权记录，只读，用于访问该企业的普通接口。 */
export interface SupportTokenPayload {
  typ: 'support'
  adminId: string
  accessId: string
  tenantId: string
}

/** 平台账号登录令牌有效期（分钟）：平台操作都要重新校验账号状态，不做刷新，到期重新登录 */
export const PLATFORM_TOKEN_MINUTES = 60
export const PLATFORM_CHALLENGE_MINUTES = 5

/** 支持访问时在 userId 前加的前缀：成员编号不会带它，下游代码一眼能分辨 */
export const SUPPORT_USER_PREFIX = 'support:'
