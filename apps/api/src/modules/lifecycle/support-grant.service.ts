import { Injectable } from '@nestjs/common'
import { SUPPORT_ACCESS_MAX_HOURS, SupportAccessGrantBodySchema } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { quotaUsage, type QuotaUsageClient } from './quota-usage'

export type SupportGrantStatus = 'AVAILABLE' | 'IN_USE' | 'REVOKED' | 'EXPIRED'

export function supportGrantStatus(row: { revokedAt: Date | null; expiresAt: Date; claimedAt: Date | null }, now = new Date()): SupportGrantStatus {
  if (row.revokedAt) return 'REVOKED'
  if (row.expiresAt <= now) return 'EXPIRED'
  return row.claimedAt ? 'IN_USE' : 'AVAILABLE'
}

// 企业侧的“平台支持访问授权”（P1-19，14.10）：只有所有者能授权，授权必须填原因、限时（最长 7 天）、只读，随时可撤销。
// 平台人员只能领取这里已有的授权；领取后每个请求都会写入审计，并在企业界面显示“支持访问中”。
@Injectable()
export class SupportGrantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private async owner(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'settings.write')
    if (!context.permissions.includes('*')) throw appError('TENANT_ACCESS_DENIED', '只有企业所有者可以授权或撤销平台支持访问')
    return context
  }

  async list(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'settings.read')
    const rows = await this.prisma.platformSupportAccess.findMany({ where: { tenantId: context.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 })
    return rows.map(row => ({
      id: row.id,
      reason: row.reason,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      claimedAt: row.claimedAt,
      revokedAt: row.revokedAt,
      status: supportGrantStatus(row),
    }))
  }

  async grant(req: RequestWithContext, rawBody: unknown) {
    const context = await this.owner(req)
    const body = SupportAccessGrantBodySchema.parse(rawBody)
    const now = new Date()
    const active = await this.prisma.platformSupportAccess.count({ where: { tenantId: context.tenantId, revokedAt: null, expiresAt: { gt: now } } })
    if (active >= 3) throw appError('VALIDATION_FAILED', '同时有效的支持访问授权最多 3 条，请先撤销不再需要的授权')
    const row = await this.prisma.platformSupportAccess.create({
      data: {
        tenantId: context.tenantId,
        grantedByUserId: context.userId,
        reason: body.reason,
        startsAt: now,
        expiresAt: new Date(now.getTime() + Math.min(body.hours, SUPPORT_ACCESS_MAX_HOURS) * 3600_000),
        scope: 'READ_ONLY',
      },
    })
    return { id: row.id, expiresAt: row.expiresAt, status: supportGrantStatus(row) }
  }

  async revoke(req: RequestWithContext, id: string) {
    const context = await this.owner(req)
    const result = await this.prisma.platformSupportAccess.updateMany({ where: { id, tenantId: context.tenantId, revokedAt: null }, data: { revokedAt: new Date() } })
    if (result.count !== 1) throw appError('RESOURCE_NOT_FOUND', '授权不存在或已撤销')
    return { id, status: 'REVOKED' as const }
  }

  async quotas(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'settings.read')
    return { items: await quotaUsage(this.prisma as unknown as QuotaUsageClient, context.tenantId) }
  }
}
