import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  DEFAULT_RETENTION_DAYS,
  INVITATION_TTL_HOURS,
  ONBOARDING_STEPS,
  PlatformTenantCreateBodySchema,
  PlatformTenantListQuerySchema,
  QUOTA_KEYS,
  TENANT_STATUS_LABELS,
  TenantQuotaBodySchema,
  type TenantLifecycleStatus,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { MailService } from '../../platform/mail'
import { SystemPrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { appPublicUrl, currentStep, generateInviteToken, hashInviteToken, initialOnboardingState, inviteLink, parseOnboardingState, quotaUsage, type QuotaUsageClient } from '../lifecycle'
import type { PlatformActor } from './platform-audit.service'
import { PlatformAuditService } from './platform-audit.service'

const LIST_SORT = { field: 'createdAt', dir: 'desc' } as const
const PLATFORM_SCOPE = 'platform'

/** 一次性邀请链接：邮件通道未配置（或发送失败）时返回链接，由平台人员复制后安全交付；已发邮件则不返回。 */
export type InvitationDelivery = { email: string; expiresAt: Date; emailed: boolean; link: string | null }

// 平台侧的企业管理（P1-19）：开通、列表、详情、用量、配额。全部使用系统连接（不受行级安全限制），
// 因此每个入口都必须经过平台守卫；对企业数据的每次变更都写进该企业的审计（PlatformAuditService）。
@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly cursor: CursorService,
    private readonly audit: PlatformAuditService,
    private readonly mail: MailService,
  ) {}

  async list(rawQuery: unknown) {
    const query = PlatformTenantListQuerySchema.parse(rawQuery)
    const filters: Prisma.TenantWhereInput = {
      ...(query.status ? { lifecycleStatus: query.status } : {}),
      ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { slug: { contains: query.q.toLowerCase() } }] } : {}),
    }
    const binding = bindingOf(PLATFORM_SCOPE, { q: query.q, status: query.status })
    const rows = await this.prisma.tenant.findMany({
      where: { AND: [filters, this.cursor.after(query.cursor, LIST_SORT, binding) as Prisma.TenantWhereInput] },
      orderBy: this.cursor.orderBy(LIST_SORT),
      take: query.pageSize + 1,
      select: { id: true, name: true, slug: true, lifecycleStatus: true, lifecycleChangedAt: true, createdAt: true, tenantOnboarding: { select: { completedAt: true, step: true } } },
    })
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: LIST_SORT, binding })
    const ids = page.items.map(item => item.id)
    const [stores, members] = await Promise.all([
      this.prisma.sellerAccount.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _count: { _all: true } }),
      this.prisma.membership.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } }),
    ])
    const storeCount = new Map(stores.map(row => [row.tenantId, row._count._all]))
    const memberCount = new Map(members.map(row => [row.tenantId, row._count._all]))
    return {
      items: page.items.map(row => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.lifecycleStatus,
        statusLabel: TENANT_STATUS_LABELS[row.lifecycleStatus as TenantLifecycleStatus] ?? row.lifecycleStatus,
        statusChangedAt: row.lifecycleChangedAt,
        createdAt: row.createdAt,
        stores: storeCount.get(row.id) ?? 0,
        members: memberCount.get(row.id) ?? 0,
        onboardingCompleted: row.tenantOnboarding ? Boolean(row.tenantOnboarding.completedAt) : true,
      })),
      pageInfo: page.pageInfo,
    }
  }

  async create(req: RequestWithContext, actor: PlatformActor, rawBody: unknown) {
    const body = PlatformTenantCreateBodySchema.parse(rawBody)
    if (await this.prisma.user.findUnique({ where: { email: body.adminEmail }, select: { id: true } })) throw appError('INVITATION_EMAIL_REGISTERED', '该邮箱已有账号，请换一个管理员邮箱')
    const base = appPublicUrl()
    if (!base) throw appError('DEPENDENCY_UNAVAILABLE', '站点地址（APP_PUBLIC_URL）未配置，无法生成邀请链接')
    const token = generateInviteToken()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000)
    const status: TenantLifecycleStatus = body.trial ? 'TRIAL' : 'ACTIVE'
    let tenantId: string
    try {
      tenantId = await this.prisma.$transaction(async tx => {
        const tenant = await tx.tenant.create({
          data: {
            name: body.name,
            slug: body.slug,
            mode: 'LIVE',
            timezone: 'America/Los_Angeles',
            localTimezone: body.localTimezone,
            defaultCurrency: 'USD',
            lifecycleStatus: status,
            retentionDays: body.retentionDays,
          },
        })
        await tx.tenantQuota.createMany({ data: QUOTA_KEYS.map(quotaKey => ({ tenantId: tenant.id, quotaKey, limitValue: body.quotas[quotaKey] })) })
        await tx.tenantOnboarding.create({ data: { tenantId: tenant.id, step: 'PROFILE', stepStateJson: initialOnboardingState() as unknown as Prisma.InputJsonValue } })
        await tx.tenantLifecycleEvent.create({ data: { tenantId: tenant.id, fromStatus: status, toStatus: status, reason: '平台开通企业', actorPlatformAdminId: actor.id } })
        await tx.tenantInvitation.create({ data: { tenantId: tenant.id, email: body.adminEmail, tokenHash: hashInviteToken(token), expiresAt, createdByPlatformAdminId: actor.id } })
        await this.audit.record(
          req,
          actor,
          tenant.id,
          { action: 'TENANT_CREATED', resourceType: 'Tenant', resourceId: tenant.id, detail: { slug: body.slug, status, quotas: body.quotas, adminEmail: body.adminEmail } },
          tx,
        )
        return tenant.id
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw appError('TENANT_SLUG_TAKEN', '该企业标识已被使用，请换一个')
      throw error
    }
    const invitation = await this.deliver(body.adminEmail, body.name, token, expiresAt, base)
    return { tenant: { id: tenantId, name: body.name, slug: body.slug, status }, invitation }
  }

  /** 发送邀请邮件；通道未配置或失败时返回链接，让平台人员复制交付（14.10：邮件发送暂缓，链接仍一次性、72 小时有效） */
  async deliver(email: string, companyName: string, token: string, expiresAt: Date, base: string): Promise<InvitationDelivery> {
    const link = inviteLink(base, token)
    const sent = await this.mail.send(email, { kind: 'invitation', companyName, link, expiresAt })
    return { email, expiresAt, emailed: sent.delivered, link: sent.delivered ? null : link }
  }

  async detail(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        tenantOnboarding: true,
        tenantQuotas: true,
        lifecycleEvents: { orderBy: { createdAt: 'desc' }, take: 30 },
        tenantInvitations: { orderBy: { createdAt: 'desc' }, take: 5 },
        supportAccesses: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    })
    if (!tenant) throw appError('RESOURCE_NOT_FOUND', '企业不存在')
    const state = parseOnboardingState(tenant.tenantOnboarding?.stepStateJson)
    const quotas = await quotaUsage(this.prisma as unknown as QuotaUsageClient, id)
    const now = Date.now()
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.lifecycleStatus,
      statusLabel: TENANT_STATUS_LABELS[tenant.lifecycleStatus as TenantLifecycleStatus] ?? tenant.lifecycleStatus,
      statusChangedAt: tenant.lifecycleChangedAt,
      timezone: tenant.timezone,
      localTimezone: tenant.localTimezone,
      defaultCurrency: tenant.defaultCurrency,
      retentionDays: tenant.retentionDays ?? DEFAULT_RETENTION_DAYS,
      retentionUntil:
        tenant.lifecycleStatus === 'DEACTIVATED' ? new Date((tenant.lifecycleChangedAt ?? tenant.createdAt).getTime() + (tenant.retentionDays ?? DEFAULT_RETENTION_DAYS) * 86400_000) : null,
      createdAt: tenant.createdAt,
      closedAt: tenant.closedAt,
      closeProgress: tenant.closeStateJson ?? null,
      onboarding: tenant.tenantOnboarding
        ? {
            completed: Boolean(tenant.tenantOnboarding.completedAt),
            currentStep: currentStep(state),
            steps: ONBOARDING_STEPS.map(step => ({ key: step.key, no: step.no, title: step.title, required: step.required, state: state.steps[step.key].state })),
            firstSync: state.firstSync ?? null,
          }
        : null,
      quotas,
      invitations: tenant.tenantInvitations.map(item => ({
        id: item.id,
        email: item.email,
        status: item.status === 'PENDING' && item.expiresAt.getTime() <= now ? 'EXPIRED' : item.status,
        expiresAt: item.expiresAt,
        createdAt: item.createdAt,
      })),
      events: tenant.lifecycleEvents.map(item => ({ id: item.id, from: item.fromStatus, to: item.toStatus, reason: item.reason, at: item.createdAt })),
      supportAccesses: tenant.supportAccesses.map(item => ({ id: item.id, reason: item.reason, expiresAt: item.expiresAt, claimed: Boolean(item.claimedAt), revoked: Boolean(item.revokedAt) })),
    }
  }

  /** 用量：配额占用与近期运行情况（只含数量，不含业务内容） */
  async usage(id: string) {
    if (!(await this.prisma.tenant.findUnique({ where: { id }, select: { id: true } }))) throw appError('RESOURCE_NOT_FOUND', '企业不存在')
    const since = new Date(Date.now() - 86400_000)
    const [quotas, connections, jobs24h, failed24h, lastSync, orders] = await Promise.all([
      quotaUsage(this.prisma as unknown as QuotaUsageClient, id),
      this.prisma.platformConnection.count({ where: { tenantId: id, state: 'AUTHORIZED' } }),
      this.prisma.syncJob.count({ where: { tenantId: id, createdAt: { gte: since } } }),
      this.prisma.syncJob.count({ where: { tenantId: id, createdAt: { gte: since }, status: { in: ['FAILED', 'FAILED_PERMANENT'] } } }),
      this.prisma.syncJob.findFirst({ where: { tenantId: id, status: 'SUCCEEDED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
      this.prisma.order.count({ where: { tenantId: id } }),
    ])
    return { quotas, connections, syncJobs24h: jobs24h, syncFailed24h: failed24h, lastSyncAt: lastSync?.finishedAt ?? null, orders }
  }

  async updateQuotas(req: RequestWithContext, actor: PlatformActor, id: string, rawBody: unknown) {
    const body = TenantQuotaBodySchema.parse(rawBody)
    await this.prisma.$transaction(async tx => {
      if (!(await tx.tenant.findUnique({ where: { id }, select: { id: true } }))) throw appError('RESOURCE_NOT_FOUND', '企业不存在')
      const before = Object.fromEntries((await tx.tenantQuota.findMany({ where: { tenantId: id } })).map(row => [row.quotaKey, row.limitValue]))
      for (const key of QUOTA_KEYS) {
        const value = body.quotas[key]
        if (value === undefined) continue
        await tx.tenantQuota.upsert({
          where: { tenantId_quotaKey: { tenantId: id, quotaKey: key } },
          create: { tenantId: id, quotaKey: key, limitValue: value },
          update: { limitValue: value, version: { increment: 1 } },
        })
      }
      await this.audit.record(req, actor, id, { action: 'TENANT_QUOTA_UPDATED', resourceType: 'TenantQuota', resourceId: id, reason: body.reason, detail: { before, after: body.quotas } }, tx)
    })
    return { quotas: await quotaUsage(this.prisma as unknown as QuotaUsageClient, id) }
  }
}
