import { Injectable } from '@nestjs/common'
import { ORDERS_RETURNS_PERMISSION, isRefundTransaction, returnDispositionView, type OrderReturnsResponse, type OrderRisksResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { OrderAccessService } from './orders-access.service'
import { factRowOf } from './orders-detail.service'
import { loadOrderFacts, summarizeOrder } from './orders-facts'

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

// 退款与退货、替换关系、风险标记。退款与退货要 returns.read；风险标记只要能看订单。
@Injectable()
export class OrdersReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrderAccessService,
  ) {}

  async returns(req: RequestWithContext, id: string): Promise<OrderReturnsResponse> {
    const { context, order } = await this.access.resolve(req, id, [ORDERS_RETURNS_PERMISSION])
    const own = { tenantId: context.tenantId, sellerAccountId: order.sellerAccountId }
    const [facts, returns, original, replacedBy] = await Promise.all([
      loadOrderFacts(this.prisma, context.tenantId, [factRowOf(order)]),
      this.prisma.fbaReturnCase.findMany({ where: { ...own, amazonOrderId: order.amazonOrderId }, orderBy: { returnDate: 'desc' }, take: 200 }),
      order.isReplacement && order.replacedOrderId
        ? this.prisma.order.findFirst({ where: { ...own, amazonOrderId: order.replacedOrderId }, orderBy: { purchaseDate: 'desc' }, select: { id: true } })
        : null,
      this.prisma.order.findMany({
        where: { ...own, replacedOrderId: order.amazonOrderId },
        orderBy: { purchaseDate: 'asc' },
        select: { id: true, amazonOrderId: true, replacementReason: true },
        take: 50,
      }),
    ])
    const summary = summarizeOrder(factRowOf(order), facts)
    const refunds = facts.transactions
      .filter(tx => tx.sellerAccountId === order.sellerAccountId && tx.amazonOrderId === order.amazonOrderId && isRefundTransaction(tx.transactionType))
      .map(tx => ({ postedAt: tx.postedAt.toISOString(), amount: tx.amount, currency: tx.currency, status: tx.transactionStatus }))
    return {
      refunds,
      refundTotal: summary.refund.amount,
      refund: summary.refund,
      returns: returns.map(row => {
        const disposition = returnDispositionView(row.detailedDisposition, row.disposition)
        return {
          id: row.id,
          returnId: row.returnId,
          asin: row.asin,
          sku: row.sellerSku,
          quantity: row.quantity,
          // 处置：显示我方归并后的分组名（可售、承运人损坏…），报告没给处置时为空
          disposition: disposition.raw === null ? null : disposition.label,
          reason: row.reason,
          status: row.status,
          refundAmount: num(row.refundAmount),
          returnDate: row.returnDate.toISOString(),
        }
      }),
      replacement: {
        isReplacement: order.isReplacement,
        reason: order.replacementReason,
        original: order.isReplacement && order.replacedOrderId ? { id: original?.id ?? null, amazonOrderId: order.replacedOrderId } : null,
        replacedBy: replacedBy.map(row => ({ id: row.id, amazonOrderId: row.amazonOrderId, reason: row.replacementReason })),
      },
    }
  }

  async risks(req: RequestWithContext, id: string): Promise<OrderRisksResponse> {
    const { context, order } = await this.access.resolve(req, id)
    const facts = await loadOrderFacts(this.prisma, context.tenantId, [factRowOf(order)])
    return { items: summarizeOrder(factRowOf(order), facts).risks }
  }
}
