import { chargesSummary, classifyFinanceLine, isRefundTransaction, lineBelongsTo, netIncomeOf, orderRisks, refundOf, settlementView } from '@nova/api-contracts'
import type { LineFact, OrderRefundState, OrderRisk, OrderSettlementState, TxFact } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'

// 订单的“事实”装配（P2b-01）：一页订单一次取齐财务交易、费用明细、退货、替换订单、取消、订单自己的收入明细，
// 再由纯函数（api-contracts 的 orders-math）得出退款、结算、风险、净收益。列表与详情共用同一套，口径不会各算各的。
// 财务表按订单号查，已有 (tenantId, amazonOrderId) 索引；再用“不早于该页最早下单时间”的入账时间范围裁掉更早的分区。

/** 一次最多装配多少行财务数据（平台硬限制 20000，一页订单远用不到）。 */
export const FACT_TAKE = 20_000
const DAY_MS = 86_400_000

export type FactRow = {
  id: string
  sellerAccountId: string
  amazonOrderId: string
  purchaseDate: Date
  status: string
  amount: number | null
  isReplacement: boolean
  replacedOrderId: string | null
  replacementReason: string | null
}

export type TxRow = TxFact & { sellerAccountId: string; amazonOrderId: string; currency: string; postedAt: Date }
export type LineRow = LineFact & { sellerAccountId: string; amazonOrderId: string; postedAt: Date }
type ReturnRow = { sellerAccountId: string; amazonOrderId: string; quantity: number; reason: string | null }
type ChargeRow = { orderId: string; chargeKind: string; amount: number }
type CancelRow = { orderId: string; cancelledBy: string; reasonCode: string; cancelledAt: Date | null }

export type OrderFacts = {
  transactions: TxRow[]
  lines: LineRow[]
  returns: ReturnRow[]
  replacedBy: Array<{ sellerAccountId: string; replacedOrderId: string; amazonOrderId: string }>
  charges: ChargeRow[]
  cancellations: CancelRow[]
}

