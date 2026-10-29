import {
  FEE_CATEGORIES,
  FEE_CATEGORY_LABEL,
  FEE_DEFAULT_DAYS,
  FEE_SOURCE_LABEL,
  FEE_TRANSACTION_STATUSES,
  RECONCILIATION_LABEL,
  RECONCILIATION_STATUSES,
  feeSourceOf,
  feeSubtypeLabel,
  feeTransactionStatusLabel,
  type FeeCategory,
  type ReconciliationStatus,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { ExportRow, SourceContext } from './sources'

// 费用事件导出（P2b-05）：筛选与页面完全一致——时间范围用页面返回的起止时刻（fromAt、toAt），不再按日期重新换算；
// 不导出销售收入、税这类“不是费用”的明细（NON_FEE）。金额带符号（扣费为负）。

const EXPORT_PAGE_SIZE = 2000 // 与 sources.ts 的页大小一致；不从 sources 引入，避免两个文件互相引用
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const instant = (value: unknown) => {
  const parsed = text(value) ? new Date(text(value) as string) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined
}
const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.find(item => item === value)

export async function* feeEvents({ db, tenantId, filters, storeIds }: SourceContext): AsyncGenerator<ExportRow> {
  const toAt = instant(filters.toAt) ?? new Date()
  const fromAt = instant(filters.fromAt) ?? new Date(toAt.getTime() - FEE_DEFAULT_DAYS * 86_400_000)
  const category = pick<FeeCategory>(filters.category, FEE_CATEGORIES)
  const status = pick(filters.status, FEE_TRANSACTION_STATUSES)
  const reconciliation = pick<ReconciliationStatus>(filters.reconciliation, RECONCILIATION_STATUSES)
  const q = text(filters.q)
  const where: Prisma.FbaFeeEventWhereInput = {
    tenantId,
    ...(storeIds ? { sellerAccountId: { in: storeIds } } : {}),
    feeCategory: category ?? { not: 'NON_FEE' },
    postedAt: { gte: fromAt, lt: toAt },
    ...(status ? { transactionStatus: status } : {}),
    ...(reconciliation ? { reconciliationStatus: reconciliation } : {}),
    // 关键词条件与页面（费用事件列表）完全一致
    ...(q
      ? {
          OR: [
            { amazonOrderId: { startsWith: q } },
            { settlementId: { startsWith: q } },
            { sourceRecordId: { startsWith: q } },
            { asin: { startsWith: q.toUpperCase() } },
            { sellerSku: { startsWith: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }
  let after: { postedAt: Date; id: string } | undefined
  for (;;) {
    const rows = await db.fbaFeeEvent.findMany({
      where: after ? { AND: [where, { OR: [{ postedAt: { lt: after.postedAt } }, { postedAt: after.postedAt, id: { lt: after.id } }] }] } : where,
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_PAGE_SIZE,
      select: {
        id: true,
        postedAt: true,
        feeCategory: true,
        feeSubtype: true,
        amount: true,
        currency: true,
        transactionStatus: true,
        amazonOrderId: true,
        asin: true,
        sellerSku: true,
        settlementId: true,
        sourceEventId: true,
        reconciliationStatus: true,
        reconciliationNote: true,
        sellerAccount: { select: { displayName: true } },
      },
    })
    for (const row of rows) {
      yield {
        postedAt: row.postedAt,
        storeName: row.sellerAccount.displayName,
        category: FEE_CATEGORY_LABEL[row.feeCategory as FeeCategory] ?? row.feeCategory,
        subtype: feeSubtypeLabel(row.feeSubtype),
        amount: Number(row.amount.toString()),
        currency: row.currency,
        transactionStatus: feeTransactionStatusLabel(row.transactionStatus),
        amazonOrderId: row.amazonOrderId,
        asin: row.asin,
        sellerSku: row.sellerSku,
        settlementId: row.settlementId,
        reconciliation: RECONCILIATION_LABEL[row.reconciliationStatus as ReconciliationStatus] ?? row.reconciliationStatus,
        reconciliationNote: row.reconciliationNote,
        source: FEE_SOURCE_LABEL[feeSourceOf(row.sourceEventId)],
      }
    }
    if (rows.length < EXPORT_PAGE_SIZE) return
    const last = rows[rows.length - 1]
    after = { postedAt: last.postedAt, id: last.id }
  }
}
