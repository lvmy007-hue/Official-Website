import {
  EXCEPTION_CATEGORY_HINT,
  EXCEPTION_CATEGORY_LABEL,
  EXCEPTION_KIND_LABEL,
  EXCEPTION_STATUS_LABEL,
  SETTLEMENT_CATEGORIES,
  SETTLEMENT_CATEGORY_LABEL,
  SETTLEMENT_STATUS_LABEL,
  type CategoryTotals,
  type ExceptionCategory,
  type ExceptionKind,
  type ExceptionStatus,
  type SettlementCategory,
  type SettlementExceptionRow,
  type SettlementLineRow,
  type SettlementPendingReason,
  type SettlementRow,
  type SettlementStatus,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'

// 结算交易页共用：结算单行转换、按数据范围找结算单、明细与异常行转换。金额一律带符号，不跨币种相加；没有数据是 null，不写 0。

export const SETTLEMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const SETTLEMENT_SELECT = {
  id: true,
  sellerAccountId: true,
  externalSettlementId: true,
  settlementStartDate: true,
  settlementEndDate: true,
  depositDate: true,
  openingBalance: true,
  summaryJson: true,
  disbursementAmount: true,
  totalAmount: true,
  currency: true,
  txnCount: true,
  reconciliationStatus: true,
  diffAmount: true,
  sortAt: true,
  sellerAccount: { select: { displayName: true } },
  reconciliation: { select: { id: true, pendingReason: true } },
} satisfies Prisma.FbaSettlementSelect
export type SettlementRecord = Prisma.FbaSettlementGetPayload<{ select: typeof SETTLEMENT_SELECT }>

export const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
const iso = (value: Date | null) => value?.toISOString() ?? null

const isStatus = (value: string): value is SettlementStatus => value in SETTLEMENT_STATUS_LABEL
const isCategory = (value: string): value is SettlementCategory => (SETTLEMENT_CATEGORIES as readonly string[]).includes(value)

/** 汇总 JSON 取出各类别合计；缺的类别补 0（这是“报告里这一类没有行”，不是“没有数据”）；整份为空返回 null。 */
export function totalsOf(value: unknown): CategoryTotals | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const totals = {} as CategoryTotals
  for (const key of SETTLEMENT_CATEGORIES) totals[key] = typeof source[key] === 'number' ? (source[key] as number) : 0
  return totals
}

export function pendingReasonOf(row: Pick<SettlementRecord, 'reconciliationStatus' | 'txnCount' | 'reconciliation'>): SettlementPendingReason | null {
  if (row.reconciliationStatus !== 'PENDING') return null
  const saved = row.reconciliation?.pendingReason
  if (saved === 'NO_REPORT' || saved === 'NO_TRANSACTIONS') return saved
  return row.txnCount === 0 ? 'NO_REPORT' : 'NO_TRANSACTIONS'
}

export function settlementRow(row: SettlementRecord, openExceptions: number): SettlementRow {
  const status: SettlementStatus = isStatus(row.reconciliationStatus) ? row.reconciliationStatus : 'PENDING'
  return {
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    externalSettlementId: row.externalSettlementId,
    periodStart: iso(row.settlementStartDate),
    periodEnd: iso(row.settlementEndDate),
    depositDate: iso(row.depositDate),
    openingBalance: num(row.openingBalance),
    totals: row.txnCount > 0 ? totalsOf(row.summaryJson) : null,
    disbursementAmount: num(row.disbursementAmount),
    totalAmount: num(row.totalAmount),
    currency: row.currency,
    txnCount: row.txnCount,
    status,
    statusLabel: SETTLEMENT_STATUS_LABEL[status],
    pendingReason: pendingReasonOf({ ...row, reconciliationStatus: status }),
    diffAmount: status === 'PENDING' ? null : num(row.diffAmount),
    openExceptions,
  }
}

/** 每张结算单未处理的异常数（一次取回）。 */
export async function openExceptionCounts(prisma: PrismaService, tenantId: string, rows: ReadonlyArray<Pick<SettlementRecord, 'reconciliation'>>): Promise<Map<string, number>> {
  const ids = rows.flatMap(row => (row.reconciliation ? [row.reconciliation.id] : []))
  const counts = new Map<string, number>()
  if (ids.length === 0) return counts
  const groups = await prisma.reconciliationException.groupBy({ by: ['reconciliationId'], where: { tenantId, reconciliationId: { in: ids }, status: 'OPEN' }, _count: { _all: true } })
  for (const group of groups) counts.set(group.reconciliationId, group._count._all)
  return counts
}