const num = (value: { toString(): string } | number | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
export const keyOf = (sellerAccountId: string, amazonOrderId: string) => `${sellerAccountId}|${amazonOrderId}`

export async function loadOrderFacts(prisma: PrismaService, tenantId: string, rows: readonly FactRow[]): Promise<OrderFacts> {
  if (rows.length === 0) return { transactions: [], lines: [], returns: [], replacedBy: [], charges: [], cancellations: [] }
  const orderIds = rows.map(row => row.amazonOrderId)
  const stores = [...new Set(rows.map(row => row.sellerAccountId))]
  const earliest = new Date(Math.min(...rows.map(row => row.purchaseDate.getTime())) - DAY_MS)
  const posted = { gte: earliest }
  const [transactions, lines, returns, replacedBy, charges, cancellations] = await Promise.all([
    prisma.fbaFinancialTransaction.findMany({
      where: { tenantId, sellerAccountId: { in: stores }, amazonOrderId: { in: orderIds }, postedAt: posted },
      select: { sellerAccountId: true, amazonOrderId: true, externalTransactionId: true, transactionType: true, transactionStatus: true, amount: true, currency: true, postedAt: true },
      orderBy: { postedAt: 'asc' },
      take: FACT_TAKE,
    }),
    prisma.fbaFeeEvent.findMany({
      where: { tenantId, sellerAccountId: { in: stores }, amazonOrderId: { in: orderIds }, postedAt: posted },
      select: { sellerAccountId: true, amazonOrderId: true, sourceEventId: true, description: true, eventType: true, amount: true, postedAt: true },
      orderBy: { postedAt: 'asc' },
      take: FACT_TAKE,
    }),
    prisma.fbaReturnCase.findMany({
      where: { tenantId, sellerAccountId: { in: stores }, amazonOrderId: { in: orderIds } },
      select: { sellerAccountId: true, amazonOrderId: true, quantity: true, reason: true },
      take: FACT_TAKE,
    }),
    prisma.order.findMany({
      where: { tenantId, sellerAccountId: { in: stores }, replacedOrderId: { in: orderIds }, purchaseDate: { gte: earliest } },
      select: { sellerAccountId: true, replacedOrderId: true, amazonOrderId: true },
      take: 5000,
    }),
    prisma.orderCharge.findMany({
      where: { tenantId, orderId: { in: rows.map(row => row.id) }, purchaseDate: { gte: earliest } },
      select: { orderId: true, chargeKind: true, amount: true },
      take: FACT_TAKE,
    }),
    prisma.orderCancellation.findMany({
      where: { tenantId, orderId: { in: rows.map(row => row.id) }, orderPurchaseDate: { gte: earliest } },
      select: { orderId: true, cancelledBy: true, reasonCode: true, cancelledAt: true },
      take: 5000,
    }),
  ])
  return {
    transactions: transactions.map(tx => ({
      sellerAccountId: tx.sellerAccountId,
      amazonOrderId: tx.amazonOrderId ?? '',
      externalTransactionId: tx.externalTransactionId,
      transactionType: tx.transactionType,
      transactionStatus: tx.transactionStatus,
      amount: num(tx.amount) ?? 0,
      currency: tx.currency,
      postedAt: tx.postedAt,
    })),
    lines: lines.map(line => ({
      sellerAccountId: line.sellerAccountId,
      amazonOrderId: line.amazonOrderId ?? '',
      sourceEventId: line.sourceEventId,
      path: line.description || line.eventType,
      amount: num(line.amount) ?? 0,
      postedAt: line.postedAt,
    })),
    returns,
    replacedBy: replacedBy.flatMap(order => (order.replacedOrderId ? [{ sellerAccountId: order.sellerAccountId, replacedOrderId: order.replacedOrderId, amazonOrderId: order.amazonOrderId }] : [])),
    charges: charges.map(charge => ({ orderId: charge.orderId, chargeKind: charge.chargeKind, amount: num(charge.amount) ?? 0 })),
    cancellations,
  }
}

export type OrderSummary = {
  refund: { state: OrderRefundState; amount: number | null }
  settlement: { state: OrderSettlementState; label: string }
  returnCount: number
  risks: OrderRisk[]
  netIncome: ReturnType<typeof netIncomeOf>
  currency: string
}

/** 一个订单的汇总：只用这个订单自己的那部分事实。 */
export function summarizeOrder(row: FactRow, facts: OrderFacts): OrderSummary {
  const own = <T extends { sellerAccountId: string; amazonOrderId: string }>(items: readonly T[]) =>
    items.filter(item => item.sellerAccountId === row.sellerAccountId && item.amazonOrderId === row.amazonOrderId)
  const transactions = own(facts.transactions)
  const lines = own(facts.lines)
  const returns = own(facts.returns)
  const refund = refundOf(transactions, lines, row.amount)
  const refundIds = transactions.filter(tx => isRefundTransaction(tx.transactionType)).map(tx => tx.externalTransactionId)
  const saleLines = lines.filter(line => !refundIds.some(id => lineBelongsTo(line, id)))
  const charges = facts.charges.filter(charge => charge.orderId === row.id)
  const cancellation = facts.cancellations.find(item => item.orderId === row.id) ?? null
  const orderTax = charges.filter(charge => charge.chargeKind === 'TAX').reduce((total, charge) => total + charge.amount, 0)
  const financeTax = saleLines.length > 0 ? saleLines.filter(line => classifyFinanceLine(line.path) === 'TAX').reduce((total, line) => total + line.amount, 0) : null
  const risks = orderRisks({
    status: row.status,
    amount: row.amount,
    chargesTotal: charges.length > 0 ? chargesSummary(charges).total : null,
    orderTax,
    financeTax,
    cancellation: cancellation ? { cancelledBy: cancellation.cancelledBy, reasonCode: cancellation.reasonCode, cancelledAt: cancellation.cancelledAt } : null,
    refund,
    returns,
    isReplacement: row.isReplacement,
    replacedOrderId: row.replacedOrderId,
    replacementReason: row.replacementReason,
    replacedBy: facts.replacedBy.filter(item => item.sellerAccountId === row.sellerAccountId && item.replacedOrderId === row.amazonOrderId).map(item => item.amazonOrderId),
    positiveTransactionTotal: transactions.filter(tx => !isRefundTransaction(tx.transactionType) && tx.amount > 0).reduce((total, tx) => total + tx.amount, 0),
  })
  return {
    refund,
    settlement: settlementView(transactions.map(tx => tx.transactionStatus)),
    returnCount: returns.length,
    risks,
    netIncome: netIncomeOf(transactions),
    currency: transactions[0]?.currency ?? 'USD',
  }
}
