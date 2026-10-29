import { SETTLEMENT_RECONCILER } from '@nova/api-contracts'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { ReconcileOutcome } from './reconcile'

// 把核对结果写回（P2b-07）：结算单上的状态与汇总、核对结果（Reconciliation）、异常清单，以及“已对平就把关联的费用明细与交易标为已对账”。
// 每一步都可以重复执行（下一轮核对会再算一遍），所以不开大事务：中途失败只会让这一轮的结果不完整，下一轮补齐。

export interface SettlementTarget {
  tenantId: string
  sellerAccountId: string
  /** 我方结算单主键（FbaSettlement.id）。 */
  settlementId: string
  /** 亚马逊的结算编号（费用明细的 settlementId 存的是它）。 */
  externalSettlementId: string
  currency: string
  periodStart: Date | null
  periodEnd: Date | null
}

const dayOf = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

export async function writeOutcome(db: PrismaClient, target: SettlementTarget, outcome: ReconcileOutcome, now: Date, loadTruncated: boolean) {
  const pending = outcome.status === 'PENDING'
  const hasReport = outcome.txnCount > 0

  await db.fbaSettlement.update({
    where: { id: target.settlementId },
    data: {
      openingBalance: outcome.openingBalance,
      txnCount: outcome.txnCount,
      summaryJson: hasReport ? (outcome.summary as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      reconciliationStatus: outcome.status,
      diffAmount: pending ? null : outcome.diffAmount,
    },
  })

  if (target.periodStart && target.periodEnd) {
    const detailJson = {
      report: outcome.report,
      api: outcome.api,
      orders: outcome.orders,
      checks: outcome.checks,
      exceptionsTotal: outcome.exceptions.length,
      exceptionsSaved: outcome.saved.length,
      truncated: outcome.exceptions.length > outcome.saved.length,
      loadTruncated,
    } as unknown as Prisma.InputJsonValue
    const common = {
      currency: target.currency,
      officialAmount: outcome.officialAmount,
      systemAmount: outcome.systemAmount,
      diffAmount: outcome.diffAmount,
      status: outcome.status,
      pendingReason: outcome.pendingReason,
      detailJson,
      computedAt: now,
      rangeStart: dayOf(target.periodStart),
      rangeEnd: dayOf(target.periodEnd),
    }
    const reconciliation = await db.reconciliation.upsert({
      where: { settlementId: target.settlementId },
      create: { tenantId: target.tenantId, sellerAccountId: target.sellerAccountId, scopeKind: 'SETTLEMENT', settlementId: target.settlementId, ...common },
      update: common,
      select: { id: true },
    })
    await writeExceptions(db, target, reconciliation.id, outcome, now)
  }

  await markRecords(db, target, outcome.status === 'MATCHED', now)
}

async function writeExceptions(db: PrismaClient, target: SettlementTarget, reconciliationId: string, outcome: ReconcileOutcome, now: Date) {
  const existing = await db.reconciliationException.findMany({ where: { reconciliationId }, select: { id: true, refKey: true, status: true }, take: 20_000 })
  const known = new Map(existing.map(item => [item.refKey, item]))
  const fields = (item: ReconcileOutcome['saved'][number]) => ({
    kind: item.kind,
    category: item.category,
    amazonOrderId: item.amazonOrderId,
    currency: target.currency,
    reportAmount: item.reportAmount,
    apiAmount: item.apiAmount,
    amount: item.amount,
    absAmount: Math.abs(item.amount),
    note: item.note,
  })

  const fresh = outcome.saved.filter(item => !known.has(item.refKey))
  for (let index = 0; index < fresh.length; index += 1000) {
    await db.reconciliationException.createMany({
      data: fresh.slice(index, index + 1000).map(item => ({ tenantId: target.tenantId, reconciliationId, refKey: item.refKey, status: 'OPEN', ...fields(item) })),
      skipDuplicates: true,
    })
  }
  for (const item of outcome.saved) {
    const row = known.get(item.refKey)
    if (!row) continue
    // 之前消除过的异常又出现了：重新打开
    await db.reconciliationException.update({ where: { id: row.id }, data: { ...fields(item), status: 'OPEN', resolvedBy: null, resolvedAt: null } })
  }
  const keep = new Set(outcome.saved.map(item => item.refKey))
  const gone = existing.filter(item => item.status === 'OPEN' && !keep.has(item.refKey)).map(item => item.id)
  for (let index = 0; index < gone.length; index += 1000) {
    await db.reconciliationException.updateMany({
      where: { reconciliationId, id: { in: gone.slice(index, index + 1000) }, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedBy: SETTLEMENT_RECONCILER, resolvedAt: now },
    })
  }
}

/**
 * 已对平：这张结算单关联的费用明细与交易自动标为已对账（只动“未对账”的，人工标过的差异、备注不碰）。
 * 不再对平：把上一轮由系统标的“已对账”退回“未对账”（费用明细按 reconciledBy 认系统标的；交易没有人工标记入口，直接退回）。
 */
async function markRecords(db: PrismaClient, target: SettlementTarget, matched: boolean, now: Date) {
  const { tenantId, sellerAccountId } = target
  if (matched) {
    await db.fbaFeeEvent.updateMany({
      where: { tenantId, sellerAccountId, settlementId: target.externalSettlementId, reconciliationStatus: 'UNRECONCILED' },
      data: { reconciliationStatus: 'RECONCILED', reconciledBy: SETTLEMENT_RECONCILER, reconciledAt: now, version: { increment: 1 } },
    })
    await db.fbaFinancialTransaction.updateMany({
      where: { tenantId, sellerAccountId, settlementId: target.settlementId, reconciliationStatus: 'UNRECONCILED' },
      data: { reconciliationStatus: 'RECONCILED' },
    })
    return
  }
  await db.fbaFeeEvent.updateMany({
    where: { tenantId, sellerAccountId, settlementId: target.externalSettlementId, reconciliationStatus: 'RECONCILED', reconciledBy: SETTLEMENT_RECONCILER },
    data: { reconciliationStatus: 'UNRECONCILED', reconciledBy: null, reconciledAt: null, version: { increment: 1 } },
  })
  await db.fbaFinancialTransaction.updateMany({
    where: { tenantId, sellerAccountId, settlementId: target.settlementId, reconciliationStatus: 'RECONCILED' },
    data: { reconciliationStatus: 'UNRECONCILED' },
  })
}
