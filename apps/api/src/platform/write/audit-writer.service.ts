import { Injectable } from '@nestjs/common'
import { AUDIT_PAGE_HEADER, auditPageOf } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { ApiContext, RequestWithContext } from '../http'
import { logger } from '../observability'
import { PrismaService } from '../prisma.service'
import { diffSnapshots, redactForAudit } from './audit-snapshot'

export type AuditResult = 'SUCCEEDED' | 'FAILED' | 'DENIED'

export interface AuditEntry {
  /** 动作名，全大写下划线，例如 LEGAL_ENTITY_CREATED */
  action: string
  resourceType: string
  resourceId?: string | null
  result?: AuditResult
  /** 修改前后的内容（会脱敏、限长，并自动计算字段级差异写入 detail.changes） */
  before?: unknown
  after?: unknown
  reason?: string
  detail?: Record<string, unknown>
}

type AuditClient = { auditEvent: Pick<Prisma.TransactionClient['auditEvent'], 'create'> }

const clip = (value: string | undefined | null, max: number) => (value ? value.slice(0, max) : undefined)

// 审计写入：所有写操作的审计事件都经由这里，保证同样的字段（请求编号、来源地址、访问模式、修改前后、再次验证记录）。
// 领域服务在自己的事务里调用 record（传入事务客户端），审计与业务数据同成败；
// 没有调用 record 的写接口，由写接口拦截器补写一条通用审计。
@Injectable()
export class AuditWriter {
  constructor(private readonly prisma: PrismaService) {}

  build(req: RequestWithContext, context: Pick<ApiContext, 'tenantId' | 'userId'>, entry: AuditEntry): Prisma.AuditEventUncheckedCreateInput {
    const before = entry.before === undefined ? undefined : redactForAudit(entry.before)
    const after = entry.after === undefined ? undefined : redactForAudit(entry.after)
    const changes = before !== undefined || after !== undefined ? diffSnapshots(before, after) : undefined
    const page = auditPageOf(req.header?.(AUDIT_PAGE_HEADER))
    const detail = {
      ...(entry.detail ?? {}),
      ...(changes ? { changes } : {}),
      accessMode: req.accessMode ?? 'NORMAL',
    }
    return {
      tenantId: context.tenantId,
      actorId: context.userId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      requestId: req.requestId,
      result: entry.result ?? 'SUCCEEDED',
      detail: detail as unknown as Prisma.InputJsonValue,
      beforeJson: before === undefined || before === null ? undefined : (before as Prisma.InputJsonValue),
      afterJson: after === undefined || after === null ? undefined : (after as Prisma.InputJsonValue),
      ip: clip(req.ip, 64),
      userAgent: clip(req.header?.('user-agent'), 300),
      writeRunId: req.writeRunId,
      stepUpId: req.stepUpId,
      reason: clip(entry.reason, 500),
      // 来源与所属页面（P5-09）：请求头里带了合格的页面路径记为“页面操作”，否则记为“接口调用”；系统任务由后台任务自己写入
      source: page ? 'PAGE' : 'API',
      page,
    }
  }

  /** 写一条审计事件。`client` 传事务客户端可与业务数据同事务提交。 */
  async record(req: RequestWithContext, entry: AuditEntry, options: { client?: AuditClient; context?: Pick<ApiContext, 'tenantId' | 'userId'> } = {}) {
    const context = options.context ?? req.apiContext
    if (!context) throw new Error('写入审计需要先解析请求上下文（先调用 authorize）')
    const client = options.client ?? this.prisma
    await client.auditEvent.create({ data: this.build(req, context, entry) })
    req.auditRecorded = true
  }

  /** 不影响主流程的审计写入（失败只记日志）：用于拦截器补写的通用审计与失败审计。 */
  async recordQuietly(req: RequestWithContext, entry: AuditEntry, context?: Pick<ApiContext, 'tenantId' | 'userId'>) {
    try {
      await this.record(req, entry, { context })
    } catch (error) {
      logger.error({ event: 'audit_write_failed', action: entry.action, requestId: req.requestId, err: error instanceof Error ? error.message : String(error) }, '审计写入失败')
    }
  }
}
