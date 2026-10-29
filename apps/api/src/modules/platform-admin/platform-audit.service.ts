import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'

export interface PlatformActor {
  id: string
  email: string
  name: string
  role: string
}

type AuditClient = { auditEvent: Pick<Prisma.TransactionClient['auditEvent'], 'create'> }

/**
 * 平台操作的审计（P1-19）：平台人员对某个企业做的每一次变更，都写进该企业的审计里，企业管理员能看到“平台做了什么”。
 * 操作人记在 detail 里（平台账号不是企业成员，不能放进成员外键）；访问模式标注为 PLATFORM。
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly prisma: SystemPrismaService) {}

  async record(
    req: RequestWithContext,
    actor: PlatformActor,
    tenantId: string,
    entry: { action: string; resourceType: string; resourceId?: string | null; reason?: string; detail?: Record<string, unknown>; result?: 'SUCCEEDED' | 'FAILED' | 'DENIED' },
    client: AuditClient = this.prisma,
  ) {
    await client.auditEvent.create({
      data: {
        tenantId,
        actorId: null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        requestId: req.requestId,
        source: 'API',
        result: entry.result ?? 'SUCCEEDED',
        detail: { ...(entry.detail ?? {}), accessMode: 'PLATFORM', platformAdminId: actor.id, platformRole: actor.role } as Prisma.InputJsonValue,
        ip: req.ip?.slice(0, 64),
        userAgent: req.header('user-agent')?.slice(0, 300),
        reason: entry.reason?.slice(0, 500),
      },
    })
    req.auditRecorded = true
  }
}
