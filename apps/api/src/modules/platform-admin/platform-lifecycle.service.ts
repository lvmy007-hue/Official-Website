import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  CLOSE_EXPORT_RETENTION_DAYS,
  INVITATION_TTL_HOURS,
  PlatformReasonBodySchema,
  TENANT_STATUS_LABELS,
  TenantCloseBodySchema,
  TenantDeactivateBodySchema,
  TenantInviteBodySchema,
  canTransition,
  initialCloseState,
  type CloseState,
  type TenantLifecycleStatus,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { ObjectStorageService, storageAppError } from '../../platform/storage'
import { appPublicUrl, generateInviteToken, hashInviteToken } from '../lifecycle'
import type { PlatformActor } from './platform-audit.service'
import { PlatformAuditService } from './platform-audit.service'
import { PlatformAuthService } from './platform-auth.service'
import { PlatformTenantsService } from './platform-tenants.service'

type Tx = Prisma.TransactionClient

// 企业生命周期流转（P1-19）：邀请重发、暂停、恢复、停用、注销。
// 每次流转：状态机校验 → 乐观占用（只在状态未变时更新）→ 写生命周期事件 → 写企业审计，同一事务。
@Injectable()
export class PlatformLifecycleService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly audit: PlatformAuditService,
    private readonly auth: PlatformAuthService,
    private readonly queue: QueueService,
    private readonly tenants: PlatformTenantsService,
    private readonly storage: ObjectStorageService,
  ) {}

  private async transition(
    tx: Tx,
    req: RequestWithContext,
    actor: PlatformActor,
    id: string,
    to: TenantLifecycleStatus,
    entry: { action: string; reason: string; data?: Prisma.TenantUpdateManyMutationInput; detail?: Record<string, unknown> },
  ) {
    const tenant = await tx.tenant.findUnique({ where: { id }, select: { lifecycleStatus: true } })
    if (!tenant) throw appError('RESOURCE_NOT_FOUND', '企业不存在')
    const from = tenant.lifecycleStatus as TenantLifecycleStatus
    if (!canTransition(from, to)) throw appError('TENANT_TRANSITION_INVALID', `企业当前是“${TENANT_STATUS_LABELS[from] ?? from}”，不能变更为“${TENANT_STATUS_LABELS[to]}”`)
    const changed = await tx.tenant.updateMany({ where: { id, lifecycleStatus: from }, data: { ...entry.data, lifecycleStatus: to, lifecycleChangedAt: new Date() } })
    if (changed.count !== 1) throw appError('CONFLICT', '企业状态刚刚被他人修改，请刷新后重试')
    await tx.tenantLifecycleEvent.create({
      data: { tenantId: id, fromStatus: from, toStatus: to, reason: entry.reason, actorPlatformAdminId: actor.id, detailJson: (entry.detail ?? {}) as Prisma.InputJsonValue },
    })
    await this.audit.record(req, actor, id, { action: entry.action, resourceType: 'Tenant', resourceId: id, reason: entry.reason, detail: { from, to, ...(entry.detail ?? {}) } }, tx)
    return from
  }

  async suspend(req: RequestWithContext, actor: PlatformActor, id: string, rawBody: unknown) {
    const body = PlatformReasonBodySchema.parse(rawBody)
    await this.prisma.$transaction(tx => this.transition(tx, req, actor, id, 'SUSPENDED', { action: 'TENANT_SUSPENDED', reason: body.reason }))
    return this.tenants.detail(id)
  }

  async resume(req: RequestWithContext, actor: PlatformActor, id: string, rawBody: unknown) {
    const body = PlatformReasonBodySchema.parse(rawBody)
    await this.prisma.$transaction(tx => this.transition(tx, req, actor, id, 'ACTIVE', { action: 'TENANT_RESUMED', reason: body.reason }))
    return this.tenants.detail(id)
  }

  async deactivate(req: RequestWithContext, actor: PlatformActor, id: string, rawBody: unknown) {
    const body = TenantDeactivateBodySchema.parse(rawBody)
    await this.prisma.$transaction(tx =>
      this.transition(tx, req, actor, id, 'DEACTIVATED', {
        action: 'TENANT_DEACTIVATED',
        reason: body.reason,
        data: body.retentionDays ? { retentionDays: body.retentionDays } : undefined,
        detail: body.retentionDays ? { retentionDays: body.retentionDays } : undefined,
      }),
    )
    return this.tenants.detail(id)
  }

  /** 重发邀请：作废尚未使用的旧邀请，生成新的一次性链接（72 小时）；可更换受邀邮箱。首个管理员已激活后不能再发。 */
  async reinvite(req: RequestWithContext, actor: PlatformActor, id: string, rawBody: unknown) {
    const body = TenantInviteBodySchema.parse(rawBody ?? {})
    const base = appPublicUrl()
    if (!base) throw appError('DEPENDENCY_UNAVAILABLE', '站点地址（APP_PUBLIC_URL）未配置，无法生成邀请链接')
    const token = generateInviteToken()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000)
    const { email, name } = await this.prisma.$transaction(async tx => {
      const tenant = await tx.tenant.findUnique({ where: { id }, select: { name: true, lifecycleStatus: true } })
      if (!tenant) throw appError('RESOURCE_NOT_FOUND', '企业不存在')
      if (!['TRIAL', 'ACTIVE', 'SUSPENDED'].includes(tenant.lifecycleStatus)) throw appError('TENANT_INACTIVE', '企业已停用或注销，不能重发邀请')
      if (await tx.tenantInvitation.findFirst({ where: { tenantId: id, status: 'ACCEPTED' }, select: { id: true } }))
        throw appError('VALIDATION_FAILED', '首个管理员已经激活，无需重发邀请；成员邀请请在企业内处理')
      const last = await tx.tenantInvitation.findFirst({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, select: { email: true } })
      const target = body.email ?? last?.email
      if (!target) throw appError('VALIDATION_FAILED', '请填写受邀管理员的邮箱')
      if (await tx.user.findUnique({ where: { email: target }, select: { id: true } })) throw appError('INVITATION_EMAIL_REGISTERED', '该邮箱已有账号，请换一个管理员邮箱')
      await tx.tenantInvitation.updateMany({ where: { tenantId: id, status: 'PENDING' }, data: { status: 'REVOKED' } })
      await tx.tenantInvitation.create({ data: { tenantId: id, email: target, tokenHash: hashInviteToken(token), expiresAt, createdByPlatformAdminId: actor.id } })
      await this.audit.record(req, actor, id, { action: 'TENANT_INVITATION_REISSUED', resourceType: 'TenantInvitation', resourceId: id, detail: { email: target } }, tx)
      return { email: target, name: tenant.name }
    })
    return { invitation: await this.tenants.deliver(email, name, token, expiresAt, base) }
  }

  /**
   * 注销：必须输入企业标识确认并再次验证动态验证码；只有已暂停或已停用的企业能注销。
   * 状态置为“注销中”后入队后台任务（导出 → 撤销授权 → 删令牌 → 删买家信息 → 删业务数据与文件 → 删除证明）。
   * 注销中且上一次失败时再次调用即从失败处续跑。
   */
  async close(req: RequestWithContext, actor: PlatformActor, id: string, rawBody: unknown) {
    const body = TenantCloseBodySchema.parse(rawBody)
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { slug: true, lifecycleStatus: true, closeStateJson: true } })
    if (!tenant) throw appError('RESOURCE_NOT_FOUND', '企业不存在')
    if (body.confirmSlug !== tenant.slug) throw appError('TENANT_CLOSE_CONFIRMATION_MISMATCH', '输入的企业标识与当前企业不一致')
    const resuming = tenant.lifecycleStatus === 'CLOSING'
    const previous = (tenant.closeStateJson ?? null) as CloseState | null
    if (resuming && !previous?.failed) throw appError('TENANT_TRANSITION_INVALID', '企业正在注销中，请等待完成')
    await this.auth.confirmCode(actor.id, body.code)

    let runs = 1
    if (resuming && previous) {
      runs = previous.runs + 1
      await this.prisma.$transaction(async tx => {
        await tx.tenant.update({ where: { id }, data: { closeStateJson: { ...previous, runs, failed: false } as unknown as Prisma.InputJsonValue } })
        await this.audit.record(req, actor, id, { action: 'TENANT_CLOSE_RESUMED', resourceType: 'Tenant', resourceId: id, reason: body.reason, detail: { runs } }, tx)
      })
    } else {
      await this.prisma.$transaction(tx =>
        this.transition(tx, req, actor, id, 'CLOSING', {
          action: 'TENANT_CLOSE_STARTED',
          reason: body.reason,
          data: { closeStateJson: initialCloseState(actor.id) as unknown as Prisma.InputJsonValue },
        }),
      )
    }
    await this.queue.add('lifecycle', { tenantId: id, kind: 'tenant-close', requestId: req.requestId, runs }, `tenant-close:${id}:${runs}`)
    return this.tenants.detail(id)
  }

  /** 注销导出包的下载链接（短时有效；包本身保留 30 天，到期由后台清理） */
  async closeExport(req: RequestWithContext, actor: PlatformActor, id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { closeStateJson: true } })
    const state = (tenant?.closeStateJson ?? null) as CloseState | null
    if (!state?.export) throw appError('RESOURCE_NOT_FOUND', '该企业没有可下载的导出包（尚未完成导出，或已超过保留期被清理）')
    if (new Date(state.export.expiresAt) <= new Date()) throw appError('STORAGE_LINK_EXPIRED', `导出包只保留 ${CLOSE_EXPORT_RETENTION_DAYS} 天，已过期被清理`)
    try {
      const signed = await this.storage.forTenant(id).signDownload(state.export.key, 300)
      await this.audit.record(req, actor, id, { action: 'TENANT_CLOSE_EXPORT_DOWNLOADED', resourceType: 'Tenant', resourceId: id, detail: { bytes: state.export.bytes } })
      return { url: signed.url, expiresAt: signed.expiresAt, bytes: state.export.bytes, sha256: state.export.sha256, rows: state.export.rows }
    } catch (error) {
      throw storageAppError(error)
    }
  }
}
