import type { Prisma, PrismaClient } from '@prisma/client'
import { PROFIT_METRIC_VERSION } from '@nova/api-contracts'
import type { ProfitRow } from './assemble'
import type { DayRange } from './types'

// 利润日表落库（P2b-09）：先删范围内旧行、再写新行，放在同一个事务里，可以对同一范围重复执行、结果完全相同。
// 事务里没有任何外部调用；行数大时分批 createMany。

const BATCH = 500
const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`)

export function toRecord(tenantId: string, row: ProfitRow, now: Date) {
  return {
    tenantId,
    sellerAccountId: row.sellerAccountId,
    profitDate: dayDate(row.profitDate),
    sku: row.sku,
    asin: row.asin,
    basis: row.basis,
    costing: row.costing,
    currency: row.currency,
    units: row.units,
    costedUnits: row.costedUnits,
    revenue: row.revenue,
    refunds: row.refunds,
    feeCommission: row.feeCommission,
    feeFulfillment: row.feeFulfillment,
    feeStorage: row.feeStorage,
    feeAged: row.feeAged,
    feeInbound: row.feeInbound,
    feeOther: row.feeOther,
    promotion: row.promotion,
    adsSpendAllocated: row.adsSpendAllocated,
    adsUnallocated: row.adsUnallocated,
    productCost: row.productCost,
    firstMileCost: row.firstMileCost,
    otherCost: row.otherCost,
    dutyCost: row.dutyCost ?? null,
    // 没有按项目拆分的金额时不写这个键，数据库保持空值
    ...(row.itemAmounts ? { itemAmounts: row.itemAmounts } : {}),
    // 估算金额（P6-20）：没有估算时不写这个键，数据库保持空值
    ...(row.estimatedFee ? { estimatedFee: row.estimatedFee } : {}),
    reimbursement: row.reimbursement,
    profit: row.profit,
    costCoverage: row.costCoverage,
    costCurrency: row.costCurrency,
    productCostOriginal: row.productCostOriginal,
    firstMileCostOriginal: row.firstMileCostOriginal,
    fxRate: row.fxRate,
    fxSource: row.fxSource,
    fxFallback: row.fxFallback,
    flags: row.flags,
    metricVersion: PROFIT_METRIC_VERSION,
    refreshedAt: now,
  }
}

/** 关账中或已关账的期间对该店铺是冻结的：利润日表不再重算，审批看到的和锁定保存的是同一份数据（07 章 7.12）。 */
export interface FrozenSpan {
  sellerAccountId: string
  from: string
  to: string
}

export async function frozenSpans(tx: Pick<Prisma.TransactionClient, 'accountingPeriod'>, tenantId: string, range: DayRange): Promise<FrozenSpan[]> {
  const rows = await tx.accountingPeriod.findMany({
    where: { tenantId, status: { in: ['CLOSING', 'CLOSED'] }, periodStart: { lte: dayDate(range.to) }, periodEnd: { gte: dayDate(range.from) } },
    select: { sellerAccountId: true, periodStart: true, periodEnd: true },
    take: 2000,
  })
  return rows.map(row => ({ sellerAccountId: row.sellerAccountId, from: row.periodStart.toISOString().slice(0, 10), to: row.periodEnd.toISOString().slice(0, 10) }))
}

export const isFrozen = (spans: readonly FrozenSpan[], sellerAccountId: string, profitDate: string) =>
  spans.some(span => span.sellerAccountId === sellerAccountId && profitDate >= span.from && profitDate <= span.to)

/** 返回实际写入的行数（冻结期间的行不写）。 */
export async function writeProfit(db: Pick<PrismaClient, '$transaction'>, tenantId: string, range: DayRange, rows: readonly ProfitRow[], now: Date): Promise<number> {
  return db.$transaction(
    async tx => {
      const spans = await frozenSpans(tx, tenantId, range)
      const keep = spans.length === 0 ? rows : rows.filter(row => !isFrozen(spans, row.sellerAccountId, row.profitDate))
      await tx.profitDaily.deleteMany({
        where: {
          tenantId,
          profitDate: { gte: dayDate(range.from), lte: dayDate(range.to) },
          ...(spans.length > 0 ? { NOT: spans.map(span => ({ sellerAccountId: span.sellerAccountId, profitDate: { gte: dayDate(span.from), lte: dayDate(span.to) } })) } : {}),
        },
      })
      for (let index = 0; index < keep.length; index += BATCH) {
        await tx.profitDaily.createMany({ data: keep.slice(index, index + BATCH).map(row => toRecord(tenantId, row, now)) })
      }
      return keep.length
    },
    { timeout: 120_000, maxWait: 30_000 },
  )
}
