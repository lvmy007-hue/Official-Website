import { Injectable } from '@nestjs/common'
import {
  ALERT_RULE_DEFS,
  AUDIT_READ,
  PII_BULK_VIEW_RULE_CODE,
  PII_FIELD_LABEL,
  PII_OUTCOMES,
  PII_OUTCOME_LABEL,
  PII_SUMMARY_DAYS,
  PII_TOP_VIEWERS,
  PII_VIEW_ACTIONS,
  PiiViewQuerySchema,
  auditAccessModeLabel,
  auditResourceLabel,
  auditResourcePath,
  piiViewClauses,
  type PiiViewListResponse,
  type PiiViewRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'
import { AUDIT_LIST_SELECT, accessModeOf, actorViewOf, detailRecord, type AuditListEvent } from './audit-common'

const DAY_MS = 86_400_000

const numberOf = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

// 个人信息明文查看视图（09 章 9.11 CR-096 补充）：谁、什么时候、出于什么理由、查看了哪个对象的哪些字段、访问模式。
// 数据来自查看明文时写的审计（动作清单见契约 PII_VIEW_ACTIONS）；只记字段名，没有也不显示任何明文。
@Injectable()
export class AuditPiiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<PiiViewListResponse> {
    const context = await this.context.authorize(req, AUDIT_READ)
    const query = PiiViewQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const filters = { ...query, fromAt: query.fromAt ? new Date(query.fromAt) : undefined, toAt: query.toAt ? new Date(query.toAt) : undefined }
    const where = { AND: [{ tenantId }, ...piiViewClauses(filters)] } as Prisma.AuditEventWhereInput
    const binding = bindingOf(tenantId, query)
    const [rows, summary, rule] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { AND: [where, this.cursor.after(query.cursor, query.sort, binding) as Prisma.AuditEventWhereInput] },
        orderBy: this.cursor.orderBy(query.sort),
        take: query.pageSize + 1,
        select: AUDIT_LIST_SELECT,
      }),
      this.summary(tenantId, now),
      this.prisma.alertRule.findFirst({ where: { tenantId, code: PII_BULK_VIEW_RULE_CODE }, select: { enabled: true, conditionJson: true } }),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: query.sort, binding })
    const names = await memberNames(this.prisma, tenantId, [...page.items.map(row => row.actorId), ...summary.top.map(row => row.actorId)])
    const defaults = ALERT_RULE_DEFS.find(def => def.code === PII_BULK_VIEW_RULE_CODE)?.params ?? {}
    const params = detailRecord(detailRecord(rule?.conditionJson).params)
    return {
      items: page.items.map(row => piiRowOf(row, names)),
      pageInfo: page.pageInfo,
      summary: {
        last24h: summary.last24h,
        last7d: summary.last7d,
        topViewers: summary.top.map(row => ({ actorId: row.actorId, name: nameOrFormer(names, row.actorId, '未记录'), count: row.count })),
      },
      alertRule: rule
        ? { enabled: rule.enabled, windowMinutes: numberOf(params.windowMinutes, numberOf(defaults.windowMinutes, 60)), maxViews: numberOf(params.maxViews, numberOf(defaults.maxViews, 20)) }
        : null,
    }
  }

  /** 成功看到明文的次数：近 24 小时、近 7 天，以及近 7 天看得最多的人。不受页面筛选影响。 */
  private async summary(tenantId: string, now: Date) {
    const viewed: Prisma.AuditEventWhereInput = { tenantId, action: { in: [...PII_VIEW_ACTIONS] }, result: 'SUCCEEDED', detail: { path: ['outcome'], equals: 'OK' } }
    const since7d = new Date(now.getTime() - PII_SUMMARY_DAYS * DAY_MS)
    const [last24h, last7d, top] = await Promise.all([
      this.prisma.auditEvent.count({ where: { ...viewed, occurredAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
      this.prisma.auditEvent.count({ where: { ...viewed, occurredAt: { gte: since7d } } }),
      this.prisma.auditEvent.groupBy({ by: ['actorId'], where: { ...viewed, occurredAt: { gte: since7d } }, _count: { _all: true }, orderBy: { _count: { actorId: 'desc' } }, take: PII_TOP_VIEWERS }),
    ])
    return { last24h, last7d, top: top.map(row => ({ actorId: row.actorId, count: row._count._all })) }
  }
}

export function piiRowOf(event: AuditListEvent, names: ReadonlyMap<string, string>): PiiViewRow {
  const detail = detailRecord(event.detail)
  const fieldKeys = Array.isArray(detail.fields) ? detail.fields.filter((item): item is string => typeof item === 'string') : null
  const recorded = typeof detail.outcome === 'string' && (PII_OUTCOMES as readonly string[]).includes(detail.outcome) ? detail.outcome : 'UNKNOWN'
  const outcome = event.result === 'DENIED' ? 'DENIED' : event.result === 'SUCCEEDED' ? recorded : 'UNKNOWN'
  const mode = accessModeOf(event.detail)
  return {
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    actor: actorViewOf(event, names),
    reason: event.reason,
    object: {
      type: event.resourceType,
      typeLabel: auditResourceLabel(event.resourceType),
      id: event.resourceId,
      label: [detail.amazonOrderId, detail.caseId].find((item): item is string => typeof item === 'string' && item.length > 0) ?? event.resourceId ?? '未记录',
      path: auditResourcePath(event.resourceType, event.resourceId),
    },
    fields: fieldKeys ? fieldKeys.map(key => PII_FIELD_LABEL[key] ?? key) : null,
    outcome,
    outcomeLabel: PII_OUTCOME_LABEL[outcome] ?? outcome,
    accessMode: mode,
    accessModeLabel: auditAccessModeLabel(mode),
    requestId: event.requestId,
  }
}
