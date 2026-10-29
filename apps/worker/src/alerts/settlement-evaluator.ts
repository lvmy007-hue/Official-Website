import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, scopeFilter } from './params'

// 结算差异预警评估器（P2b-16，09 章 9.1 财务类）：结算单的三方核对（P2b-07）结果为“有差异”，且差额绝对值达到阈值。
// 数据来自后台的结算核对（Reconciliation，每 6 小时与导入后重算）；重新对平后状态变回已对平，预警随之自动恢复。
// “待核对”（报告未到、没有关联交易）不算差异，不在此预警；放宽与容差沿用核对本身的口径，这里只加一个最小金额阈值滤掉零头。

const READ_LIMIT = 2000
const DAY_MS = 86_400_000

export interface SettlementDiffRow {
  settlementId: string
  externalSettlementId: string
  sellerAccountId: string
  rangeStart: Date
  rangeEnd: Date
  currency: string
  officialAmount: { toString(): string }
  systemAmount: { toString(): string }
  diffAmount: { toString(): string }
  openExceptions: number
}

const num = (value: { toString(): string }) => Number(value.toString())
const money = (value: number) => Math.round(value * 100) / 100
const day = (value: Date) => value.toISOString().slice(0, 10)

/** 差额绝对值不小于阈值的才算，大的排前面（纯函数）。 */
export function buildSettlementHits(rows: readonly SettlementDiffRow[], storeNames: ReadonlyMap<string, string>, minDiffAmount: number): AlertHit[] {
  return rows
    .map(row => ({ row, abs: Math.abs(num(row.diffAmount)) }))
    .filter(item => item.abs >= minDiffAmount && item.abs > 0)
    .sort((a, b) => b.abs - a.abs)
    .map(({ row, abs }): AlertHit => {
      const store = storeNames.get(row.sellerAccountId) ?? '店铺'
      return {
        entityType: 'SETTLEMENT',
        entityId: row.settlementId,
        sellerAccountId: row.sellerAccountId,
        entityLabel: `结算单 ${row.externalSettlementId}（${store}）`,
        title: `结算单 ${row.externalSettlementId} 核对有差异：差额 ${row.currency} ${money(num(row.diffAmount))}`,
        suggestedAction: '到结算交易页查看三方核对与异常明细，按归因（报告、接口或订单）逐条处理；确认是亚马逊侧问题时可联系卖家支持',
        evidence: {
          settlementId: row.externalSettlementId,
          storeName: store,
          period: `${day(row.rangeStart)} 至 ${day(row.rangeEnd)}`,
          currency: row.currency,
          officialAmount: money(num(row.officialAmount)),
          systemAmount: money(num(row.systemAmount)),
          diffAmount: money(num(row.diffAmount)),
          openExceptions: row.openExceptions,
        },
        impact: { min: money(abs), max: money(abs), currency: row.currency },
      }
    })
}

export const settlementDiscrepancyEvaluator: AlertEvaluator = {
  type: 'settlement.discrepancy',
  async evaluate({ db, tenantId, rule, now }) {
    const lookbackDays = numberParam(rule, 'lookbackDays', 90, { min: 1, max: 365 })
    const minDiffAmount = numberParam(rule, 'minDiffAmount', 1, { min: 0.01, max: 1_000_000 })
    const scope = scopeFilter(rule)
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const recon = await db.reconciliation.findMany({
      where: {
        tenantId,
        scopeKind: 'SETTLEMENT',
        status: 'DISCREPANCY',
        settlementId: { not: null },
        rangeEnd: { gte: new Date(today - lookbackDays * DAY_MS) },
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
      },
      select: {
        id: true,
        settlementId: true,
        sellerAccountId: true,
        rangeStart: true,
        rangeEnd: true,
        currency: true,
        officialAmount: true,
        systemAmount: true,
        diffAmount: true,
        settlement: { select: { externalSettlementId: true } },
      },
      orderBy: { rangeEnd: 'desc' },
      take: READ_LIMIT,
    })
    if (recon.length === 0) return []
    const [open, stores] = await Promise.all([
      db.reconciliationException.groupBy({
        by: ['reconciliationId'],
        where: { tenantId, reconciliationId: { in: recon.map(row => row.id) }, status: 'OPEN' },
        _count: { _all: true },
      }),
      db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(recon.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 }),
    ])
    const openOf = new Map(open.map(row => [row.reconciliationId, row._count._all]))
    const rows = recon.flatMap((row): SettlementDiffRow[] =>
      row.settlementId
        ? [
            {
              settlementId: row.settlementId,
              externalSettlementId: row.settlement?.externalSettlementId ?? row.settlementId,
              sellerAccountId: row.sellerAccountId,
              rangeStart: row.rangeStart,
              rangeEnd: row.rangeEnd,
              currency: row.currency,
              officialAmount: row.officialAmount,
              systemAmount: row.systemAmount,
              diffAmount: row.diffAmount,
              openExceptions: openOf.get(row.id) ?? 0,
            },
          ]
        : [],
    )
    return buildSettlementHits(rows, new Map(stores.map(store => [store.id, store.displayName])), minDiffAmount)
  },
}
