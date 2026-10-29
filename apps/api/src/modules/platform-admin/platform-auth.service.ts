import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { platformPermissionsOf } from '@nova/authz'
import { compare, hash } from 'bcryptjs'
import { appError } from '../../platform/http'
import { logger } from '../../platform/observability'
import { SystemPrismaService } from '../../platform/prisma.service'
import { RateLimitService } from '../../platform/rate-limit.service'
import { SecretBoxService } from '../../platform/security/secret-box.service'
import { generateTotpSecret, otpauthUri, PLATFORM_CHALLENGE_MINUTES, PLATFORM_TOKEN_MINUTES, platformJwtSecret, verifyTotp, type PlatformChallengePayload, type PlatformTokenPayload } from '../auth'

const ISSUER = 'NOVA ERP 平台'
const FAILURE_LIMIT = 5
const LOCK_SECONDS = 30 * 60
// 账号不存在时也比较一次哈希，使“账号不存在”与“密码错误”的耗时一致，避免被用来探测账号
let dummyHash: Promise<string> | undefined
const dummyPasswordHash = () => (dummyHash ??= hash('nova-platform-dummy-password', 12))

// 平台账号登录（P1-19）：密码 + 动态验证码两步，缺一不可，动态验证码强制。
// 第一步（密码通过）只发放“验证挑战”，不发放访问令牌；第二步提交验证码后才签发 60 分钟的平台令牌。
// 还没有绑定验证器的账号，第一步同时返回绑定信息（密钥只在密码通过后返回），首次验证通过即完成绑定。
// 失败 5 次锁定 30 分钟；同一验证码时间步只能使用一次（防重放）。
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly jwt: JwtService,
    private readonly rateLimit: RateLimitService,
    private readonly secrets: SecretBoxService,
  ) {}

  async login(email: string, password: string) {
    await this.rateLimit.assertUnlocked('platform-login', email)
    const admin = await this.prisma.platformAdmin.findUnique({ where: { email } })
    const passwordOk = await compare(password, admin?.passwordHash ?? (await dummyPasswordHash()))
    if (!admin || admin.status !== 'ACTIVE' || !passwordOk) {
      logger.warn({ event: 'platform_login_failed' }, '平台账号登录失败')
      await this.rateLimit.recordFailure('platform-login', email, FAILURE_LIMIT, LOCK_SECONDS)
      throw appError('PLATFORM_LOGIN_FAILED', '平台账号或密码不正确')
    }
    await this.rateLimit.clearFailures('platform-login', email)

    const stage = admin.mfaVerifiedAt ? 'VERIFY' : 'ENROLL'
    const challengeToken = await this.jwt.signAsync({ typ: 'platform-mfa', adminId: admin.id, stage } satisfies PlatformChallengePayload, {
      secret: platformJwtSecret(),
      expiresIn: `${PLATFORM_CHALLENGE_MINUTES}m`,
    })
    if (stage === 'VERIFY') return { stage, challengeToken }
    // 尚未绑定：沿用已生成但还没验证的密钥（刷新页面后仍然是同一个二维码），没有就新生成
    let ciphertext = admin.mfaSecretCiphertext
    if (!ciphertext) {
      const sealed = await this.secrets.sealMfa(generateTotpSecret())
      await this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { mfaSecretCiphertext: sealed.ciphertext, mfaKeyVersion: sealed.keyVersion } })
      ciphertext = sealed.ciphertext
    }
    const secret = await this.secrets.openMfa(ciphertext)
    return { stage, challengeToken, secret, otpauthUri: otpauthUri({ issuer: ISSUER, account: admin.email, secret }), issuer: ISSUER }
  }

  async verifyMfa(challengeToken: string, code: string) {
    let challenge: PlatformChallengePayload
    try {
      challenge = await this.jwt.verifyAsync<PlatformChallengePayload>(challengeToken, { secret: platformJwtSecret() })
    } catch {
      throw appError('PLATFORM_MFA_CHALLENGE_INVALID', '验证挑战无效或已过期，请重新登录')
    }
    if (challenge.typ !== 'platform-mfa') throw appError('PLATFORM_MFA_CHALLENGE_INVALID', '验证挑战无效或已过期，请重新登录')
    await this.rateLimit.assertUnlocked('platform-mfa', challenge.adminId)
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: challenge.adminId } })
    if (!admin || admin.status !== 'ACTIVE' || !admin.mfaSecretCiphertext) throw appError('PLATFORM_MFA_CHALLENGE_INVALID', '验证挑战无效或已过期，请重新登录')

    const secret = await this.secrets.openMfa(admin.mfaSecretCiphertext)
    const check = verifyTotp(secret, code, Date.now(), { lastUsedStep: admin.mfaLastStep })
    // 占用这个时间步：并发提交同一个验证码只有一个成功
    const claimed = check.ok ? await this.prisma.platformAdmin.updateMany({ where: { id: admin.id, mfaLastStep: admin.mfaLastStep }, data: { mfaLastStep: check.step } }) : null
    if (!check.ok || claimed?.count !== 1) {
      await this.rateLimit.recordFailure('platform-mfa', admin.id, FAILURE_LIMIT, LOCK_SECONDS)
      throw appError('MFA_CODE_INVALID', '验证码不正确或已使用过')
    }
    await this.rateLimit.clearFailures('platform-mfa', admin.id)
    await this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date(), ...(admin.mfaVerifiedAt ? {} : { mfaVerifiedAt: new Date() }) } })
    logger.info({ event: 'platform_login_succeeded', adminId: admin.id, role: admin.role }, '平台账号登录成功')
    const accessToken = await this.jwt.signAsync({ typ: 'platform', adminId: admin.id } satisfies PlatformTokenPayload, { secret: platformJwtSecret(), expiresIn: `${PLATFORM_TOKEN_MINUTES}m` })
    return { accessToken, expiresInSeconds: PLATFORM_TOKEN_MINUTES * 60, admin: this.present(admin) }
  }

  /** 再次校验动态验证码（高风险操作：注销企业、领取支持访问）。成功占用该时间步。 */
  async confirmCode(adminId: string, code: string): Promise<void> {
    await this.rateLimit.assertUnlocked('platform-mfa', adminId)
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: adminId } })
    if (!admin?.mfaSecretCiphertext || !admin.mfaVerifiedAt) throw appError('MFA_NOT_ENROLLED', '平台账号尚未绑定动态验证码')
    const check = verifyTotp(await this.secrets.openMfa(admin.mfaSecretCiphertext), code, Date.now(), { lastUsedStep: admin.mfaLastStep })
    const claimed = check.ok ? await this.prisma.platformAdmin.updateMany({ where: { id: admin.id, mfaLastStep: admin.mfaLastStep }, data: { mfaLastStep: check.step } }) : null
    if (!check.ok || claimed?.count !== 1) {
      await this.rateLimit.recordFailure('platform-mfa', admin.id, FAILURE_LIMIT, LOCK_SECONDS)
      throw appError('STEP_UP_FAILED', '动态验证码不正确或已使用过（同一个验证码只能用一次，请等待下一个）')
    }
    await this.rateLimit.clearFailures('platform-mfa', admin.id)
  }

  /** 注销：此前签发的全部令牌立即失效。 */
  async logout(adminId: string) {
    await this.prisma.platformAdmin.update({ where: { id: adminId }, data: { tokenValidAfter: new Date() } })
  }

  present(admin: { id: string; email: string; name: string; role: string }) {
    return { id: admin.id, email: admin.email, name: admin.name, role: admin.role, permissions: platformPermissionsOf(admin.role) }
  }
}
