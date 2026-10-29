import { isRefundTransaction, type OpportunityEvidence } from '@nova/api-contracts'
import { SCAN_LIMIT, commitRule, shiftDay, type DraftInput, type ScanContext, type ScanResult } from './scan.js'

// 第 4 类：退款后未收到退货；第 5 类：退货处置为承运商损坏 / 仓库损坏（07 章 7.3）。

const CHUNK = 500
const chunks = <T>(list: readonly T[]): T[][] => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, index) => list.slice(index * CHUNK, (index + 1) * CHUNK))

/** 第 5 类：退货处置是承运商损坏或仓库损坏（亚马逊责任），而且官方赔付明细里没有这个订单、这个 SKU 的赔付。 */
export async function detectReturnDisposition(ctx: ScanContext): Promise<ScanResult> {
  const { db, tenantId, now, windows } = ctx
  const { waitDays, windowDays } = windows.RETURN_DISPOSITION
  const rows = await db.fbaReturnCase.findMany({
    where: { tenantId, disposition: { in: ['CARRIER_DAMAGED', 'WAREHOUSE_DAMAGED'] }, returnDate: { gte: shiftDay(now, -windowDays), lt: shiftDay(now, 1 - waitDays) } },
    select: { id: true, sellerAccountId: true, amazonOrderId: true, sellerSku: true, quantity: true, returnDate: true, disposition: true, detailedDisposition: true },
    orderBy: { returnDate: 'asc' },
    take: SCAN_LIMIT + 1,
  })
  const truncated = rows.length > SCAN_LIMIT
  const kept = rows.slice(0, SCAN_LIMIT)
  const paid = await paidOrders(
    ctx,
    kept.map(row => row.amazonOrderId),
  )
  const drafts: DraftInput[] = []
  for (const row of kept) {
    if (paid.has(`${row.sellerAccountId}|${row.amazonOrderId}|${row.sellerSku}`)) continue
    const evidence: OpportunityEvidence[] = [
      { kind: 'RETURN', id: row.id, label: `退货 ${row.amazonOrderId} · ${row.detailedDisposition ?? row.disposition ?? ''}`.trim() },
      { kind: 'ORDER', id: row.amazonOrderId, label: `订单 ${row.amazonOrderId}` },
      { kind: 'SKU', id: row.sellerSku, label: row.sellerSku },
    ]
    drafts.push({ sellerAccountId: row.sellerAccountId, ruleCode: 'RETURN_DISPOSITION', dedupKey: row.id, sku: row.sellerSku, qty: row.quantity, anchor: row.returnDate, evidence })
  }
  return commitRule(ctx, 'RETURN_DISPOSITION', drafts, truncated)
}

/** 官方赔付明细里已经有的“订单 + SKU”（店铺内）。 */
async function paidOrders(ctx: ScanContext, orderIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const part of chunks([...new Set(orderIds)])) {
    const rows = await ctx.db.reimbursementRecord.findMany({
      where: { tenantId: ctx.tenantId, originalOrderId: { in: part }, amount: { gt: 0 } },
      select: { sellerAccountId: true, originalOrderId: true, sku: true },
      take: 5000,
    })
    for (const row of rows) if (row.originalOrderId) out.add(`${row.sellerAccountId}|${row.originalOrderId}|${row.sku}`)
  }
  return out
}

/**
 * 第 4 类：订单有退款入账，第一笔退款已过等待期，而这个订单在客户退货报告里没有任何退货记录，官方赔付明细里也没有这个订单。
 * 退款不等于一定要退货（部分退款可以保留商品），所以这是“待核实的机会”：每个订单的每个订单行一条，数量取订单数量（保守取已发货数量）。
 */
