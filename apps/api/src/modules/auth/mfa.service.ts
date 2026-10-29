import { Injectable, OnModuleInit } from '@nestjs/common'
import { RECOVERY_CODE_COUNT, RECOVERY_CODE_PATTERN } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { RateLimitService } from '../../platform/rate-limit.service'
import { SecretBoxService } from '../../platform/security/secret-box.service'
import { StepUpService } from '../../platform/write'
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, TOTP_STEP_SECONDS, totpStep, verifyTotp } from './totp'

const ISSUER = 'NOVA ERP'
const FAILURE_LIMIT = 10
const FAILURE_LOCK_SECONDS = 15 * 60

/** 拥有任一项即视为管理员：所有者（全部权限）、管理员（成员管理、角色管理、接口开关）。管理员必须绑定多因素认证。 */
const ADMIN_MARKER_PERMISSIONS = ['member.manage', 'role.manage', 'settings.integration.write']
export const isAdminPermissions = (permissions: readonly string[]) => ADMIN_MARKER_PERMISSIONS.some(permission => hasPermission(permissions, permission))

/** 是否强制管理员绑定多因素认证：生产环境默认开启；其他环境默认关闭（可用 MFA_REQUIRED_FOR_ADMINS 显式设置）。 */
export function mfaRequiredForAdmins(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MFA_REQUIRED_FOR_ADMINS === 'true') return true
  if (env.MFA_REQUIRED_FOR_ADMINS === 'false') return false
  return env.APP_MODE === 'production'
}

