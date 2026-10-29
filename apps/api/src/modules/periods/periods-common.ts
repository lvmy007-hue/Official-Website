import {
  PERIOD_CLOSE,
  PERIOD_REOPEN,
  PERIOD_STATUS_LABEL,
  PERIOD_STATUS_NOTE,
  monthOfStart,
  periodActionsOf,
  type PeriodActions,
  type PeriodChecklist,
  type PeriodDetail,
  type PeriodRow,
  type PeriodStatus,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { appError } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { dateText, validZone } from '../overview'

// 期间关账各服务共用的小工具（P2b-13）：取期间、行映射、检查清单解析、企业时区。

/** 既能传 PrismaService，也能传事务里的 tx。 */
export type Db = Prisma.TransactionClient

export const PERIOD_SELECT = {
  id: true,
  tenantId: true,
  sellerAccountId: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  version: true,
  checklistJson: true,
  checkedBy: true,
  checkedAt: true,
  approvalDecision: true,
  approvedBy: true,
  approvedAt: true,
  approvalComment: true,
  closeCount: true,
  closedBy: true,
  closedAt: true,
  reopenedBy: true,
  reopenedAt: true,
  reopenReason: true,
  createdBy: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.AccountingPeriodSelect
export type PeriodRecord = Prisma.AccountingPeriodGetPayload<{ select: typeof PERIOD_SELECT }>

export const statusOf = (value: string): PeriodStatus => (value in PERIOD_STATUS_LABEL ? (value as PeriodStatus) : 'OPEN')

/** 库里存的检查清单；没检查过（空对象）或格式不对为 null。 */
export function checklistOf(value: unknown): PeriodChecklist | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PeriodChecklist>
  return Array.isArray(raw.items) && typeof raw.checkedAt === 'string' ? (raw as PeriodChecklist) : null
}

/** 接口返回检查清单时，把确认放行的成员编号换成姓名。 */
export function checklistView(checklist: PeriodChecklist | null, names: ReadonlyMap<string, string>): PeriodChecklist | null {
  if (!checklist) return null
  return {
    ...checklist,
    items: checklist.items.map(item => (item.acknowledgement ? { ...item, acknowledgement: { ...item.acknowledgement, by: nameOrFormer(names, item.acknowledgement.by) } } : item)),
  }
}

export const bounds = (row: Pick<PeriodRecord, 'periodStart' | 'periodEnd'>) => ({ start: dateText(row.periodStart), end: dateText(row.periodEnd) })

export async function tenantZone(prisma: PrismaService | Db, tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  return validZone(tenant?.timezone)
}

/** 期间必须在成员的数据范围内；范围外与不存在一样返回 404，不泄露它存在。 */
export async function loadPeriod(prisma: PrismaService | Db, tenantId: string, scope: ResolvedScope, id: string): Promise<PeriodRecord> {
  const row = await prisma.accountingPeriod.findFirst({ where: { id, tenantId, ...storeWhere(scope) }, select: PERIOD_SELECT })
  if (!row) throw appError('RESOURCE_NOT_FOUND', '关账期间不存在')
  return row
}

export async function namesOf(prisma: PrismaService, tenantId: string, rows: readonly PeriodRecord[], extra: readonly string[] = []): Promise<Map<string, string>> {
  return memberNames(prisma, tenantId, [...rows.flatMap(row => [row.closedBy, row.createdBy, row.checkedBy, row.approvedBy, row.reopenedBy]), ...extra])
}

export function periodRowOf(row: PeriodRecord, names: ReadonlyMap<string, string>): PeriodRow {
  const { start, end } = bounds(row)
  const status = statusOf(row.status)
  return {
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    periodStart: start,
    periodEnd: end,
    month: monthOfStart(start),
    status,
    statusLabel: PERIOD_STATUS_LABEL[status],
    closedBy: row.closedBy ? nameOrFormer(names, row.closedBy) : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closeCount: row.closeCount,
    checkPassed: checklistOf(row.checklistJson)?.passed ?? null,
    version: row.version,
  }
}

export function periodDetailOf(row: PeriodRecord, names: ReadonlyMap<string, string>): PeriodDetail {
  const status = statusOf(row.status)
  const who = (id: string | null) => (id ? nameOrFormer(names, id) : null)
  return {
    ...periodRowOf(row, names),
    createdBy: nameOrFormer(names, row.createdBy),
    checkedBy: who(row.checkedBy),
    checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
    approvalDecision: row.approvalDecision === 'APPROVED' || row.approvalDecision === 'REJECTED' ? row.approvalDecision : null,
    approvedBy: who(row.approvedBy),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approvalComment: row.approvalComment,
    reopenedBy: who(row.reopenedBy),
    reopenedAt: row.reopenedAt ? row.reopenedAt.toISOString() : null,
    reopenReason: row.reopenReason,
    statusNote: PERIOD_STATUS_NOTE[status],
  }
}

/** 这个成员此刻可以对这个期间做哪些动作；写入口执行前用同一套规则再判断一次。 */
export function actionsFor(row: PeriodRecord, userId: string, permissions: readonly string[]): PeriodActions {
  return periodActionsOf({
    status: statusOf(row.status),
    approvalDecision: row.approvalDecision,
    checkedBy: row.checkedBy,
    userId,
    canClose: hasPermission(permissions, PERIOD_CLOSE),
    canReopen: hasPermission(permissions, PERIOD_REOPEN),
  })
}

/** 动作不可用时按“数据条件不满足”拒绝，原因就是页面上显示的那句话。 */
export function requireAllowed(actions: PeriodActions, key: keyof PeriodActions) {
  if (!actions[key].allowed) throw appError('DATA_CONDITION_FAILED', actions[key].reason ?? '当前状态不能执行这个操作')
}
