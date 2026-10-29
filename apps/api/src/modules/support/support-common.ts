import {
  SUPPORT_APPOINTMENT_STATUS_LABEL,
  SUPPORT_DIRECTIONS,
  SUPPORT_DIRECTION_LABEL,
  SUPPORT_FRESHNESS_KEY,
  SUPPORT_ROLE_PENDING,
  aggregateFreshness,
  freshnessSourceOfJobType,
  maskFreeText,
  supportChannelLabel,
  supportStatusLabel,
  type InventoryFreshness,
  type SupportAppointmentRow,
  type SupportCaseRow,
  type SupportContactRow,
  type SupportDirection,
  type SupportSync,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'

// 支持案件模块的公共部分（P2b-04）：选择列、行转换、同步状态、与赔付案件的关联。

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const CASE_SELECT = {
  id: true,
  caseId: true,
  sellerAccountId: true,
  subject: true,
  status: true,
  amazonCreatedAt: true,
  amazonUpdatedAt: true,
  amazonResolvedAt: true,
  lastOutboundAt: true,
  contactsForUpdatedAt: true,
  contactCount: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.SupportCaseSelect
export type CaseRecord = Prisma.SupportCaseGetPayload<{ select: typeof CASE_SELECT }>

export const CONTACT_SELECT = { id: true, contactId: true, channel: true, direction: true, senderName: true, body: true, attachmentsJson: true, occurredAt: true } satisfies Prisma.SupportContactSelect
export type ContactRecord = Prisma.SupportContactGetPayload<{ select: typeof CONTACT_SELECT }>

const iso = (value: Date | null) => (value ? value.toISOString() : null)

export type ReimbursementLink = { id: string; caseNo: string }

export function caseRow(row: CaseRecord, link: ReimbursementLink | null): SupportCaseRow {
  return {
    id: row.id,
    caseId: row.caseId,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    subject: row.subject,
    status: row.status,
    statusLabel: supportStatusLabel(row.status),
    createdAt: row.amazonCreatedAt.toISOString(),
    updatedAt: row.amazonUpdatedAt.toISOString(),
    resolvedAt: iso(row.amazonResolvedAt),
    lastOutboundAt: iso(row.lastOutboundAt),
    // 还没取过沟通记录（或案件更新后尚未重取）时没有可信的条数
    contactCount: row.contactsForUpdatedAt ? row.contactCount : null,
    reimbursementCaseId: link?.id ?? null,
    reimbursementCaseNo: link?.caseNo ?? null,
  }
}

const directionOf = (value: string): SupportDirection => ((SUPPORT_DIRECTIONS as readonly string[]).includes(value) ? (value as SupportDirection) : 'UNKNOWN')

export function contactRow(row: ContactRecord): SupportContactRow {
  const direction = directionOf(row.direction)
  const names = Array.isArray(row.attachmentsJson) ? row.attachmentsJson.filter((item): item is string => typeof item === 'string') : []
  // 正文是自由文本，可能含电话、邮箱、地址：详情里只给掩码版本与识别出的类别，完整正文经 POST /pii/reveal 填理由后查看（P6-14）
  const shown = maskFreeText(row.body)
  return {
    id: row.id,
    contactId: row.contactId,
    channel: row.channel,
    channelLabel: supportChannelLabel(row.channel),
    direction,
    directionLabel: SUPPORT_DIRECTION_LABEL[direction],
    senderName: row.senderName,
    body: shown.text,
    piiKinds: shown.kinds,
    attachments: names,
    occurredAt: row.occurredAt.toISOString(),
  }
}

/** 预约回电：只有时间窗与状态，没有电话号码（同步时就没有保存）。 */
export function appointmentRows(value: unknown): SupportAppointmentRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    const item = entry as Record<string, unknown> | null
    if (!item || typeof item.appointmentId !== 'string' || typeof item.earliestAt !== 'string' || typeof item.latestAt !== 'string') return []
    const status = typeof item.status === 'string' ? item.status : 'UNKNOWN'
    return [
      {
        appointmentId: item.appointmentId,
        status,
        statusLabel: SUPPORT_APPOINTMENT_STATUS_LABEL[status] ?? status,
        earliestAt: item.earliestAt,
        latestAt: item.latestAt,
        answeringParty: typeof item.answeringParty === 'string' ? item.answeringParty : null,
      },
    ]
  })
}

/** 范围内店铺的支持案件同步状态（最差的店铺为准）与新鲜度条所需的摘要。 */
export async function supportSync(prisma: PrismaService, tenantId: string, scope: ResolvedScope, now = new Date()): Promise<{ sync: SupportSync; freshness: InventoryFreshness }> {
  const spec = freshnessSourceOfJobType('SUPPORT_SYNC')
  const [stores, rows] = await Promise.all([
    prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true }, take: 500 }),
    prisma.dataFreshness.findMany({
      where: { tenantId, sourceKey: SUPPORT_FRESHNESS_KEY, ...storeWhere(scope) },
      select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
      take: 5000,
    }),
  ])
  const view = spec
    ? aggregateFreshness(
        rows,
        stores.map(store => store.id),
        now,
        [spec],
      ).sources[0]
    : null
  if (!view) {
    const sync: SupportSync = { status: 'NO_RECORD', statusLabel: '尚无记录', lastSuccessAt: null, errorCode: null, errorMessage: null, rolePending: false }
    return { sync, freshness: { lastSuccessAt: null, sources: [], qualityIssues: 0 } }
  }
  const sync: SupportSync = {
    status: view.status,
    statusLabel: view.statusLabel,
    lastSuccessAt: iso(view.lastSuccessAt),
    errorCode: view.errorCode,
    errorMessage: view.errorMessage,
    rolePending: view.errorCode === SUPPORT_ROLE_PENDING,
  }
  const healthy = ['NORMAL', 'NOT_APPLICABLE', 'NOT_CONNECTED'].includes(view.status)
  return { sync, freshness: { lastSuccessAt: sync.lastSuccessAt, sources: view.lastSuccessAt ? [view.label] : [], qualityIssues: healthy ? 0 : 1 } }
}

/** 亚马逊案件编号 → 赔付案件（回填的案件编号一致）；同一编号有多个赔付案件时取最早建立的。 */
export async function reimbursementLinks(prisma: PrismaService, tenantId: string, scope: ResolvedScope, amazonCaseIds: readonly string[]): Promise<Map<string, ReimbursementLink>> {
  const result = new Map<string, ReimbursementLink>()
  if (amazonCaseIds.length === 0) return result
  const rows = await prisma.reimbursementCase.findMany({
    where: { tenantId, ...storeWhere(scope), amazonCaseId: { in: [...amazonCaseIds] } },
    select: { id: true, caseNo: true, amazonCaseId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 1000,
  })
  for (const row of rows) if (row.amazonCaseId && !result.has(row.amazonCaseId)) result.set(row.amazonCaseId, { id: row.id, caseNo: row.caseNo })
  return result
}