/** 在成员的数据范围内按系统编号或亚马逊结算编号找结算单（多个店铺碰巧同号时取最近的）；找不到统一报不存在，不区分“没有”和“无权看”。 */
export async function findSettlement(prisma: PrismaService, tenantId: string, scope: ResolvedScope, id: string): Promise<SettlementRecord> {
  if (!SETTLEMENT_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '结算单不存在')
  const row = await prisma.fbaSettlement.findFirst({
    where: { tenantId, ...storeWhere(scope), OR: [{ id }, { externalSettlementId: id }] },
    orderBy: [{ sortAt: 'desc' }, { id: 'asc' }],
    select: SETTLEMENT_SELECT,
  })
  if (!row) throw appError('RESOURCE_NOT_FOUND', '结算单不存在')
  return row
}

export const LINE_SELECT = {
  id: true,
  lineNo: true,
  postedAt: true,
  transactionType: true,
  amountType: true,
  amountDescription: true,
  category: true,
  amazonOrderId: true,
  sku: true,
  quantity: true,
  amount: true,
  currency: true,
} satisfies Prisma.SettlementLineSelect
export type LineRecord = Prisma.SettlementLineGetPayload<{ select: typeof LINE_SELECT }>

export function lineRow(row: LineRecord, extra: { asin: string | null; orderFound: boolean; feeEventId: string | null }): SettlementLineRow {
  const category: SettlementCategory = isCategory(row.category) ? row.category : 'ADJUSTMENT'
  return {
    id: row.id,
    lineNo: row.lineNo,
    postedAt: iso(row.postedAt),
    transactionType: row.transactionType,
    amountType: row.amountType,
    amountDescription: row.amountDescription,
    category,
    categoryLabel: SETTLEMENT_CATEGORY_LABEL[category],
    amazonOrderId: row.amazonOrderId,
    sku: row.sku,
    asin: extra.asin,
    quantity: row.quantity,
    amount: num(row.amount) ?? 0,
    currency: row.currency,
    orderFound: extra.orderFound,
    feeEventId: extra.feeEventId,
  }
}

export const EXCEPTION_SELECT = {
  id: true,
  kind: true,
  category: true,
  refKey: true,
  amazonOrderId: true,
  reportAmount: true,
  apiAmount: true,
  amount: true,
  absAmount: true,
  currency: true,
  note: true,
  status: true,
} satisfies Prisma.ReconciliationExceptionSelect
export type ExceptionRecord = Prisma.ReconciliationExceptionGetPayload<{ select: typeof EXCEPTION_SELECT }>

export function exceptionRow(row: ExceptionRecord, orderFound: boolean): SettlementExceptionRow {
  const kind = (row.kind in EXCEPTION_KIND_LABEL ? row.kind : 'AMOUNT_MISMATCH') as ExceptionKind
  const category = (row.category in EXCEPTION_CATEGORY_LABEL ? row.category : 'UNEXPLAINED') as ExceptionCategory
  const status = (row.status in EXCEPTION_STATUS_LABEL ? row.status : 'OPEN') as ExceptionStatus
  return {
    id: row.id,
    kind,
    kindLabel: EXCEPTION_KIND_LABEL[kind],
    category,
    categoryLabel: EXCEPTION_CATEGORY_LABEL[category],
    categoryHint: EXCEPTION_CATEGORY_HINT[category],
    refKey: row.refKey,
    amazonOrderId: row.amazonOrderId,
    reportAmount: num(row.reportAmount) ?? 0,
    apiAmount: num(row.apiAmount) ?? 0,
    amount: num(row.amount) ?? 0,
    currency: row.currency,
    note: row.note,
    status,
    statusLabel: EXCEPTION_STATUS_LABEL[status],
    orderFound,
  }
}

/** 这些订单号在我方订单里存在的集合（没有“订单”读取权限的人不查，一律当作没有）。 */
export async function existingOrders(prisma: PrismaService, tenantId: string, scope: ResolvedScope, orderIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(orderIds)]
  if (unique.length === 0) return new Set()
  const rows = await prisma.order.findMany({
    where: { tenantId, ...storeWhere(scope), amazonOrderId: { in: unique } },
    select: { amazonOrderId: true },
    distinct: ['amazonOrderId'],
    take: unique.length,
  })
  return new Set(rows.map(row => row.amazonOrderId))
}
