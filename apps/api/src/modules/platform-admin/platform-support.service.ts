import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { READABLE_STATUSES, SUPPORT_TOKEN_MINUTES, SupportAccessRequestBodySchema, type TenantLifecycleStatus } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { platformJwtSecret, type SupportTokenPayload } from '../auth'
import type { PlatformActor } from './platform-audit.service'
import { PlatformAuditService } from './platform-audit.service'
import { PlatformAuthService } from './platform-auth.service'

// 平台支持访问（P1-19）：企业所有者先授权，平台支持人员再领取；领取需要再次验证动态验证码，授权同一时间只能被一人领取。
// 领取后签发 15 分钟的支持会话令牌（到授权到期时为止），到期后可凭同一条授权续发。令牌只读，且逐请求校验授权。
@Injectable()
export class PlatformSupportService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly jwt: JwtService,
    private readonly audit: PlatformAuditService,
    private readonly auth: PlatformAuthService,
  ) {}

  /** 各企业当前可领取（或自己已领取）的授权 */
  async list(actor: PlatformActor) {
    const now = new Date()
    const rows = await this.prisma.platformSupportAccess.findMany({
      where: { revokedAt: null, expiresAt: { gt: now }, OR: [{ claimedAt: null }, { platformAdminId: actor.id }], tenant: { lifecycleStatus: { in: [...READABLE_STATUSES] } } },
      orderBy: { expiresAt: 'asc' },
      take: 100,
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    })
    return {
      items: rows.map(row => ({
        id: row.id,
        tenant: row.tenant,
        reason: row.reason,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        claimedByMe: row.platformAdminId === actor.id && Boolean(row.claimedAt),
      })),
    }
  }

  async claim(req: RequestWithContext, actor: PlatformActor, rawBody: unknown) {
    const body = SupportAccessRequestBodySchema.parse(rawBody)
    await this.auth.confirmCode(actor.id, body.code)
    const now = new Date()
    const grant = await this.prisma.platformSupportAccess.findUnique({ where: { id: body.accessId }, include: { tenant: { select: { id: true, name: true, lifecycleStatus: true } } } })
    const usable = grant && !grant.revokedAt && grant.expiresAt > now && READABLE_STATUSES.includes(grant.tenant.lifecycleStatus as TenantLifecycleStatus)
    if (!grant || !usable) throw appError('SUPPORT_ACCESS_NOT_GRANTED', '企业尚未授权支持访问，或授权已过期、已撤销')
    if (grant.claimedAt && grant.platformAdminId !== actor.id) throw appError('SUPPORT_ACCESS_CLAIMED', '这条授权已被其他支持人员领取')
    // 原子占用：并发的两次领取只有一次成功
    const claimed = await this.prisma.platformSupportAccess.updateMany({
      where: { id: grant.id, revokedAt: null, expiresAt: { gt: now }, OR: [{ claimedAt: null }, { platformAdminId: actor.id }] },
      data: { platformAdminId: actor.id, claimedAt: grant.claimedAt ?? now },
    })
    if (claimed.count !== 1) throw appError('SUPPORT_ACCESS_CLAIMED', '这条授权已被其他支持人员领取，或刚刚被撤销')
    const expiresAt = new Date(Math.min(grant.expiresAt.getTime(), now.getTime() + SUPPORT_TOKEN_MINUTES * 60_000))
    const accessToken = await this.jwt.signAsync({ typ: 'support', adminId: actor.id, accessId: grant.id, tenantId: grant.tenantId } satisfies SupportTokenPayload, {
      secret: platformJwtSecret(),
      expiresIn: Math.max(60, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
    })
    await this.audit.record(req, actor, grant.tenantId, {
      action: 'SUPPORT_ACCESS_CLAIMED',
      resourceType: 'PlatformSupportAccess',
      resourceId: grant.id,
      reason: grant.reason,
      detail: { grantExpiresAt: grant.expiresAt },
    })
    return { accessToken, expiresAt, grantExpiresAt: grant.expiresAt, tenant: { id: grant.tenant.id, name: grant.tenant.name } }
  }
}
