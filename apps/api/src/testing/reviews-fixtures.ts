import type { Client } from 'pg'
import { insertRow } from './db-fixtures'

// 评价与反馈真实库测试的造数工具（P4-13）：订单只造订单号、下单日期、ASIN 与包裹送达时间，不造任何买家信息。

export const DAY = 86_400_000

/** 一个订单：每个 ASIN 一行订单行，每个送达时间一个包裹（null 表示这个包裹还没有送达）。 */
export async function seedOrder(
  client: Client,
  input: { tenantId: string; storeId: string; id: string; amazonOrderId: string; purchaseDate: string; asins: string[]; deliveries: Array<string | null>; status?: string },
): Promise<void> {
  const { tenantId, storeId, id } = input
  await insertRow(client, 'Order', {
    id,
    tenantId,
    sellerAccountId: storeId,
    amazonOrderId: input.amazonOrderId,
    purchaseDate: input.purchaseDate,
    status: input.status ?? 'Shipped',
    currency: 'USD',
  })
  for (const [index, asin] of input.asins.entries()) {
    await insertRow(client, 'OrderItem', {
      id: `oi-${id}-${index}`,
      tenantId,
      sellerAccountId: storeId,
      orderId: id,
      orderPurchaseDate: input.purchaseDate,
      amazonOrderId: input.amazonOrderId,
      orderItemId: `${input.amazonOrderId}-I${index}`,
      asin,
      sellerSku: `SKU-${asin}`,
    })
  }
  for (const [index, deliveredAt] of input.deliveries.entries()) {
    await insertRow(client, 'OrderPackage', {
      id: `pk-${id}-${index}`,
      tenantId,
      sellerAccountId: storeId,
      orderId: id,
      orderPurchaseDate: input.purchaseDate,
      packageId: `P${index}`,
      trackingNumber: `T-${id}-${index}`,
      deliveredAt,
    })
  }
}
