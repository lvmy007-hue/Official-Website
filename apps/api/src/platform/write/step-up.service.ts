import { Injectable } from '@nestjs/common'
import { STEP_UP_ACTIONS, STEP_UP_TTL_MINUTES, type StepUpAction, type StepUpMethod } from '@nova/api-contracts'
import { compare } from 'bcryptjs'
import { ApiContext, appError } from '../http'
import { PrismaService } from '../prisma.service'
import { RateLimitService } from '../rate-limit.service'

export const isStepUpAction = (value: string): value is StepUpAction => Object.prototype.hasOwnProperty.call(STEP_UP_ACTIONS, value)

export type TotpVerifier = (userId: string, code: string) => Promise<boolean>

// 高风险操作的再次验证身份：验证通过后，对应操作在 10 分钟内可以执行；到期重新验证。
// 验证按“用户 + 企业 + 操作”分别计，不能拿一个操作的验证去执行另一个操作。
@Injectable()
export class StepUpService {
  private totpVerifier: TotpVerifier | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** 多因素认证（P1-17）就绪后注册验证函数；在此之前选择验证码方式会得到明确提示。 */
  registerTotpVerifier(verifier: TotpVerifier) {
    this.totpVerifier = verifier
  }

  async verify(context: ApiContext, input: { action: StepUpAction; method: StepUpMethod; password?: string; code?: string }) {
    // 防止拿再次验证来猜密码：每个用户 5 分钟最多 10 次
    await this.rateLimit.check('step-up', context.userId, 10, 300)
    const passed = input.method === 'PASSWORD' ? await this.checkPassword(context.userId, input.password ?? '') : await this.checkTotp(context.userId, input.code ?? '')
    if (!passed) throw appError('STEP_UP_FAILED', input.method === 'PASSWORD' ? '密码不正确，未通过再次验证' : '验证码不正确，未通过再次验证')
    const expiresAt = new Date(Date.now() + STEP_UP_TTL_MINUTES * 60_000)
    const record = await this.prisma.stepUpVerification.create({
      data: { tenantId: context.tenantId, userId: context.userId, action: input.action, method: input.method, expiresAt },
      select: { id: true, action: true, method: true, expiresAt: true },
    })
    return { id: record.id, action: record.action, method: record.method, expiresAt: record.expiresAt }
  }

  /** 要求该操作在有效期内已验证；通过返回验证记录编号（写入审计）。 */
  async require(context: ApiContext, action: StepUpAction): Promise<string> {
    const record = await this.prisma.stepUpVerification.findFirst({
      where: { tenantId: context.tenantId, userId: context.userId, action, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
      select: { id: true },
    })
    if (!record) {
      throw appError('STEP_UP_REQUIRED', `${STEP_UP_ACTIONS[action]}需要先再次验证身份（有效期 ${STEP_UP_TTL_MINUTES} 分钟）`, { details: { action } })
    }
    return record.id
  }

  /** 清理已过期的验证记录。 */
  async purgeExpired() {
    const result = await this.prisma.stepUpVerification.deleteMany({ where: { expiresAt: { lte: new Date() } } })
    return result.count
  }

  private async checkPassword(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, status: true } })
    return Boolean(user && user.status === 'ACTIVE' && password && (await compare(password, user.passwordHash)))
  }

  private async checkTotp(userId: string, code: string) {
    if (!this.totpVerifier) throw appError('STEP_UP_FAILED', '尚未绑定多因素认证，请使用密码完成再次验证')
    return this.totpVerifier(userId, code)
  }
}
