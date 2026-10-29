import { OPPORTUNITY_RULE_LABEL, type OpportunityRule } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, scopeFilter } from './params'

// 赔付机会到期预警评估器（P2b-16，09 章 9.1 财务类）：赔付中心里仍是“待处理”（没有生成案件、没有忽略、没有已解决）的机会，
// 距申请期限不超过预警天数。申请期限是企业设置的默认窗口推算出来的（reimbursement-windows），不是亚马逊逐案给出的。
// 过了期限的机会由赔付扫描标为已过期（EXPIRED），不再是“待处理”，预警随之自动恢复；已经过期的不在这里提醒（来不及了，页面上有“已过期”页签）。

const READ_LIMIT = 2000
const DAY_MS = 86_400_000

export interface DeadlineRow {
  id: string
  sellerAccountId: string
  ruleCode: string
  sku: string | null
  qty: number | null
  deadlineAt: Date
  estimatedAmount: { toString(): string } | null
  currency: string | null
}

const ruleLabel = (code: string) => OPPORTUNITY_RULE_LABEL[code as OpportunityRule] ?? code

/** 距期限最近的排前面；剩余天数按 UTC 日历日算（纯函数）。 */
export function buildDeadlineHits(rows: readonly DeadlineRow[], storeNames: ReadonlyMap<string, string>, now: Date): AlertHit[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return [...rows]
    .sort((a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime())
    .map((row): AlertHit => {
      const daysLeft = Math.round((row.deadlineAt.getTime() - today) / DAY_MS)
      const store = storeNames.get(row.sellerAccountId) ?? '店铺'
      const label = `${ruleLabel(row.ruleCode)}${row.sku ? ` ${row.sku}` : ''}`
      const amount = row.estimatedAmount === null ? null : Number(row.estimatedAmount.toString())
      return {
        entityType: 'REIMBURSEMENT_OPPORTUNITY',
        entityId: row.id,
        sellerAccountId: row.sellerAccountId,
        entityLabel: `${label}（${store}）`,
        title: daysLeft <= 0 ? `赔付机会“${label}”今天到期` : `赔付机会“${label}”还剩 ${daysLeft} 天到期`,
        suggestedAction: '到赔付中心生成案件并在卖家后台提交，再把亚马逊案件编号回填；确认不需要申请的可以忽略并写明原因',
        evidence: {
          storeName: store,
          ruleCode: row.ruleCode,
          ruleLabel: ruleLabel(row.ruleCode),
          sku: row.sku,
          qty: row.qty,
          deadline: row.deadlineAt.toISOString().slice(0, 10),
          daysLeft,
          estimatedAmount: amount === null ? null : Math.round(amount * 100) / 100,
          currency: row.currency,
        },
        // 没有商品成本等依据时估算金额为空：不写影响金额，更不写 0
        ...(amount !== null && Number.isFinite(amount) && row.currency ? { impact: { min: Math.round(amount * 100) / 100, max: Math.round(amount * 100) / 100, currency: row.currency } } : {}),
      }
    })
}

export const reimbursementDeadlineEvaluator: AlertEvaluator = {
  type: 'reimbursement.deadline',
  async evaluate({ db, tenantId, rule, now }) {
    const warnDays = numberParam(rule, 'warnDays', 30, { min: 1, max: 365 })
    const scope = scopeFilter(rule)
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const rows = await db.reimbursementOpportunity.findMany({
      where: {
        tenantId,
        status: 'PENDING',
        deadlineAt: { gte: new Date(today), lte: new Date(today + warnDays * DAY_MS) },
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
        ...(scope.skus ? { sku: { in: scope.skus } } : {}),
      },
      select: { id: true, sellerAccountId: true, ruleCode: true, sku: true, qty: true, deadlineAt: true, estimatedAmount: true, currency: true },
      orderBy: { deadlineAt: 'asc' },
      take: READ_LIMIT,
    })
    const dated = rows.flatMap((row): DeadlineRow[] => (row.deadlineAt ? [{ ...row, deadlineAt: row.deadlineAt }] : []))
    if (dated.length === 0) return []
    const stores = await db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(dated.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 })
    return buildDeadlineHits(dated, new Map(stores.map(store => [store.id, store.displayName])), now)
  },
}
