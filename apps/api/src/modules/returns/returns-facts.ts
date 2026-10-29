import { isRefundTransaction, type OrderRefundState, type ReturnRefundView } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { keyOf, loadOrderFacts, summarizeOrder, type FactRow, type OrderFacts } from '../orders'

// 退货行的订单与财务事实装配（P2b-02）：一页退货一次取齐订单头与财务交易，退款口径与订单页共用同一套（orders 模块的 loadOrderFacts / summarizeOrder）。
// 订单还没同步下来时用“退货时间前 180 天”做财务交易的回看起点（退款可能早于收到退货），金额没法与订单金额比较，退款只会是“部分/待财务交易/无退款”。

const DAY_MS = 86_400_000
/** 订单没有同步下来时，退款交易的回看天数。 */
export const REFUND_LOOKBACK_DAYS = 180

export type ReturnKeyRow = { sellerAccountId: string; amazonOrderId: string; returnDate: Date }
export type ReturnOrder = {
  id: string
  purchaseDate: Date
  amount: number | null
  currency: string
  status: string
  isReplacement: boolean
  replacedOrderId: string | null
  replacementReason: string | null
}

export type ReturnContext = {
  orders: Map<string, ReturnOrder>
  factRows: Map<string, FactRow>
  facts: OrderFacts
}

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

export async function loadReturnContext(prisma: PrismaService, tenantId: string, rows: readonly ReturnKeyRow[]): Promise<ReturnContext> {
  const empty: ReturnContext = { orders: new Map(), factRows: new Map(), facts: { transactions: [], lines: [], returns: [], replacedBy: [], charges: [], cancellations: [] } }
  if (rows.length === 0) return empty
  const stores = [...new Set(rows.map(row => row.sellerAccountId))]
  const orderNos = [...new Set(rows.map(row => row.amazonOrderId))]
  const found = await prisma.order.findMany({
    where: { tenantId, sellerAccountId: { in: stores }, amazonOrderId: { in: orderNos } },
    orderBy: { purchaseDate: 'desc' },
    select: {
      id: true,
      sellerAccountId: true,
      amazonOrderId: true,
      purchaseDate: true,
      amount: true,
      currency: true,
      status: true,
      isReplacement: true,
      replacedOrderId: true,
      replacementReason: true,
    },
    take: 5000,
  })
  const orders = new Map<string, ReturnOrder>()
  for (const order of found) {
    const key = keyOf(order.sellerAccountId, order.amazonOrderId)
    if (!orders.has(key)) orders.set(key, { ...order, amount: num(order.amount) })
  }
  const factRows = new Map<string, FactRow>()
  for (const row of rows) {
    const key = keyOf(row.sellerAccountId, row.amazonOrderId)
    const order = orders.get(key)
    const existing = factRows.get(key)
    if (order) factRows.set(key, { ...order, sellerAccountId: row.sellerAccountId, amazonOrderId: row.amazonOrderId })
    else if (!existing || row.returnDate < existing.purchaseDate) {
      factRows.set(key, {
        id: '',
        sellerAccountId: row.sellerAccountId,
        amazonOrderId: row.amazonOrderId,
        purchaseDate: new Date(row.returnDate.getTime() - REFUND_LOOKBACK_DAYS * DAY_MS),
        status: 'Unknown',
        amount: null,
        isReplacement: false,
        replacedOrderId: null,
        replacementReason: null,
      })
    }
  }
  const facts = await loadOrderFacts(prisma, tenantId, [...factRows.values()])
  return { orders, factRows, facts }
}

/** 订单口径的退款：状态与金额来自财务交易（没有任何财务交易是“待财务交易”，不是“无退款”），第一笔退款入账时间用来判断先后。 */
export function refundViewOf(context: ReturnContext, sellerAccountId: string, amazonOrderId: string): ReturnRefundView & { currency: string } {
  const key = keyOf(sellerAccountId, amazonOrderId)
  const row = context.factRows.get(key)
  if (!row) return { state: 'PENDING_DATA' as OrderRefundState, amount: null, firstRefundAt: null, currency: 'USD' }
  const summary = summarizeOrder(row, context.facts)
  const refunds = context.facts.transactions.filter(tx => tx.sellerAccountId === sellerAccountId && tx.amazonOrderId === amazonOrderId && isRefundTransaction(tx.transactionType))
  const first = refunds.reduce<Date | null>((min, tx) => (!min || tx.postedAt < min ? tx.postedAt : min), null)
  return { state: summary.refund.state, amount: summary.refund.amount, firstRefundAt: first?.toISOString() ?? null, currency: summary.currency }
}
