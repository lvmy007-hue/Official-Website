import { Injectable } from '@nestjs/common'
import {
  FxCostDataSchema,
  MembersDataSchema,
  ONBOARDING_STEPS,
  OnboardingStepBodySchema,
  ProfileDataSchema,
  SyncScopeDataSchema,
  INVITATION_TTL_HOURS,
  type OnboardingStepKey,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { MailService } from '../../platform/mail'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { InitialSyncService } from './initial-sync.service'
import { appPublicUrl, generateInviteToken, hashInviteToken, inviteLink } from './invitation-token'
import { currentStep, isOnboardingComplete, parseOnboardingState, type OnboardingState } from './onboarding-state'
import { quotaUsage, type QuotaUsageClient } from './quota-usage'

/** 向导的各步骤是否满足前置条件（实时核对，不依赖保存的状态） */
type Prerequisite = { met: boolean; message?: string }

// 初始化向导（P1-19，12.7 第 4 条）：8 步，进度可保存、可恢复；必填步骤完成、选填步骤完成或跳过后，向导完成并触发首次同步。
// 未完成之前，前端外壳显示“未完成企业初始化”。向导只读写本企业的数据（租户连接，受行级安全约束）。
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly initialSync: InitialSyncService,
    private readonly mail: MailService,
  ) {}

  /** 取向导行；企业还没有向导记录（早于本功能开通的企业）时视为已完成，不打扰。 */
  private async row(tenantId: string) {
    return this.prisma.tenantOnboarding.findUnique({ where: { tenantId } })
  }

  private async prerequisites(tenantId: string): Promise<Record<OnboardingStepKey, Prerequisite>> {
    const [entities, spConnections, adsConnections, boundProfiles] = await Promise.all([
      this.prisma.legalEntity.count({ where: { tenantId } }),
      this.prisma.platformConnection.count({ where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED' } }),
      this.prisma.platformConnection.count({ where: { tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED' } }),
      this.prisma.adsProfile.count({ where: { tenantId, sellerAccountId: { not: null } } }),
    ])
    const ok: Prerequisite = { met: true }
    return {
      PROFILE: ok,
      ENTITIES: entities > 0 ? ok : { met: false, message: '请先在“法律主体”页登记至少一个法律主体' },
      SELLER_AUTH: spConnections > 0 ? ok : { met: false, message: '请先完成至少一个店铺的卖家接口授权' },
      ADS_AUTH: adsConnections > 0 && boundProfiles > 0 ? ok : { met: false, message: '请先完成广告授权，并把广告账户绑定到店铺' },
      SYNC_SCOPE: ok,
      FX_COST: ok,
      MEMBERS: ok,
      WRITE_SWITCHES: ok,
    }
  }

  async get(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'settings.write')
    return this.present(context.tenantId)
  }

  private async present(tenantId: string) {
    const [row, tenant, prerequisites, quotas] = await Promise.all([
      this.row(tenantId),
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, timezone: true, localTimezone: true, defaultCurrency: true } }),
      this.prerequisites(tenantId),
      quotaUsage(this.prisma as unknown as QuotaUsageClient, tenantId),
    ])
    if (!row) return { initialized: true, version: 0, completed: true, completedAt: null, currentStep: 'DONE' as const, steps: [], tenant, quotas, firstSync: null }
    const state = parseOnboardingState(row.stepStateJson)
    return {
      initialized: true,
      version: row.version,
      completed: Boolean(row.completedAt),
      completedAt: row.completedAt,
      currentStep: currentStep(state),
      steps: ONBOARDING_STEPS.map(step => ({ ...step, state: state.steps[step.key].state, data: state.steps[step.key].data ?? null, prerequisite: prerequisites[step.key] })),
      tenant,
      quotas,
      firstSync: state.firstSync ?? null,
    }
  }

  /** 外壳用：向导是否已完成（没有记录的企业视为已完成）。 */
  async isCompleted(tenantId: string): Promise<boolean> {
    const row = await this.row(tenantId)
    return !row || Boolean(row.completedAt)
  }

  async patch(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, 'settings.write')
    const body = OnboardingStepBodySchema.parse(rawBody)
    const row = await this.row(context.tenantId)
    if (!row) throw appError('RESOURCE_NOT_FOUND', '企业没有初始化向导')
    if (row.completedAt) throw appError('ONBOARDING_STEP_INVALID', '初始化向导已完成，请到对应的设置页面修改')
    if (row.version !== body.version) throw appError('CONFLICT', '向导内容已被他人更新，请刷新后再操作')

    const spec = ONBOARDING_STEPS.find(step => step.key === body.step)!
    const state = parseOnboardingState(row.stepStateJson)
    const invitations: Array<{ email: string; link: string | null; expiresAt: Date; emailed: boolean }> = []
    const warnings: string[] = []

    if (body.action === 'SKIP') {
      if (spec.required) throw appError('ONBOARDING_STEP_NOT_SKIPPABLE', `“${spec.title}”是必填步骤，不能跳过`)
      state.steps[body.step] = { state: 'SKIPPED', updatedAt: new Date().toISOString() }
    } else {
      const data = this.validateData(body.step, body.data)
      if (body.action === 'COMPLETE') {
        const prerequisite = (await this.prerequisites(context.tenantId))[body.step]
        if (!prerequisite.met) throw appError('ONBOARDING_PREREQUISITE_MISSING', prerequisite.message ?? '前置条件尚未满足')
        await this.apply(req, context, body.step, data, invitations, warnings)
      }
      state.steps[body.step] = { state: body.action === 'COMPLETE' ? 'COMPLETED' : 'PENDING', data: data ?? state.steps[body.step].data, updatedAt: new Date().toISOString() }
    }

    const finished = isOnboardingComplete(state)
    if (finished) await this.startFirstSync(req, context.tenantId, state)
    const saved = await this.prisma.tenantOnboarding.updateMany({
      where: { tenantId: context.tenantId, version: row.version },
      data: { step: currentStep(state), stepStateJson: state as unknown as object, version: { increment: 1 }, ...(finished ? { completedAt: new Date() } : {}) },
    })
    if (saved.count !== 1) throw appError('CONFLICT', '向导内容已被他人更新，请刷新后再操作')
    return { ...(await this.present(context.tenantId)), invitations, warnings }
  }

  private validateData(step: OnboardingStepKey, data: unknown): unknown {
    try {
      switch (step) {
        case 'PROFILE':
          return ProfileDataSchema.parse(data)
        case 'SYNC_SCOPE':
          return SyncScopeDataSchema.parse(data)
        case 'FX_COST':
          return FxCostDataSchema.parse(data)
        case 'MEMBERS':
          return data === undefined ? undefined : MembersDataSchema.parse(data)
        default:
          return undefined
      }
    } catch (error) {
      throw appError('ONBOARDING_STEP_INVALID', error instanceof Error ? '步骤内容不符合要求，请检查后重试' : '步骤内容不符合要求', { fieldErrors: fieldErrorsOf(error) })
    }
  }

  // 完成某一步时需要落到业务数据上的动作：企业资料写入企业；邀请成员建邀请；同步范围核对配额。
  private async apply(
    req: RequestWithContext,
    context: { tenantId: string; userId: string },
    step: OnboardingStepKey,
    data: unknown,
    invitations: Array<{ email: string; link: string | null; expiresAt: Date; emailed: boolean }>,
    warnings: string[],
  ) {
    if (step === 'PROFILE') {
      const profile = ProfileDataSchema.parse(data)
      await this.prisma.tenant.update({
        where: { id: context.tenantId },
        data: { name: profile.name, timezone: profile.timezone, localTimezone: profile.localTimezone, defaultCurrency: profile.defaultCurrency },
      })
    }
    if (step === 'SYNC_SCOPE') {
      const scope = SyncScopeDataSchema.parse(data)
      const quota = await this.prisma.tenantQuota.findUnique({ where: { tenantId_quotaKey: { tenantId: context.tenantId, quotaKey: 'backfillDays' } } })
      if (quota && scope.backfillDays > quota.limitValue) warnings.push(`历史回补 ${scope.backfillDays} 天超过了报价约定的 ${quota.limitValue} 天，请联系平台运营调整`)
    }
    if (step === 'MEMBERS' && data) await this.inviteMembers(req, context, MembersDataSchema.parse(data), invitations, warnings)
  }

  private async inviteMembers(
    req: RequestWithContext,
    context: { tenantId: string; userId: string },
    data: ReturnType<typeof MembersDataSchema.parse>,
    out: Array<{ email: string; link: string | null; expiresAt: Date; emailed: boolean }>,
    warnings: string[],
  ) {
    const base = appPublicUrl()
    if (!base) throw appError('DEPENDENCY_UNAVAILABLE', '站点地址（APP_PUBLIC_URL）未配置，无法生成邀请链接')
    const stores = await this.prisma.sellerAccount.findMany({ where: { tenantId: context.tenantId }, select: { id: true } })
    const storeIds = new Set(stores.map(store => store.id))
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: context.tenantId }, select: { name: true } })
    const existing = await this.prisma.membership.count({ where: { tenantId: context.tenantId, status: 'ACTIVE' } })
    const quota = await this.prisma.tenantQuota.findUnique({ where: { tenantId_quotaKey: { tenantId: context.tenantId, quotaKey: 'members' } } })
    if (quota && existing + data.invites.length > quota.limitValue) warnings.push(`成员数将超过报价约定的 ${quota.limitValue} 人，请联系平台运营调整配额`)
    for (const invite of data.invites) {
      const unknown = invite.sellerAccountIds.filter(id => !storeIds.has(id))
      if (unknown.length) throw appError('ONBOARDING_STEP_INVALID', '所选店铺不存在或不属于本企业', { fieldErrors: { sellerAccountIds: unknown } })
      const token = generateInviteToken()
      const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000)
      await this.prisma.memberInvitation.create({
        data: {
          tenantId: context.tenantId,
          email: invite.email,
          roleId: invite.roleId,
          scopeSnapshot: { all: invite.sellerAccountIds.length === 0, sellerAccountIds: invite.sellerAccountIds },
          tokenHash: hashInviteToken(token),
          expiresAt,
          invitedBy: context.userId,
        },
      })
      const link = inviteLink(base, token)
      const mail = await this.mail.send(invite.email, { kind: 'invitation', companyName: tenant.name, link, expiresAt })
      // 邮件通道未配置时，链接只在这次响应里出现，由管理员复制后安全交付（14.10）；已发邮件则不再返回链接
      out.push({ email: invite.email, link: mail.delivered ? null : link, expiresAt, emailed: mail.delivered })
    }
    void req
  }

  private async startFirstSync(req: RequestWithContext, tenantId: string, state: OnboardingState) {
    const scope = SyncScopeDataSchema.safeParse(state.steps.SYNC_SCOPE.data)
    if (!scope.success) return
    const result = await this.initialSync.start(tenantId, req.requestId, scope.data)
    state.firstSync = { startedAt: new Date().toISOString(), jobs: result.created, segments: result.planned }
  }
}

function fieldErrorsOf(error: unknown): Record<string, string[]> | undefined {
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> })?.issues
  if (!Array.isArray(issues)) return undefined
  const out: Record<string, string[]> = {}
  for (const issue of issues) (out[issue.path.join('.') || 'data'] ??= []).push(issue.message)
  return out
}
