import {
  FEE_CATEGORIES,
  FEE_CATEGORY_LABEL,
  FEE_DEFAULT_DAYS,
  FEE_SOURCE_LABEL,
  RECONCILIATION_LABEL,
  feeSourceOf,
  feeSubtypeLabel,
  feeTransactionStatusLabel,
  type FeeCategory,
  type FeeEventListQuery,
  type FeeEventRow,
  type FeeRange,
  type ReconciliationStatus,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { addDays, todayIn, validZone, zonedDayStart } from '../overview'

// 费用事件页共用：行转换、时间范围（按企业口径时区）、筛选条件、来源交易里的货件标识。

/** 新鲜度来源：财务交易（费用明细由它拆出）与两份费用报告。 */
export const FEE_FRESHNESS_KEYS = ['finance.transactions', 'rpt.storage-fee', 'rpt.inbound-noncompliance'] as const
export const FEE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** 对账变更记录（EntityEvent）的对象类型与种类。 */
export const FEE_ENTITY_TYPE = 'FEE_EVENT'
export const FEE_HISTORY_KIND = 'fee.reconciliation'
/** 一次最多带出多少条同一笔交易的其他明细。 */
export const SIBLING_LIMIT = 50

export const EVENT_SELECT = {
  id: true,
  sellerAccountId: true,
  feeCategory: true,
  feeSubtype: true,
  amount: true,
  currency: true,
  postedAt: true,
  transactionStatus: true,
  amazonOrderId: true,
  asin: true,
  sellerSku: true,
  settlementId: true,
  sourceRecordId: true,
  sourceEventId: true,
  reconciliationStatus: true,
  reconciliationNote: true,
  reconciledAt: true,
  version: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.FbaFeeEventSelect
export type EventRecord = Prisma.FbaFeeEventGetPayload<{ select: typeof EVENT_SELECT }>

const num = (value: { toString(): string }) => Number(value.toString())

export function eventRow(row: EventRecord, shipmentId: string | null): FeeEventRow {
  const category = (FEE_CATEGORIES as readonly string[]).includes(row.feeCategory) ? (row.feeCategory as FeeCategory) : 'OTHER'
  const source = feeSourceOf(row.sourceEventId)
  const reconciliation = (row.reconciliationStatus in RECONCILIATION_LABEL ? row.reconciliationStatus : 'UNRECONCILED') as ReconciliationStatus
  return {
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    category,
    categoryLabel: FEE_CATEGORY_LABEL[category],
    subtype: row.feeSubtype,
    subtypeLabel: feeSubtypeLabel(row.feeSubtype),
    amount: num(row.amount),
    currency: row.currency,
    postedAt: row.postedAt.toISOString(),
    transactionStatus: row.transactionStatus,
    transactionStatusLabel: feeTransactionStatusLabel(row.transactionStatus),
    amazonOrderId: row.amazonOrderId,
    asin: row.asin,
    sellerSku: row.sellerSku,
    settlementId: row.settlementId,
    shipmentId,
    source,
    sourceLabel: FEE_SOURCE_LABEL[source],
    reconciliationStatus: reconciliation,
    reconciliationLabel: RECONCILIATION_LABEL[reconciliation],
    reconciliationNote: row.reconciliationNote,
    reconciledAt: row.reconciledAt?.toISOString() ?? null,
    version: row.version,
  }
}

/** 时间范围：没选日期默认最近 30 天；日期按企业口径时区换算成起止时刻（右端不含）。 */
export async function resolveRange(prisma: PrismaService, tenantId: string, query: Pick<FeeEventListQuery, 'from' | 'to'>, now = new Date()) {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  const zone = validZone(tenant?.timezone)
  const defaulted = !(query.from && query.to)
  const to = query.to ?? todayIn(zone, now)
  const from = query.from ?? addDays(to, 1 - FEE_DEFAULT_DAYS)
  const gte = zonedDayStart(from, zone)
  const lt = zonedDayStart(addDays(to, 1), zone)
  const range: FeeRange = { from, to, defaulted, fromAt: gte.toISOString(), toAt: lt.toISOString() }
  return { range, gte, lt }
}

/**
 * 筛选条件。category 缺省时看全部 9 类（不含“不是费用”的销售收入与税）；
 * 关键词按订单号、结算单号、交易编号、ASIN、SKU 开头匹配（走索引前缀，不做全表模糊搜索）。
 */
export function feeWhere(
  tenantId: string,
  scope: ResolvedScope,
  query: FeeEventListQuery,
  gte: Date,
  lt: Date,
  options: { withCategory: boolean } = { withCategory: true },
): Prisma.FbaFeeEventWhereInput {
  const q = query.q
  return {
    tenantId,
    ...storeWhere(scope),
    postedAt: { gte, lt },
    feeCategory: options.withCategory && query.category ? query.category : { in: [...FEE_CATEGORIES] },
    ...(query.status ? { transactionStatus: query.status } : {}),
    ...(query.reconciliation ? { reconciliationStatus: query.reconciliation } : {}),
    ...(q
      ? {
          OR: [
            { amazonOrderId: { startsWith: q } },
            { settlementId: { startsWith: q } },
            { sourceRecordId: { startsWith: q } },
            { asin: { startsWith: q.toUpperCase() } },
            { sellerSku: { startsWith: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  }
}

type RelatedIdentifier = { name?: unknown; value?: unknown }
export const relatedOf = (value: unknown): Array<{ name: string; value: string }> =>
  (Array.isArray(value) ? (value as RelatedIdentifier[]) : []).flatMap(item => (typeof item?.name === 'string' && typeof item?.value === 'string' ? [{ name: item.name, value: item.value }] : []))

const txKey = (sellerAccountId: string, transactionId: string, postedAt: Date) => `${sellerAccountId}|${transactionId}|${postedAt.toISOString()}`

/** 一页费用事件对应的来源交易里的货件标识（SHIPMENT_ID）：交易的入账时间与费用事件相同，按（店铺、交易编号、入账时间）一次取回。 */
export async function loadShipmentIds(
  prisma: PrismaService,
  tenantId: string,
  rows: ReadonlyArray<Pick<EventRecord, 'sellerAccountId' | 'sourceRecordId' | 'sourceEventId' | 'postedAt'>>,
): Promise<Map<string, string>> {
  const keys = new Map<string, { sellerAccountId: string; externalTransactionId: string; postedAt: Date }>()
  for (const row of rows) {
    if (row.sourceRecordId && feeSourceOf(row.sourceEventId) === 'FINANCE_API')
      keys.set(txKey(row.sellerAccountId, row.sourceRecordId, row.postedAt), { sellerAccountId: row.sellerAccountId, externalTransactionId: row.sourceRecordId, postedAt: row.postedAt })
  }
  const result = new Map<string, string>()
  if (keys.size === 0) return result
  const transactions = await prisma.fbaFinancialTransaction.findMany({
    where: { tenantId, OR: [...keys.values()] },
    select: { sellerAccountId: true, externalTransactionId: true, postedAt: true, relatedIdentifiers: true },
    take: keys.size,
  })
  for (const transaction of transactions) {
    const shipment = relatedOf(transaction.relatedIdentifiers).find(item => item.name === 'SHIPMENT_ID')
    if (shipment) result.set(txKey(transaction.sellerAccountId, transaction.externalTransactionId, transaction.postedAt), shipment.value)
  }
  return result
}

export const shipmentKeyOf = (row: Pick<EventRecord, 'sellerAccountId' | 'sourceRecordId' | 'postedAt'>) => (row.sourceRecordId ? txKey(row.sellerAccountId, row.sourceRecordId, row.postedAt) : '')