// 多因素认证（P1-17）：动态验证码（TOTP）+ 恢复码。
// 密钥与恢复码哈希都用应用层密钥加密后保存；验证码一步只能用一次（防重放）；连续失败会锁定一段时间。
@Injectable()
export class MfaService implements OnModuleInit {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly stepUp: StepUpService,
    private readonly secrets: SecretBoxService,
  ) {}

  // 再次验证身份（step-up）选择“动态验证码”时，由这里校验
  onModuleInit() {
    this.stepUp.registerTotpVerifier((userId, code) => this.checkTotpCode(userId, code))
  }

  async status(userId: string) {
    const [totp, recovery] = await Promise.all([
      this.prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: 'TOTP' } } }),
      this.prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: 'RECOVERY_CODE' } } }),
    ])
    return {
      enrolled: Boolean(totp?.verifiedAt),
      pending: Boolean(totp && !totp.verifiedAt),
      recoveryCodesRemaining: recovery ? (await this.readHashes(recovery)).length : 0,
    }
  }

  async isEnrolled(userId: string): Promise<boolean> {
    const factor = await this.prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: 'TOTP' } }, select: { verifiedAt: true } })
    return Boolean(factor?.verifiedAt)
  }

  /** 管理员且尚未绑定：除认证相关接口外一律拒绝（由 ContextService 调用）。 */
  async enrollmentRequired(userId: string, permissions: readonly string[]): Promise<boolean> {
    if (!mfaRequiredForAdmins() || !isAdminPermissions(permissions)) return false
    return !(await this.isEnrolled(userId))
  }

  /** 获取绑定信息：生成新密钥并保存为“待验证”。已经完成绑定的用户不能再次获取。 */
  async enroll(userId: string, account: string) {
    const existing = await this.prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: 'TOTP' } } })
    if (existing?.verifiedAt) throw appError('MFA_ALREADY_ENROLLED', '已经绑定并验证过多因素认证')
    const secret = generateTotpSecret()
    const sealed = await this.secrets.sealMfa(secret)
    await this.prisma.mfaFactor.upsert({
      where: { userId_kind: { userId, kind: 'TOTP' } },
      create: { userId, kind: 'TOTP', secretCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion },
      update: { secretCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, verifiedAt: null, lastUsedAt: null },
    })
    return { secret, otpauthUri: otpauthUri({ issuer: ISSUER, account, secret }), issuer: ISSUER, account }
  }

  /**
   * 提交验证码。
   * - 首次（待验证）：必须是 6 位动态验证码；通过后完成绑定，并一次性发放恢复码。
   * - 已绑定：6 位动态验证码用于确认；恢复码用于设备丢失时验证，用后作废。
   */
  async verify(userId: string, code: string) {
    await this.rateLimit.assertUnlocked('mfa', userId)
    const factor = await this.prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: 'TOTP' } } })
    if (!factor) throw appError('MFA_NOT_ENROLLED', '请先获取绑定信息并在验证器应用中添加')

    if (RECOVERY_CODE_PATTERN.test(code)) {
      if (!factor.verifiedAt) throw appError('MFA_NOT_ENROLLED', '请先用验证器里的 6 位验证码完成绑定')
      const remaining = await this.consumeRecoveryCode(userId, code)
      if (remaining === null) return this.reject(userId)
      return { verified: true as const, method: 'RECOVERY_CODE' as const, recoveryCodesRemaining: remaining }
    }

    if (!(await this.acceptTotp(factor, code))) return this.reject(userId)
    await this.rateLimit.clearFailures('mfa', userId)
    if (factor.verifiedAt) return { verified: true as const, method: 'TOTP' as const }
    await this.prisma.mfaFactor.update({ where: { id: factor.id }, data: { verifiedAt: new Date() } })
    return { verified: true as const, method: 'TOTP' as const, recoveryCodes: await this.issueRecoveryCodes(userId) }
  }

  /** 再次验证身份用：只校验已完成绑定的动态验证码，返回对错（失败次数同样计入锁定）。 */
  async checkTotpCode(userId: string, code: string): Promise<boolean> {
    await this.rateLimit.assertUnlocked('mfa', userId)
    const factor = await this.prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: 'TOTP' } } })
    if (!factor?.verifiedAt) return false
    const accepted = await this.acceptTotp(factor, code)
    if (!accepted) await this.rateLimit.recordFailure('mfa', userId, FAILURE_LIMIT, FAILURE_LOCK_SECONDS)
    else await this.rateLimit.clearFailures('mfa', userId)
    return accepted
  }

  private async reject(userId: string): Promise<never> {
    await this.rateLimit.recordFailure('mfa', userId, FAILURE_LIMIT, FAILURE_LOCK_SECONDS)
    throw appError('MFA_CODE_INVALID', '验证码不正确或已使用过')
  }

  /** 校验动态验证码并占用该时间步：同一步的验证码只能用一次，并发提交同一个验证码只有一个成功。 */
  private async acceptTotp(factor: { id: string; secretCiphertext: string; keyVersion: number; lastUsedAt: Date | null }, code: string): Promise<boolean> {
    const secret = await this.secrets.openMfa(factor.secretCiphertext)
    const lastUsedStep = factor.lastUsedAt ? totpStep(factor.lastUsedAt.getTime()) : null
    const check = verifyTotp(secret, code, Date.now(), { lastUsedStep })
    if (!check.ok) return false
    const claimed = await this.prisma.mfaFactor.updateMany({ where: { id: factor.id, lastUsedAt: factor.lastUsedAt }, data: { lastUsedAt: new Date(check.step * TOTP_STEP_SECONDS * 1000) } })
    return claimed.count === 1
  }

  private async readHashes(factor: { secretCiphertext: string }): Promise<string[]> {
    return JSON.parse(await this.secrets.openMfa(factor.secretCiphertext)) as string[]
  }

  /** 发放新的一组恢复码（旧的整体作废）；明文只在这一次返回。 */
  private async issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT)
    const sealed = await this.secrets.sealMfa(JSON.stringify(codes.map(hashRecoveryCode)))
    await this.prisma.mfaFactor.upsert({
      where: { userId_kind: { userId, kind: 'RECOVERY_CODE' } },
      create: { userId, kind: 'RECOVERY_CODE', secretCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, verifiedAt: new Date() },
      update: { secretCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, verifiedAt: new Date() },
    })
    return codes
  }

  /** 使用一枚恢复码：命中则作废并返回剩余数量；不存在返回 null。以乐观比较保证同一枚恢复码并发提交只有一次成功。 */
  private async consumeRecoveryCode(userId: string, code: string): Promise<number | null> {
    const factor = await this.prisma.mfaFactor.findUnique({ where: { userId_kind: { userId, kind: 'RECOVERY_CODE' } } })
    if (!factor) return null
    const hashes = await this.readHashes(factor)
    const hash = hashRecoveryCode(code)
    if (!hashes.includes(hash)) return null
    const rest = hashes.filter(item => item !== hash)
    const sealed = await this.secrets.sealMfa(JSON.stringify(rest))
    const claimed = await this.prisma.mfaFactor.updateMany({
      where: { id: factor.id, secretCiphertext: factor.secretCiphertext },
      data: { secretCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, lastUsedAt: new Date() },
    })
    return claimed.count === 1 ? rest.length : null
  }
}
