import { FEE_AUDIT_KINDS, FEE_AUDIT_KIND_LABEL, type FeeAuditKind } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { choiceListParam, numberParam, scopeFilter } from './params'

// 费用多收预警评估器（P2b-16，09 章 9.1 财务类）：费用核查（P2b-06）每个店铺最新一次核查里，疑似多收（status = SUSPECTED）的行
// 按“店铺 × 费用类别 × 币种”合计，合计金额达到阈值才提醒。已转为赔付机会的行状态变成已转机会（APPEALED），不再算数；
// 下一次核查不再产出的行会被核查任务删掉，预警随之恢复。多收金额的容差与口径是核查页自定的（见 FEE_AUDIT_TOLERANCE），可能有误报。

const READ_LIMIT = 20_000
const TOP_SUBJECTS = 5

export interface OverchargeRow {
  sellerAccountId: string
  feeKind: string
  subjectKey: string
  sku: string | null
  currency: string
  overchargeAmount: { toString(): string }
  snapshotDate: Date
}

const num = (value: { toString(): string }) => Number(value.toString())
const money = (value: number) => Math.round(value * 100) / 100
const kindLabel = (kind: string) => FEE_AUDIT_KIND_LABEL[kind as FeeAuditKind] ?? kind

/** 按店铺 × 费用类别 × 币种合计，合计不小于阈值的才算，金额大的排前面（纯函数）。 */
export function buildOverchargeHits(rows: readonly OverchargeRow[], storeNames: ReadonlyMap<string, string>, minAmount: number): AlertHit[] {
  const groups = new Map<string, OverchargeRow[]>()
  for (const row of rows) {
    if (num(row.overchargeAmount) <= 0) continue
    const key = `${row.sellerAccountId}|${row.feeKind}|${row.currency}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, group, total: money(group.reduce((sum, row) => sum + num(row.overchargeAmount), 0)) }))
    .filter(item => item.total >= minAmount && item.total > 0)
    .sort((a, b) => b.total - a.total)
    .map(({ key, group, total }): AlertHit => {
      const first = group[0]
      const store = storeNames.get(first.sellerAccountId) ?? '店铺'
      const top = [...group].sort((a, b) => num(b.overchargeAmount) - num(a.overchargeAmount)).slice(0, TOP_SUBJECTS)
      return {
        entityType: 'FEE_AUDIT',
        entityId: key,
        sellerAccountId: first.sellerAccountId,
        entityLabel: `${kindLabel(first.feeKind)}（${store}）`,
        title: `${store} ${kindLabel(first.feeKind)}疑似多收 ${first.currency} ${total}（${group.length} 项）`,
        suggestedAction: '到费用核查页核对依据；确认确实多收后点“转为赔付机会”，在等待期与申请期限内向亚马逊申请赔付',
        evidence: {
          storeName: store,
          feeKind: first.feeKind,
          feeKindLabel: kindLabel(first.feeKind),
          currency: first.currency,
          overchargeTotal: total,
          itemCount: group.length,
          checkedOn: first.snapshotDate.toISOString().slice(0, 10),
          top: top.map(row => ({ subject: row.sku ?? row.subjectKey, amount: money(num(row.overchargeAmount)) })),
        },
        impact: { min: total, max: total, currency: first.currency },
      }
    })
}

export const feeOverchargeEvaluator: AlertEvaluator = {
  type: 'fee.overcharge',
  async evaluate({ db, tenantId, rule }) {
    const minAmount = numberParam(rule, 'minOverchargeAmount', 5, { min: 0.01, max: 1_000_000 })
    const kinds = choiceListParam(rule, 'kinds', FEE_AUDIT_KINDS, FEE_AUDIT_KINDS)
    const scope = scopeFilter(rule)
    const storeWhere = scope.stores ? { sellerAccountId: { in: scope.stores } } : {}
    // 每个店铺只看最新一次核查日（与费用核查页一致）
    const latest = await db.feeAudit.groupBy({ by: ['sellerAccountId'], where: { tenantId, ...storeWhere }, _max: { snapshotDate: true } })
    const dated = latest.flatMap(row => (row._max.snapshotDate ? [{ sellerAccountId: row.sellerAccountId, snapshotDate: row._max.snapshotDate }] : []))
    if (dated.length === 0) return []
    const rows = await db.feeAudit.findMany({
      where: {
        tenantId,
        status: 'SUSPECTED',
        feeKind: { in: kinds },
        // 入仓配置费按货件核查、没有 SKU：不受 SKU 范围限制
        AND: [{ OR: dated }, ...(scope.skus ? [{ OR: [{ sku: { in: scope.skus } }, { sku: null }] }] : [])],
      },
      select: { sellerAccountId: true, feeKind: true, subjectKey: true, sku: true, currency: true, overchargeAmount: true, snapshotDate: true },
      orderBy: { overchargeAmount: 'desc' },
      take: READ_LIMIT,
    })
    if (rows.length === 0) return []
    const stores = await db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(rows.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 })
    return buildOverchargeHits(rows, new Map(stores.map(store => [store.id, store.displayName])), minAmount)
  },
}
