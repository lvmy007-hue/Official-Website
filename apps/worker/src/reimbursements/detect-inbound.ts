import type { OpportunityEvidence } from '@nova/api-contracts'
import { paidQuantity } from './opportunity-write.js'
import { SCAN_LIMIT, commitRule, type DraftInput, type ScanContext, type ScanResult } from './scan.js'

// 第 1 类：入仓差异（P2a-13 已在入仓同步时产出）。这里按“还没消除的少收”定时重新评估：
// ① 关闭货件当时还在等待期，同步不会再碰它，过了等待期要靠这里转为待处理；② 设置里的时限改了，按新时限重算；
// ③ 官方赔付明细里已经有同店铺同 SKU、原因吻合、批准日在货件关闭之后的赔付，数量够了就不再是机会（待处理的转为“差异已消除”）。

const CHUNK = 500

export async function detectInbound(ctx: ScanContext): Promise<ScanResult> {
  const { db, tenantId } = ctx
  const shorts = await db.receivingDiscrepancy.findMany({
    where: { tenantId, kind: 'SHORT', source: 'RECEIPT', resolvedAt: null, planId: { not: null } },
    select: { sellerAccountId: true, planId: true, shipmentRef: true, sku: true, qty: true },
    take: SCAN_LIMIT + 1,
  })
  const truncated = shorts.length > SCAN_LIMIT
  const kept = shorts.slice(0, SCAN_LIMIT)
  const refs = [...new Set(kept.map(row => row.shipmentRef))]
  const shipments = new Map<string, { id: string; closedAt: Date | null }>()
  for (let at = 0; at < refs.length; at += CHUNK) {
    const rows = await db.fbaInboundShipment.findMany({
      where: { shipmentId: { in: refs.slice(at, at + CHUNK) }, plan: { tenantId } },
      select: { id: true, planId: true, shipmentId: true, receivedDoneAt: true },
      take: 5000,
    })
    for (const row of rows) shipments.set(`${row.planId}|${row.shipmentId}`, { id: row.id, closedAt: row.receivedDoneAt })
  }
  const drafts: DraftInput[] = []
  for (const row of kept) {
    const shipment = shipments.get(`${row.planId}|${row.shipmentRef}`)
    if (!shipment?.closedAt || !row.qty || row.qty <= 0) continue
    const paid = await paidQuantity(db, tenantId, row.sellerAccountId, row.sku, 'INBOUND_DISCREPANCY', shipment.closedAt, ctx.paidCache)
    if (paid >= row.qty) continue
    const evidence: OpportunityEvidence[] = [
      { kind: 'SHIPMENT', id: shipment.id, label: `货件 ${row.shipmentRef}` },
      { kind: 'SKU', id: row.sku, label: row.sku },
    ]
    drafts.push({
      sellerAccountId: row.sellerAccountId,
      ruleCode: 'INBOUND_DISCREPANCY',
      dedupKey: `${row.shipmentRef}:${row.sku}`,
      sku: row.sku,
      qty: row.qty - paid,
      anchor: shipment.closedAt,
      evidence,
    })
  }
  return commitRule(ctx, 'INBOUND_DISCREPANCY', drafts, truncated)
}
