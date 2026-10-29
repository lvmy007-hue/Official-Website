import type { OpportunityEvidence } from '@nova/api-contracts'
import { paidQuantity } from './opportunity-write.js'
import { SCAN_LIMIT, commitRule, shiftDay, type DraftInput, type ScanContext, type ScanResult } from './scan.js'

// 第 7 类：移除订单丢失（07 章 7.3）。移除订单已经完结（状态为完成 / 取消类，且没有处理中的数量），
// 申请数量 − 已发货 − 已弃置 − 已取消 仍为正，说明有货在移除途中去向不明；扣掉官方赔付明细里原因吻合的已赔付数量后，剩下的是机会。
// “已完结”靠状态文字判断（完成、取消、关闭），是我们对移除订单报告的推断，所以机会证据里写明了申请与各去向的数量，供人核对。

const CLOSED = /complet|cancel|clos/i

export async function detectRemovalLost(ctx: ScanContext): Promise<ScanResult> {
  const { db, tenantId, now, windows } = ctx
  const { waitDays, windowDays } = windows.REMOVAL_LOST
  const rows = await db.removalOrder.findMany({
    where: { tenantId, inProcessQty: 0, requestDate: { gte: shiftDay(now, -windowDays), lt: shiftDay(now, 1 - waitDays) } },
    select: {
      id: true,
      sellerAccountId: true,
      orderId: true,
      sku: true,
      fnsku: true,
      disposition: true,
      status: true,
      requestDate: true,
      lastUpdatedDate: true,
      requestedQty: true,
      shippedQty: true,
      disposedQty: true,
      cancelledQty: true,
    },
    orderBy: { requestDate: 'asc' },
    take: SCAN_LIMIT + 1,
  })
  const truncated = rows.length > SCAN_LIMIT
  const drafts: DraftInput[] = []
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    if (!CLOSED.test(row.status)) continue
    const missing = row.requestedQty - row.shippedQty - row.disposedQty - row.cancelledQty
    if (missing <= 0) continue
    const anchor = row.lastUpdatedDate ?? row.requestDate
    const paid = await paidQuantity(ctx.db, tenantId, row.sellerAccountId, row.sku, 'REMOVAL_LOST', anchor, ctx.paidCache)
    const left = missing - paid
    if (left <= 0) continue
    const evidence: OpportunityEvidence[] = [
      { kind: 'REMOVAL', id: row.id, label: `移除订单 ${row.orderId}：申请 ${row.requestedQty}，发出 ${row.shippedQty}，弃置 ${row.disposedQty}，取消 ${row.cancelledQty}` },
      { kind: 'SKU', id: row.sku, label: row.sku },
    ]
    drafts.push({ sellerAccountId: row.sellerAccountId, ruleCode: 'REMOVAL_LOST', dedupKey: `${row.orderId}:${row.sku}:${row.fnsku}:${row.disposition}`, sku: row.sku, qty: left, anchor, evidence })
  }
  return commitRule(ctx, 'REMOVAL_LOST', drafts, truncated)
}
