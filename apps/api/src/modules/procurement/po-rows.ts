import { poStatusLabel, type DeliveryDeviation, type PoStatus, type PurchaseOrderRow } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { dayText, isoText, moneyText, ratioOf } from './procurement-common'

// 采购单行的组装（列表与详情共用）。金额类字段（totalAmount、paidAmount）带出后由控制器按字段权限剔除。

export type OrderForRow = Prisma.PurchaseOrderGetPayload<{
  include: { supplier: { select: { id: true; name: true; code: true } }; lines: { select: { quantity: true; receivedQuantity: true } }; payments: { select: { amount: true; status: true } } }
}>

export const ROW_INCLUDE = {
  supplier: { select: { id: true, name: true, code: true } },
  lines: { select: { quantity: true, receivedQuantity: true } },
  payments: { select: { amount: true, status: true } },
} satisfies Prisma.PurchaseOrderInclude

export function orderRowOf(order: OrderForRow, deviation: DeliveryDeviation | null): PurchaseOrderRow {
  const orderedQty = order.lines.reduce((sum, line) => sum + line.quantity, 0)
  const receivedQty = order.lines.reduce((sum, line) => sum + line.receivedQuantity, 0)
  const paid = order.payments.filter(payment => payment.status === 'PAID').reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0))
  return {
    id: order.id,
    number: order.number,
    supplierId: order.supplierId,
    supplierName: order.supplier.name,
    status: order.status as PoStatus,
    statusLabel: poStatusLabel(order.status),
    approvalStatus: order.approvalStatus,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    expectedDate: dayText(order.expectedDate),
    lineCount: order.lines.length,
    orderedQty,
    receivedQty,
    receiveRatio: ratioOf(receivedQty, orderedQty),
    createdAt: isoText(order.createdAt) as string,
    version: order.version,
    deviation,
    totalAmount: moneyText(order.totalAmount),
    paidAmount: paid.toString(),
  }
}

/** 订单合计：任何一行没有单价时合计为空（不能把缺失当 0）。 */
export function totalOf(lines: ReadonlyArray<{ quantity: number; unitCost?: number | Prisma.Decimal | null }>): Prisma.Decimal | null {
  let total = new Prisma.Decimal(0)
  for (const line of lines) {
    if (line.unitCost === null || line.unitCost === undefined) return null
    total = total.plus(new Prisma.Decimal(line.unitCost).mul(line.quantity))
  }
  return total
}
