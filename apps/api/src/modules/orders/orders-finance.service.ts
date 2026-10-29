import { Injectable } from '@nestjs/common'
import {
  CHARGE_KIND_LABEL,
  ORDERS_FINANCE_PERMISSION,
  chargesSummary,
  classifyFinanceLine,
  financeLineLabel,
  financeMatch,
  isRefundTransaction,
  lineBelongsTo,
  netIncomeOf,
  settlementView,
  transactionStatusLabel,
  type OrderChargesResponse,
  type OrderTransactionsResponse,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { OrderAccessService } from './orders-access.service'
import { factRowOf } from './orders-detail.service'
import { loadOrderFacts } from './orders-facts'

const DAY_MS = 86_400_000
const TRANSACTION_PAGE = 200
const round2 = (value: number) => Math.round(value * 100) / 100
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? 0 : Number(value.toString()))

// 订单的钱：订单接口给的收入明细、财务交易里的费用明细与比对、财务交易列表（07 章 7.1 第 3、6 页签）。
@Injectable()
export class OrdersFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrderAccessService,
  ) {}

  async charges(req: RequestWithContext, id: string): Promise<OrderChargesResponse> {
    const { context, order } = await this.access.resolve(req, id)
    const key = { tenantId: context.tenantId, orderId: order.id }
    const [rows, items, facts] = await Promise.all([
      this.prisma.orderCharge.findMany({ where: { ...key, purchaseDate: order.purchaseDate }, orderBy: [{ orderItemId: 'asc' }, { chargeKind: 'asc' }, { componentKey: 'asc' }], take: 500 }),
      this.prisma.orderItem.findMany({ where: { ...key, orderPurchaseDate: order.purchaseDate }, select: { orderItemId: true, sellerSku: true }, take: 500 }),
      loadOrderFacts(this.prisma, context.tenantId, [factRowOf(order)]),
    ])
    const skuOf = new Map(items.map(item => [item.orderItemId, item.sellerSku]))
    const transactions = facts.transactions.filter(tx => tx.sellerAccountId === order.sellerAccountId && tx.amazonOrderId === order.amazonOrderId)
    const refundIds = transactions.filter(tx => isRefundTransaction(tx.transactionType)).map(tx => tx.externalTransactionId)
    // 费用与比对只看“销售类”交易的明细；退款交易的明细在“退款与退货”页签里体现
    const saleLines = facts.lines.filter(line => line.sellerAccountId === order.sellerAccountId && line.amazonOrderId === order.amazonOrderId && !refundIds.some(txId => lineBelongsTo(line, txId)))
    const charges = rows.map(row => ({ chargeKind: row.chargeKind, amount: num(row.amount) }))
    const revenue = rows.length > 0 ? chargesSummary(charges) : null
    const fees = saleLines
      .filter(line => classifyFinanceLine(line.path) === 'FEE')
      .map(line => ({
        path: line.path,
        label: financeLineLabel(line.path),
        group: 'FEE' as const,
        amount: round2(line.amount),
        currency: transactions[0]?.currency ?? order.currency,
        postedAt: line.postedAt.toISOString(),
      }))
    const match: OrderChargesResponse['match'] =
      rows.length === 0
        ? { state: 'NO_LINES', note: '订单接口没有给出逐项金额（订单行金额尚未同步），无法与财务交易比对。', revenue: null, tax: null }
        : financeMatch({ orderRevenue: revenue?.totalExTax ?? 0, orderTax: revenue?.tax ?? 0, transactionCount: transactions.length, lines: saleLines })
    const net = netIncomeOf(transactions)
    return {
      currency: order.currency,
      lines: rows.map(row => ({
        orderItemId: row.orderItemId,
        sku: skuOf.get(row.orderItemId) ?? null,
        kind: row.chargeKind,
        kindLabel: CHARGE_KIND_LABEL[row.chargeKind] ?? row.chargeKind,
        componentKey: row.componentKey,
        amount: num(row.amount),
        currency: row.currency,
      })),
      revenue,
      fees,
      feeTotal: saleLines.length > 0 ? round2(fees.reduce((total, fee) => total + fee.amount, 0)) : null,
      ...(canSeeField(context.permissions, 'profit') ? { netIncome: net } : {}),
      match,
    }
  }

  async transactions(req: RequestWithContext, id: string): Promise<OrderTransactionsResponse> {
    const { context, order } = await this.access.resolve(req, id, [ORDERS_FINANCE_PERMISSION])
    const rows = await this.prisma.fbaFinancialTransaction.findMany({
      where: { tenantId: context.tenantId, sellerAccountId: order.sellerAccountId, amazonOrderId: order.amazonOrderId, postedAt: { gte: new Date(order.purchaseDate.getTime() - DAY_MS) } },
      include: { settlement: { select: { id: true, externalSettlementId: true, depositDate: true, status: true } } },
      orderBy: { postedAt: 'asc' },
      take: TRANSACTION_PAGE + 1,
    })
    const truncated = rows.length > TRANSACTION_PAGE
    const shown = rows.slice(0, TRANSACTION_PAGE)
    return {
      items: shown.map(row => ({
        id: row.id,
        externalTransactionId: row.externalTransactionId,
        transactionType: row.transactionType,
        status: row.transactionStatus,
        statusLabel: transactionStatusLabel(row.transactionStatus),
        amount: num(row.amount),
        currency: row.currency,
        postedAt: row.postedAt.toISOString(),
        description: row.description,
        reconciliationStatus: row.reconciliationStatus,
        settlement: row.settlement
          ? { id: row.settlement.id, externalSettlementId: row.settlement.externalSettlementId, depositDate: row.settlement.depositDate?.toISOString() ?? null, status: row.settlement.status }
          : null,
      })),
      settlement: settlementView(shown.map(row => row.transactionStatus)),
      // 超过一页时合计不完整，宁可不给
      total: shown.length > 0 && !truncated ? round2(shown.reduce((total, row) => total + num(row.amount), 0)) : null,
      truncated,
    }
  }
}
