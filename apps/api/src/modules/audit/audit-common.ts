import {
  auditAccessModeLabel,
  auditAccessModeOfDetail,
  auditActionLabel,
  auditActorOf,
  auditResultLabel,
  auditResourceLabel,
  auditSourceLabel,
  auditSourceOf,
  type AuditRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { memberNames } from '../../platform/people'
import type { PrismaService } from '../../platform/prisma.service'

// 审计中心的共用小件：列表行的取数列与转换。操作人名称一次查完，不逐行查询。

export const AUDIT_LIST_SELECT = {
  id: true,
  occurredAt: true,
  actorId: true,
  action: true,
  resourceType: true,
  resourceId: true,
  requestId: true,
  result: true,
  reason: true,
  source: true,
  page: true,
  detail: true,
} satisfies Prisma.AuditEventSelect
export type AuditListEvent = Prisma.AuditEventGetPayload<{ select: typeof AUDIT_LIST_SELECT }>

export const detailRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export const accessModeOf = auditAccessModeOfDetail
export const actorViewOf = auditActorOf

export function auditRowOf(event: AuditListEvent, names: ReadonlyMap<string, string>): AuditRow {
  const source = auditSourceOf(event.source, event.actorId)
  const mode = accessModeOf(event.detail)
  return {
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    actor: actorViewOf(event, names),
    source,
    sourceLabel: auditSourceLabel(source),
    page: event.page,
    action: event.action,
    actionLabel: auditActionLabel(event.action),
    resourceType: event.resourceType,
    resourceLabel: auditResourceLabel(event.resourceType),
    resourceId: event.resourceId,
    result: event.result,
    resultLabel: auditResultLabel(event.result),
    requestId: event.requestId,
    reason: event.reason,
    accessMode: mode,
    accessModeLabel: auditAccessModeLabel(mode),
  }
}

/** 一批事件里出现的操作人名称（一次查询）。 */
export const actorNamesOf = (prisma: PrismaService, tenantId: string, events: ReadonlyArray<Pick<AuditListEvent, 'actorId'>>) =>
  memberNames(
    prisma,
    tenantId,
    events.map(event => event.actorId),
  )
