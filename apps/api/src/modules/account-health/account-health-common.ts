import {
  ACCOUNT_STATUS_FRESHNESS_KEY,
  ACCOUNT_HEALTH_ROLE_MISSING,
  POLICY_HANDLING_STATUS_LABEL,
  POLICY_ISSUE_KIND_LABEL,
  POLICY_ISSUE_STATUS_LABEL,
  SELLER_PERFORMANCE_FRESHNESS_KEY,
  aggregateFreshness,
  freshnessSourceOfReport,
  type AccountHealthSync,
  type CursorPageInfo,
  type PolicyHandlingStatus,
  type PolicyIssueKind,
  type PolicyIssueRow,
  type PolicyIssueStatus,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { AppError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'
import { storeWhere, type ResolvedScope } from '../auth'

// 账户健康模块的公共部分（P5-02）：偏移游标（签名并绑定全部条件，与竞品、定价模块同一做法；模块之间只能经 index 引用，这里各留一份很小的实现）、
// 可见店铺、报告同步状态（按店铺）、政策问题行转换。

let codec: ReturnType<typeof createCursorCodec> | undefined
const cursorCodec = () => (codec ??= createCursorCodec(resolveCursorKey()))
const invalid = () => new AppError(400, 'CURSOR_INVALID', '翻页游标无效或查询条件已变化，请从第一页重新加载')

export function decodeOffset(token: string | undefined, binding: string): number {
  if (!token) return 0
  const payload = cursorCodec().decode(token)
  const offset = Number(payload.k)
  if (payload.b !== binding || payload.f !== 'offset' || !Number.isInteger(offset) || offset < 0) throw invalid()
  return offset
}

export function pageOf<T>(items: readonly T[], offset: number, pageSize: number, binding: string): { page: T[]; pageInfo: CursorPageInfo } {
  const page = items.slice(offset, offset + pageSize)
  const end = offset + page.length
  const hasMore = end < items.length
  const nextCursor = hasMore ? cursorCodec().encode({ v: 1, b: binding, f: 'offset', r: 'asc', t: 'n', k: String(end), i: '' }) : null
  return { page, pageInfo: { pageSize, nextCursor, hasMore, approxTotal: items.length } }
}

export async function storesOf(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.sellerAccount.findMany({
    where: { tenantId, ...storeWhere(scope, 'id') },
    select: { id: true, displayName: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 500,
  })
  return rows.map(row => ({ id: row.id, name: row.displayName }))
}

export const ymd = (date: Date): string => date.toISOString().slice(0, 10)
export const asDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
export const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const iso = (value: Date | null) => (value ? value.toISOString() : null)

const NO_RECORD: AccountHealthSync = { status: 'NO_RECORD', statusLabel: '尚无记录', lastSuccessAt: null, errorCode: null, errorMessage: null, rolePending: false }

type FreshnessRow = { sellerAccountId: string | null; sourceKey: string; lastAttemptAt: Date; lastSuccessAt: Date | null; dataThrough: Date | null; status: string; lastErrorCode: string | null }

/** 报告同步状态：keyed 按店铺；storeIds 为空表示没有店铺。 */
export async function reportSyncByStore(
  prisma: PrismaService,
  tenantId: string,
  storeIds: readonly string[],
  now = new Date(),
): Promise<{ byStore: Map<string, AccountHealthSync>; pushLastAt: Date | null; rows: FreshnessRow[] }> {
  const spec = freshnessSourceOfReport('GET_V2_SELLER_PERFORMANCE_REPORT')
  const rows =
    storeIds.length === 0
      ? []
      : await prisma.dataFreshness.findMany({
          where: { tenantId, sellerAccountId: { in: [...storeIds] }, sourceKey: { in: [SELLER_PERFORMANCE_FRESHNESS_KEY, ACCOUNT_STATUS_FRESHNESS_KEY] } },
          select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
          take: 5000,
        })
  const byStore = new Map<string, AccountHealthSync>()
  for (const storeId of storeIds) {
    const mine = rows.filter(row => row.sellerAccountId === storeId && row.sourceKey === SELLER_PERFORMANCE_FRESHNESS_KEY)
    const view = spec ? aggregateFreshness(mine, [storeId], now, [spec]).sources[0] : undefined
    byStore.set(
      storeId,
      view
        ? {
            status: view.status,
            statusLabel: view.statusLabel,
            lastSuccessAt: iso(view.lastSuccessAt),
            errorCode: view.errorCode,
            errorMessage: view.errorMessage,
            rolePending: view.errorCode === ACCOUNT_HEALTH_ROLE_MISSING,
          }
        : NO_RECORD,
    )
  }
  const pushTimes = rows.filter(row => row.sourceKey === ACCOUNT_STATUS_FRESHNESS_KEY && row.lastSuccessAt).map(row => (row.lastSuccessAt as Date).getTime())
  return { byStore, pushLastAt: pushTimes.length > 0 ? new Date(Math.max(...pushTimes)) : null, rows }
}

/** 多个店铺的报告同步状态合并成一个（取最差的店铺）；没有店铺记录时是“尚无记录”。 */
const SEVERITY = ['FAILED', 'UNAUTHORIZED', 'DELAYED', 'WAITING_DEPENDENCY', 'NO_RECORD', 'NOT_CONNECTED', 'NOT_APPLICABLE', 'NORMAL']
export function worstSync(list: readonly AccountHealthSync[]): AccountHealthSync {
  if (list.length === 0) return NO_RECORD
  return [...list].sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status))[0] ?? NO_RECORD
}

export const ISSUE_SELECT = {
  id: true,
  issueId: true,
  sellerAccountId: true,
  kind: true,
  title: true,
  status: true,
  firstSeenAt: true,
  lastSeenAt: true,
  resolvedAt: true,
  affectedAsinsJson: true,
  impactText: true,
  handlingStatus: true,
  handlingNote: true,
  ownerUserId: true,
  amazonCaseId: true,
  version: true,
} satisfies Prisma.PolicyIssueSelect
export type IssueRecord = Prisma.PolicyIssueGetPayload<{ select: typeof ISSUE_SELECT }>

const asinsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const kindOf = (value: string): PolicyIssueKind => (value in POLICY_ISSUE_KIND_LABEL ? (value as PolicyIssueKind) : 'OTHER')
const statusOf = (value: string): PolicyIssueStatus => (value === 'RESOLVED' ? 'RESOLVED' : 'OPEN')
const handlingOf = (value: string): PolicyHandlingStatus => (value === 'IN_PROGRESS' || value === 'DONE' ? value : 'OPEN')

export function issueRow(row: IssueRecord, storeName: string, ownerName: string | null): PolicyIssueRow {
  const kind = kindOf(row.kind)
  const status = statusOf(row.status)
  const handling = handlingOf(row.handlingStatus)
  return {
    id: row.id,
    issueId: row.issueId,
    sellerAccountId: row.sellerAccountId,
    storeName,
    kind,
    kindLabel: POLICY_ISSUE_KIND_LABEL[kind],
    title: row.title,
    asins: asinsOf(row.affectedAsinsJson),
    status,
    statusLabel: POLICY_ISSUE_STATUS_LABEL[status],
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    impactText: row.impactText,
    handlingStatus: handling,
    handlingStatusLabel: POLICY_HANDLING_STATUS_LABEL[handling],
    owner: row.ownerUserId && ownerName ? { id: row.ownerUserId, name: ownerName } : null,
    amazonCaseId: row.amazonCaseId,
    version: row.version,
  }
}
