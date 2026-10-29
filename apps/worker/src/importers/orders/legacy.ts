import type { AmazonSpApiClient } from '../../connectors/amazon-sp-api'
import type { LegacyOrder } from '../../parity/compare-orders'
import type { JsonObject } from '../../types'
import { validDate } from '../shared'

// 旧订单接口（v0）只读取数：仅用于新旧并行核对，不写库。升级后订单数据全部来自新接口（v2026-01-01）。
// 只取订单头；买家信息、逐行明细都不再通过 v0 获取（也不再申请受限数据令牌）。

export async function fetchLegacyOrders(client: Pick<AmazonSpApiClient, 'getOrders'>, marketplaceId: string, window: { after: string; before: string }): Promise<LegacyOrder[]> {
  const orders: LegacyOrder[] = []
  let nextToken: string | undefined
  do {
    const response = await client.getOrders(marketplaceId, nextToken, { createdAfter: window.after, createdBefore: window.before })
    const payload = (response.payload ?? response) as JsonObject
    for (const item of Array.isArray(payload.Orders) ? (payload.Orders as JsonObject[]) : []) {
      const amazonOrderId = String(item.AmazonOrderId ?? '').trim()
      const purchaseDate = validDate(item.PurchaseDate)
      if (!amazonOrderId || !purchaseDate) continue
      const total = (item.OrderTotal ?? {}) as JsonObject
      const amount = total.Amount === undefined || total.Amount === '' ? undefined : Number(total.Amount)
      orders.push({
        amazonOrderId,
        purchaseDate,
        lastUpdate: validDate(item.LastUpdateDate) ?? undefined,
        status: String(item.OrderStatus ?? 'UNKNOWN'),
        amount: amount !== undefined && Number.isFinite(amount) ? amount : undefined,
      })
    }
    const token = payload.NextToken ?? response.NextToken
    nextToken = typeof token === 'string' && token.length > 0 ? token : undefined
  } while (nextToken)
  return orders
}
