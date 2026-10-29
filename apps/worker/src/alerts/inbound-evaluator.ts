import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { choiceListParam, scopeFilter } from './params'

// 入仓差异预警评估器（P2a-15）：已关闭货件存在未消除的少收、多收或不合规问题（数据来自 P2a-13 的 ReceivingDiscrepancy，差异消除后写 resolvedAt，预警随之自动恢复）。
// 命中对象是货件（点进去是货件接收与差异页）；同一货件多个 SKU 合并成一个命中。

const KINDS = ['SHORT', 'OVER', 'NONCOMPLIANCE'] as const
const READ_LIMIT = 20_000

export interface DiscrepancyRow {
  sellerAccountId: string
  shipmentRef: string
  sku: string
  kind: string
  qty: number | null
  problemType: string | null
  firstSeenAt: Date
}

export function buildDiscrepancyHits(rows: readonly DiscrepancyRow[], storeNames: ReadonlyMap<string, string>): AlertHit[] {
  const shipments = new Map<string, DiscrepancyRow[]>()
  for (const row of rows) {
    const key = `${row.sellerAccountId}|${row.shipmentRef}`
    shipments.set(key, [...(shipments.get(key) ?? []), row])
  }
  const hits = [...shipments.values()].map(group => {
    const first = group[0]
    const units = (kind: string) => group.filter(row => row.kind === kind).reduce((sum, row) => sum + (row.qty ?? 0), 0)
    const short = units('SHORT')
    const over = units('OVER')
    const problems = [...new Set(group.filter(row => row.kind === 'NONCOMPLIANCE').map(row => row.problemType ?? '未注明类型'))]
    const parts = [short > 0 ? `少收 ${short} 件` : null, over > 0 ? `多收 ${over} 件` : null, problems.length > 0 ? `不合规 ${problems.length} 类` : null].filter(
      (part): part is string => part !== null,
    )
    const skus = [...new Set(group.map(row => row.sku))]
    return {
      earliest: Math.min(...group.map(row => row.firstSeenAt.getTime())),
      hit: {
        entityType: 'INBOUND_SHIPMENT',
        entityId: first.shipmentRef,
        sellerAccountId: first.sellerAccountId,
        entityLabel: `${first.shipmentRef}（${storeNames.get(first.sellerAccountId) ?? '店铺'}）`,
        title: `货件 ${first.shipmentRef} 入仓差异：${parts.join('，') || '有未消除的差异'}`,
        suggestedAction: short > 0 ? '核对箱单与接收记录，上传证据并在等待期满后申请赔付；不合规问题请按亚马逊要求整改' : '请核对接收差异与不合规问题并处理',
        evidence: {
          shipmentRef: first.shipmentRef,
          storeName: storeNames.get(first.sellerAccountId) ?? null,
          shortUnits: short,
          overUnits: over,
          noncomplianceTypes: problems,
          skuCount: skus.length,
          skus: skus.slice(0, 20),
          firstSeenAt: new Date(Math.min(...group.map(row => row.firstSeenAt.getTime()))).toISOString(),
        },
      } satisfies AlertHit,
    }
  })
  // 最早发现的排前面（等待时间最长，离赔付申请期限最近）
  return hits.sort((a, b) => a.earliest - b.earliest).map(item => item.hit)
}

export const inboundDiscrepancyEvaluator: AlertEvaluator = {
  type: 'inbound.discrepancy',
  async evaluate({ db, tenantId, rule }) {
    const kinds = choiceListParam(rule, 'kinds', KINDS, KINDS)
    const scope = scopeFilter(rule)
    const rows = await db.receivingDiscrepancy.findMany({
      where: { tenantId, resolvedAt: null, kind: { in: kinds }, ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}), ...(scope.skus ? { sku: { in: scope.skus } } : {}) },
      select: { sellerAccountId: true, shipmentRef: true, sku: true, kind: true, qty: true, problemType: true, firstSeenAt: true },
      orderBy: { firstSeenAt: 'asc' },
      take: READ_LIMIT,
    })
    if (rows.length === 0) return []
    const stores = await db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(rows.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 })
    return buildDiscrepancyHits(rows, new Map(stores.map(store => [store.id, store.displayName])))
  },
}
