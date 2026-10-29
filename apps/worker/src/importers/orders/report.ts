import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { decimal, validDate, valueFrom } from '../shared'

/** 订单报告：行流逐批写库（每批一个事务）；缺少购买日期的行被跳过并汇总告警，不以当前时间兜底。 */
export function syncOrdersReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, marketplaceId: string): Promise<ImportResult> {
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row) => {
      const amazonOrderId = String(valueFrom(row, ['amazon-order-id', 'order-id', 'AmazonOrderId']) ?? '').trim()
      if (!amazonOrderId) return 'ignored'
      const total = decimal(valueFrom(row, ['item-price', 'order-total', 'amount']))
      const currency = String(valueFrom(row, ['currency', 'currency-code', 'item-currency']) ?? 'USD')
      const purchaseDate = validDate(valueFrom(row, ['purchase-date', 'purchase-date-local']))
      if (!purchaseDate) return 'skipped'
      const order = await prisma.order.upsert({
        where: { sellerAccountId_amazonOrderId_purchaseDate: { sellerAccountId, amazonOrderId, purchaseDate } },
        create: {
          tenantId,
          sellerAccountId,
          amazonOrderId,
          marketplaceId,
          purchaseDate,
          status: String(valueFrom(row, ['order-status', 'order-status-description']) ?? 'UNKNOWN'),
          fulfillment: String(valueFrom(row, ['fulfillment-channel']) ?? '') || undefined,
          currency,
          amount: total,
          itemCount: 0,
          sourceUpdatedAt: new Date(),
          sourceRecordId: amazonOrderId,
        },
        update: { status: String(valueFrom(row, ['order-status', 'order-status-description']) ?? 'UNKNOWN'), currency, amount: total, sourceUpdatedAt: new Date() },
      })
      const sellerSku = String(valueFrom(row, ['sku', 'seller-sku']) ?? '').trim()
      const asin = String(valueFrom(row, ['asin', 'product-id']) ?? '').trim()
      if (sellerSku || asin) {
        const orderItemId = String(valueFrom(row, ['order-item-id', 'order-item-id']) ?? [amazonOrderId, sellerSku || asin].join(':')).trim()
        await prisma.orderItem.upsert({
          where: { sellerAccountId_orderItemId_orderPurchaseDate: { sellerAccountId, orderItemId, orderPurchaseDate: order.purchaseDate } },
          create: {
            tenantId,
            sellerAccountId,
            orderId: order.id,
            orderPurchaseDate: order.purchaseDate,
            amazonOrderId,
            orderItemId,
            asin: asin || undefined,
            sellerSku: sellerSku || undefined,
            title: String(valueFrom(row, ['product-name', 'title']) ?? '') || undefined,
            quantityOrdered: Number(valueFrom(row, ['quantity', 'quantity-ordered']) ?? 0),
            quantityShipped: Number(valueFrom(row, ['quantity-shipped']) ?? 0),
            itemPrice: decimal(valueFrom(row, ['item-price'])),
            currency,
            sourceUpdatedAt: new Date(),
          },
          update: {
            asin: asin || undefined,
            sellerSku: sellerSku || undefined,
            quantityOrdered: Number(valueFrom(row, ['quantity', 'quantity-ordered']) ?? 0),
            quantityShipped: Number(valueFrom(row, ['quantity-shipped']) ?? 0),
            itemPrice: decimal(valueFrom(row, ['item-price'])),
            sourceUpdatedAt: new Date(),
          },
        })
        await prisma.order.update({ where: { id_purchaseDate: { id: order.id, purchaseDate: order.purchaseDate } }, data: { itemCount: { increment: 1 } } })
      }
      return 'imported'
    },
    { skippedMessage: 'order report rows without a valid purchase date were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
