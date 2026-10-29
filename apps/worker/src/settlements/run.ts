import { SETTLEMENT_RECHECK_DAYS } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { PrismaClient } from '@prisma/client'
import { findOrders, loadCoverage, loadLines, loadTransactions, sumUnattributed } from './load'
import { buildReconciliation } from './reconcile'
import { writeOutcome } from './write'

// 结算核对的定时任务（P2b-07）：逐个企业，把最近 120 天的结算单逐张核对（结算报告 × 财务接口交易 × 我方订单）并写回。
// 单张结算单出错不拖垮其它结算单，单个企业出错不拖垮其它企业。下一轮会整张重算，所以结果总是以最新数据为准。

export const SETTLEMENT_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SETTLEMENT_BATCH = 500

export interface TenantReconcile {
  settlements: number
  matched: number
  discrepancy: number
  pending: number
  errors: string[]
}

type Logger = { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }

/** 已经在企业的租户上下文里时调用（导入结算报告后、测试与手动触发也走这里）。sellerAccountId 给出时只核对该店铺。 */
export async function reconcileTenant(db: PrismaClient, tenantId: string, now: Date = new Date(), sellerAccountId?: string): Promise<TenantReconcile> {
  const settlements = await db.fbaSettlement.findMany({
    where: { tenantId, ...(sellerAccountId ? { sellerAccountId } : {}), sortAt: { gte: new Date(now.getTime() - SETTLEMENT_RECHECK_DAYS * DAY_MS) } },
    orderBy: { sortAt: 'desc' },
    take: SETTLEMENT_BATCH,
    select: { id: true, sellerAccountId: true, externalSettlementId: true, currency: true, settlementStartDate: true, settlementEndDate: true, totalAmount: true },
  })
  const result: TenantReconcile = { settlements: settlements.length, matched: 0, discrepancy: 0, pending: 0, errors: [] }
  const coverage = new Map<string, Awaited<ReturnType<typeof loadCoverage>>>()
  for (const row of settlements) {
    try {
      if (!coverage.has(row.sellerAccountId)) coverage.set(row.sellerAccountId, await loadCoverage(db, tenantId, row.sellerAccountId))
      const [{ lines, truncated }, transactions] = await Promise.all([loadLines(db, row.id), loadTransactions(db, tenantId, row.sellerAccountId, row.id)])
      const orderIds = [...new Set(lines.flatMap(line => (line.category !== 'RESERVE' && line.amazonOrderId ? [line.amazonOrderId] : [])))]
      const headerTotal = row.totalAmount === null ? null : Number(row.totalAmount.toString())
      const target = {
        tenantId,
        sellerAccountId: row.sellerAccountId,
        settlementId: row.id,
        externalSettlementId: row.externalSettlementId,
        currency: row.currency,
        periodStart: row.settlementStartDate,
        periodEnd: row.settlementEndDate,
      }
      const outcome = await buildReconciliation({
        settlement: { currency: row.currency, periodStart: row.settlementStartDate, periodEnd: row.settlementEndDate, headerTotal },
        lines,
        transactions,
        foundOrders: await findOrders(db, tenantId, row.sellerAccountId, orderIds),
        coverage: coverage.get(row.sellerAccountId)!,
        unattributedFor: ids => sumUnattributed(db, target, ids),
      })
      await writeOutcome(db, target, outcome, now, truncated)
      if (outcome.status === 'MATCHED') result.matched += 1
      else if (outcome.status === 'DISCREPANCY') result.discrepancy += 1
      else result.pending += 1
    } catch (error) {
      result.errors.push(`${row.externalSettlementId}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
    }
  }
  return result
}

export interface ReconcileAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  logger: Logger
  now?: () => Date
}

export async function reconcileAllTenants(deps: ReconcileAllDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let settlements = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => reconcileTenant(deps.db, tenant.id, deps.now?.() ?? new Date()))
      settlements += result.settlements
      if (result.errors.length > 0) deps.logger.warn({ event: 'settlement_reconcile_errors', errors: result.errors.slice(0, 5) }, 'some settlements failed to reconcile')
    } catch (error) {
      deps.logger.warn({ event: 'settlement_reconcile_failed', error: error instanceof Error ? error.message : String(error) }, 'settlement reconcile failed for a tenant')
    }
  }
  return { tenants: tenants.length, settlements }
}
