import {
  ALERT_DOMAINS,
  ALERT_RULE_DOMAIN_LABEL,
  ALERT_STATUS_LABEL,
  PII_VIEWER_ENTITY,
  entityDetailPath,
  type AlertImpact,
  type AlertListItem,
  type AlertRuleDomain,
  type AlertRuleSeverity,
} from '@nova/api-contracts'
import type { Prisma, WorkItem } from '@prisma/client'
import { memberNames, nameOrFormer } from '../../platform/people'
import type { PrismaService } from '../../platform/prisma.service'

// 预警列表与详情共用的取数与行转换（09 章 9.1）。
// 预警实例自己带标题、对象名称、建议与影响区间（P5-01 迁移补的列）；旧实例这些列为空，回退到关联待办，再回退到规则名称。

export const ALERT_INCLUDE = { rule: { select: { id: true, code: true, name: true, domain: true, enabled: true, currentVersion: true } } } satisfies Prisma.AlertInstanceInclude
export type AlertRow = Prisma.AlertInstanceGetPayload<{ include: typeof ALERT_INCLUDE }>
export type WorkSummary = Pick<WorkItem, 'id' | 'status' | 'ownerId' | 'title' | 'entityLabel' | 'suggestedAction' | 'impactMin' | 'impactMax' | 'currency' | 'dueAt' | 'version'>
export const WORK_SUMMARY_SELECT = {
  id: true,
  status: true,
  ownerId: true,
  title: true,
  entityLabel: true,
  suggestedAction: true,
  impactMin: true,
  impactMax: true,
  currency: true,
  dueAt: true,
  version: true,
} satisfies Prisma.WorkItemSelect

export const OPEN_STATUSES = ['NEW', 'ACKED']

/** 没有独立详情页、但有可去处理的设置页的对象类型。 */
const SETTINGS_PATHS: Readonly<Record<string, string>> = { FX_SOURCE: '/app/settings/fx', INTEGRATION_SWITCH: '/app/settings/integrations' }

export const alertEntityPath = (type: string, id: string): string | null =>
  // 大量查看明文的预警：直接打开审计中心“个人信息明文查看”并筛到这个人（P5-09）
  type === PII_VIEWER_ENTITY ? `/app/audit?view=pii&actorId=${encodeURIComponent(id)}` : (SETTINGS_PATHS[type] ?? entityDetailPath(type, id))

const domainOf = (value: string): AlertRuleDomain => ((ALERT_DOMAINS as readonly string[]).includes(value) ? (value as AlertRuleDomain) : 'SYSTEM')
export const domainLabelOf = (domain: string) => ALERT_RULE_DOMAIN_LABEL[domainOf(domain)]
const severityOf = (value: string): AlertRuleSeverity => (value === 'CRITICAL' || value === 'INFO' ? value : 'WARNING')
const toNumber = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

function impactOf(row: AlertRow, work: WorkSummary | null): AlertImpact | null {
  const min = row.impactMin ?? work?.impactMin ?? null
  const max = row.impactMax ?? work?.impactMax ?? null
  if (min === null && max === null) return null
  return { min: toNumber(min), max: toNumber(max), currency: row.currency ?? work?.currency ?? 'USD' }
}

export interface AlertLookups {
  work: ReadonlyMap<string, WorkSummary>
  stores: ReadonlyMap<string, string>
  names: ReadonlyMap<string, string>
  /** 当前用户已读的预警编号（只含这一批里的） */
  readIds: ReadonlySet<string>
}

/** 一批预警行用到的关联待办、店铺名、负责人名与我的已读状态（各一次查询）。 */
export async function loadLookups(prisma: PrismaService, tenantId: string, userId: string, rows: readonly AlertRow[]): Promise<AlertLookups> {
  const workIds = [...new Set(rows.flatMap(row => (row.workItemId ? [row.workItemId] : [])))]
  const storeIds = [...new Set(rows.flatMap(row => (row.sellerAccountId ? [row.sellerAccountId] : [])))]
  const alertIds = rows.map(row => row.id)
  const [works, stores, reads] = await Promise.all([
    workIds.length > 0 ? prisma.workItem.findMany({ where: { tenantId, id: { in: workIds } }, select: WORK_SUMMARY_SELECT, take: workIds.length }) : [],
    storeIds.length > 0 ? prisma.sellerAccount.findMany({ where: { tenantId, id: { in: storeIds } }, select: { id: true, displayName: true }, take: storeIds.length }) : [],
    alertIds.length > 0 ? prisma.alertRead.findMany({ where: { tenantId, userId, alertId: { in: alertIds } }, select: { alertId: true }, take: alertIds.length }) : [],
  ])
  const names = await memberNames(
    prisma,
    tenantId,
    works.map(work => work.ownerId),
  )
  return { work: new Map(works.map(work => [work.id, work])), stores: new Map(stores.map(store => [store.id, store.displayName])), names, readIds: new Set(reads.map(read => read.alertId)) }
}

export function alertItem(row: AlertRow, lookups: AlertLookups): AlertListItem {
  const work = row.workItemId ? (lookups.work.get(row.workItemId) ?? null) : null
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleCode: row.rule.code,
    ruleName: row.rule.name,
    domain: domainOf(row.rule.domain),
    domainLabel: domainLabelOf(row.rule.domain),
    severity: severityOf(row.severity),
    status: row.status,
    statusLabel: ALERT_STATUS_LABEL[row.status] ?? row.status,
    title: row.title ?? work?.title ?? row.rule.name,
    entity: { type: row.entityType, id: row.entityId, label: row.entityLabel ?? work?.entityLabel ?? row.entityId, path: alertEntityPath(row.entityType, row.entityId) },
    storeName: row.sellerAccountId ? (lookups.stores.get(row.sellerAccountId) ?? null) : null,
    impact: impactOf(row, work),
    suggestedAction: row.suggestedAction ?? work?.suggestedAction ?? null,
    owner: work ? { id: work.ownerId, name: nameOrFormer(lookups.names, work.ownerId) } : null,
    triggerCount: row.triggerCount,
    ruleVersionNo: row.ruleVersionNo,
    firstTriggeredAt: row.firstTriggeredAt.toISOString(),
    lastTriggeredAt: row.lastTriggeredAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    read: lookups.readIds.has(row.id),
  }
}