export async function detectRefundNoReturn(ctx: ScanContext): Promise<ScanResult> {
  const { db, tenantId, now, windows } = ctx
  const { waitDays, windowDays } = windows.REFUND_NO_RETURN
  const refunds = await db.fbaFinancialTransaction.findMany({
    where: {
      tenantId,
      transactionType: { contains: 'refund', mode: 'insensitive' },
      amazonOrderId: { not: null },
      amount: { not: 0 },
      postedAt: { gte: shiftDay(now, -windowDays), lt: shiftDay(now, 1 - waitDays) },
    },
    select: { sellerAccountId: true, amazonOrderId: true, transactionType: true, postedAt: true },
    orderBy: { postedAt: 'asc' },
    take: SCAN_LIMIT + 1,
  })
  const truncated = refunds.length > SCAN_LIMIT
  const first = new Map<string, { sellerAccountId: string; amazonOrderId: string; at: Date }>()
  for (const refund of refunds.slice(0, SCAN_LIMIT)) {
    if (!refund.amazonOrderId || !isRefundTransaction(refund.transactionType)) continue
    const key = `${refund.sellerAccountId}|${refund.amazonOrderId}`
    if (!first.has(key)) first.set(key, { sellerAccountId: refund.sellerAccountId, amazonOrderId: refund.amazonOrderId, at: refund.postedAt })
  }
  const orders = [...new Set([...first.values()].map(item => item.amazonOrderId))]
  const returned = new Set<string>()
  const lines = new Map<string, Array<{ sku: string | null; qty: number }>>()
  const paidOrderKeys = new Set<string>()
  for (const part of chunks(orders)) {
    const [returnRows, itemRows, paidRows] = await Promise.all([
      db.fbaReturnCase.findMany({
        where: { tenantId, amazonOrderId: { in: part } },
        select: { sellerAccountId: true, amazonOrderId: true },
        distinct: ['sellerAccountId', 'amazonOrderId'],
        take: 5000,
      }),
      db.orderItem.findMany({
        where: { tenantId, amazonOrderId: { in: part } },
        select: { sellerAccountId: true, amazonOrderId: true, sellerSku: true, quantityOrdered: true, quantityShipped: true },
        take: 10_000,
      }),
      db.reimbursementRecord.findMany({ where: { tenantId, originalOrderId: { in: part }, amount: { gt: 0 } }, select: { sellerAccountId: true, originalOrderId: true }, take: 5000 }),
    ])
    for (const row of returnRows) returned.add(`${row.sellerAccountId}|${row.amazonOrderId}`)
    for (const row of paidRows) if (row.originalOrderId) paidOrderKeys.add(`${row.sellerAccountId}|${row.originalOrderId}`)
    for (const row of itemRows) {
      const key = `${row.sellerAccountId}|${row.amazonOrderId}`
      lines.set(key, [...(lines.get(key) ?? []), { sku: row.sellerSku, qty: row.quantityShipped > 0 ? row.quantityShipped : row.quantityOrdered }])
    }
  }
  const drafts: DraftInput[] = []
  for (const [key, refund] of first) {
    if (returned.has(key) || paidOrderKeys.has(key)) continue
    const items = lines.get(key) ?? [{ sku: null, qty: 0 }]
    for (const item of items) {
      const evidence: OpportunityEvidence[] = [
        { kind: 'ORDER', id: refund.amazonOrderId, label: `订单 ${refund.amazonOrderId}（${refund.at.toISOString().slice(0, 10)} 起有退款）` },
        ...(item.sku ? [{ kind: 'SKU' as const, id: item.sku, label: item.sku }] : []),
      ]
      drafts.push({
        sellerAccountId: refund.sellerAccountId,
        ruleCode: 'REFUND_NO_RETURN',
        dedupKey: `${refund.amazonOrderId}:${item.sku ?? ''}`,
        sku: item.sku,
        qty: item.qty > 0 ? item.qty : null,
        anchor: refund.at,
        evidence,
      })
    }
  }
  return commitRule(ctx, 'REFUND_NO_RETURN', drafts, truncated)
}
