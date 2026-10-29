import { Injectable } from '@nestjs/common'
import { AUDIT_READ, auditActionLabel, auditResourceLabel, auditResourcePath, auditResultLabel, type AuditChange, type AuditDetailResponse, type AuditRelatedRow } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { diffSnapshots, redactForAudit } from '../../platform/write'
import { ContextService } from '../auth'
import { AUDIT_LIST_SELECT, actorNamesOf, actorViewOf, auditRowOf, detailRecord } from './audit-common'

const RELATED_LIMIT = 10
const EXTRA_VALUE_MAX = 500
/** 详情里不重复显示的内部键：字段差异单独成块，访问模式在请求上下文里。 */
const HIDDEN_DETAIL_KEYS = new Set(['changes', 'accessMode'])

const isChange = (value: unknown): value is AuditChange => value !== null && typeof value === 'object' && typeof (value as { field?: unknown }).field === 'string'

const textOf = (value: unknown): string => {
  const text = typeof value === 'string' ? value : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  return text.length > EXTRA_VALUE_MAX ? `${text.slice(0, EXTRA_VALUE_MAX)}…` : text
}

// 审计详情（09 章 9.11）：修改前后的差异、请求上下文（来源地址、访问模式）、关联资源。
// 修改前后的快照写入时已脱敏；这里读出来再脱敏一遍（幂等），防止历史上写进去的内容含敏感字段名。
@Injectable()
export class AuditDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<AuditDetailResponse> {
    const context = await this.context.authorize(req, AUDIT_READ)
    const tenantId = context.tenantId
    const event = await this.prisma.auditEvent.findFirst({
      where: { tenantId, id: id.slice(0, 64) },
      select: { ...AUDIT_LIST_SELECT, beforeJson: true, afterJson: true, ip: true, userAgent: true, writeRunId: true, stepUpId: true },
    })
    if (!event) throw appError('RESOURCE_NOT_FOUND', '审计记录不存在')
    const related =
      event.resourceId === null
        ? []
        : await this.prisma.auditEvent.findMany({
            where: { tenantId, resourceType: event.resourceType, resourceId: event.resourceId, NOT: { id: event.id } },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: RELATED_LIMIT + 1,
            select: AUDIT_LIST_SELECT,
          })
    const shown = related.slice(0, RELATED_LIMIT)
    const names = await actorNamesOf(this.prisma, tenantId, [event, ...shown])
    const row = auditRowOf(event, names)
    const record = detailRecord(event.detail)
    const stored = Array.isArray(record.changes) ? record.changes.filter(isChange) : null
    const hasSnapshot = event.beforeJson !== null || event.afterJson !== null
    // 差异按字段路径逐个脱敏（路径里含 email、phone 等敏感字样的字段，前后值都显示“已隐藏”，但仍能看到这个字段改过）
    const changes = (stored ?? (hasSnapshot ? diffSnapshots(event.beforeJson, event.afterJson) : [])).map((change): AuditChange => ({
      field: change.field,
      before: redactForAudit(change.before, 0, change.field),
      after: redactForAudit(change.after, 0, change.field),
    }))
    const extra = Object.entries(detailRecord(redactForAudit(event.detail)))
      .filter(([key]) => !HIDDEN_DETAIL_KEYS.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value: textOf(value) }))
    const actor = actorViewOf(event, names)
    return {
      event: {
        ...row,
        ip: event.ip,
        userAgent: event.userAgent,
        writeRunId: event.writeRunId,
        stepUpVerified: Boolean(event.stepUpId),
        // 系统任务代为写入（例如导出完成由后台任务记录）时，真正发起的人
        initiator: actor.kind === 'SYSTEM' && event.actorId ? actorViewOf({ actorId: event.actorId, source: 'API', detail: null }, names) : null,
      },
      changes,
      hasSnapshot,
      extra,
      resource: {
        type: event.resourceType,
        label: auditResourceLabel(event.resourceType),
        id: event.resourceId,
        path: auditResourcePath(event.resourceType, event.resourceId),
        recent: shown.map((item): AuditRelatedRow => ({
          id: item.id,
          occurredAt: item.occurredAt.toISOString(),
          actorName: actorViewOf(item, names).name,
          actionLabel: auditActionLabel(item.action),
          result: item.result,
          resultLabel: auditResultLabel(item.result),
        })),
        recentTruncated: related.length > RELATED_LIMIT,
      },
    }
  }
}
