// 订单接口新版（v2026-01-01）解析后的规范化结构。解析是纯函数，不碰数据库，便于用官方格式样例直接测试。

export type ChargeKind = 'ITEM' | 'SHIPPING' | 'PROMOTION' | 'TAX' | 'FEE' | 'OTHER'
export type CancelledBy = 'BUYER' | 'SELLER' | 'AMAZON' | 'UNKNOWN'

export type ParsedCharge = { orderItemId: string; chargeKind: ChargeKind; componentKey: string; amount: number; currency: string; feeCategory?: string }

export type ParsedItem = {
  orderItemId: string
  asin?: string
  sellerSku?: string
  title?: string
  condition?: string
  quantityOrdered: number
  quantityShipped: number
  /** 商品行小计（不含税时为不含税价；税不单列时含税，见官方迁移指南“Item price tax treatment”）。 */
  itemPrice?: number
  /** 促销折扣金额，正数表示折让。 */
  promotionDiscount?: number
  taxAmount?: number
  currency: string
  itemStatus?: string
  charges: ParsedCharge[]
}

export type ParsedPackage = {
  packageId: string
  carrier: string
  trackingNumber: string
  shippingService?: string
  packageStatus?: string
  shipDate?: Date
}

/** 买家个人信息：只在内存里短暂存在，写库前整体加密；字段名与既有加密载荷一致。 */
export type ParsedPii = { buyerName?: string; buyerEmail?: string; buyerPhone?: string; addressLine1?: string; city?: string; state?: string; postalCode?: string; country?: string }

export type ParsedCancellation = { cancelledBy: CancelledBy; reasonCode: string; cancelledAt?: Date }

export type ParsedOrder = {
  amazonOrderId: string
  purchaseDate: Date
  /** 来源更新时间（接口的 lastUpdatedTime）：重复拉取同一版本不会被当成新数据。 */
  lastUpdated: Date
  marketplaceId: string
  /** 新版履约状态原值（UNSHIPPED、SHIPPED、CANCELLED 等）。 */
  fulfillmentStatus: string
  /** 旧版风格状态（Unshipped、Shipped、Canceled 等）：沿用至今的列表筛选与买家信息保留规则都用它，升级不改变既有页面行为。 */
  status: string
  fulfillment?: 'AFN' | 'MFN'
  currency: string
  amount?: number
  latestShipDate?: Date
  earliestDelivery?: Date
  latestDelivery?: Date
  isReplacement: boolean
  replacedOrderId?: string
  programs: string[]
  /** 销售渠道名称（例如 Amazon.com），订单详情身份区显示。 */
  salesChannel?: string
  cancellation?: ParsedCancellation
  shippedAt?: Date
  items: ParsedItem[]
  packages: ParsedPackage[]
  pii?: ParsedPii
}

/** 核对用的订单摘要：不含任何买家信息，可以在内存里保留一个窗口的量。 */
export type OrderDigest = { amazonOrderId: string; purchaseDate: Date; lastUpdated: Date; status: string; amount?: number; currency: string; taxAmount: number }

export const digestOf = (order: ParsedOrder): OrderDigest => ({
  amazonOrderId: order.amazonOrderId,
  purchaseDate: order.purchaseDate,
  lastUpdated: order.lastUpdated,
  status: order.status,
  amount: order.amount,
  currency: order.currency,
  taxAmount: order.items.reduce((sum, item) => sum + (item.taxAmount ?? 0), 0),
})

export type OrderSkip = { skipped: 'NO_ORDER_ID' | 'NO_PURCHASE_DATE' | 'NOT_US_MARKETPLACE' }
