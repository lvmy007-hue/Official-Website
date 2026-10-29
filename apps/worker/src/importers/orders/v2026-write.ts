import type { PiiSealer } from '../../crypto/secrets'
import type { ImportContext } from '../../types'
import type { ParsedOrder } from './v2026-types'

// 订单新版接口落库（importers.md S2）。一个订单一个事务（调用方负责事务边界）：订单头、订单行、逐项金额、包裹、取消、状态历史同进同退。
// 幂等键：订单 = 店铺 + 订单号 + 下单时间；订单行 = 店铺 + 订单行编号 + 下单时间；金额 = 订单行 + 金额类别 + 组成项；包裹 = 订单 + 包裹编号 + 运单号。

export const PII_RETENTION_DAYS = 30
/** 未发货订单的买家信息最长保留天数（从下单起算）。 */
export const PII_UNSHIPPED_MAX_DAYS = 90
const DAY = 86_400_000

export type OrderScope = { tenantId: string; sellerAccountId: string }
export type WriteOutcome = 'written' | 'stale'

/** 买家信息到期时间：已取消或已超过 90 天立即到期；已发货为发货后 30 天；其余为下单后 90 天。沿用升级前的规则，升级不改变保留策略。 */
export function piiExpiry(input: { status: string; purchaseDate: Date; shippedAt?: Date | null; now: Date; retentionDays?: number }): Date {
  const agedOut = input.purchaseDate.getTime() + PII_UNSHIPPED_MAX_DAYS * DAY < input.now.getTime()
  if (input.status === 'Canceled' || agedOut) return input.now
  // 发货后保留天数：企业可以在设置里缩短（P5-10），但不会超过亚马逊要求的 30 天
  if (input.shippedAt) return new Date(input.shippedAt.getTime() + Math.min(input.retentionDays ?? PII_RETENTION_DAYS, PII_RETENTION_DAYS) * DAY)
  return new Date(input.purchaseDate.getTime() + PII_UNSHIPPED_MAX_DAYS * DAY)
}

const networkOf = (fulfillment?: string) => (fulfillment === 'AFN' ? 'AMAZON' : fulfillment === 'MFN' ? 'MERCHANT' : undefined)

/** 写入一个订单。来源版本（lastUpdatedTime）比库里已有的更旧时跳过（乱序或重复拉取的旧快照不覆盖新数据）。 */
export async function writeOrder(ctx: ImportContext & { secrets: PiiSealer }, scope: OrderScope, order: ParsedOrder, now: Date = new Date(), customerInfoDays?: number): Promise<WriteOutcome> {
  const { prisma, secrets } = ctx
  const { tenantId, sellerAccountId } = scope
  const key = { sellerAccountId, amazonOrderId: order.amazonOrderId, purchaseDate: order.purchaseDate }
  const existing = await prisma.order.findUnique({
    where: { sellerAccountId_amazonOrderId_purchaseDate: key },
    select: { sourceUpdatedAt: true, piiCiphertext: true, shippedAt: true },
  })
  if (existing && existing.sourceUpdatedAt.getTime() > order.lastUpdated.getTime()) return 'stale'

  const shippedAt = order.shippedAt ?? existing?.shippedAt ?? undefined
  const piiExpiresAt = order.pii || existing?.piiCiphertext ? piiExpiry({ status: order.status, purchaseDate: order.purchaseDate, shippedAt, now, retentionDays: customerInfoDays }) : undefined
  // 已到期的买家信息不再写入（避免刚写入就被清理任务清空）；没有买家信息权限时 pii 为空，保持库里原样。
  const piiCiphertext = order.pii && piiExpiresAt && piiExpiresAt > now ? await secrets.sealBuyerPii(JSON.stringify(order.pii)) : undefined

  const header = {
    marketplaceId: order.marketplaceId,
    status: order.status,
    fulfillment: order.fulfillment,
    currency: order.currency,
    amount: order.amount,
    itemCount: order.items.length,
    sourceUpdatedAt: order.lastUpdated,
    fulfillmentStatus: order.fulfillmentStatus,
    latestShipDate: order.latestShipDate,
    earliestDelivery: order.earliestDelivery,
    latestDelivery: order.latestDelivery,
    cancelledBy: order.cancellation?.cancelledBy,
    // 订单接口只在“有关联订单”时才说这是替换订单；没有时不能把替换订单报告（R-05）写入的标记改回否
    ...(order.isReplacement ? { isReplacement: true, replacedOrderId: order.replacedOrderId } : {}),
    programs: order.programs,
    salesChannel: order.salesChannel,
    shippedAt,
    piiExpiresAt,
    ...(piiCiphertext ? { piiCiphertext } : {}),
  }
  const saved = await prisma.order.upsert({
    where: { sellerAccountId_amazonOrderId_purchaseDate: key },
    create: { tenantId, sellerAccountId, amazonOrderId: order.amazonOrderId, purchaseDate: order.purchaseDate, sourceRecordId: order.amazonOrderId, ...header },
    update: header,
  })
  const base = { tenantId, sellerAccountId }
  const sourceUpdatedAt = order.lastUpdated

  await prisma.orderStatusHistory.upsert({
    where: { orderId_status_sourceUpdatedAt: { orderId: saved.id, status: order.status, sourceUpdatedAt } },
    create: {
      ...base,
      orderId: saved.id,
      orderPurchaseDate: saved.purchaseDate,
      status: order.status,
      occurredAt: sourceUpdatedAt,
      source: 'API',
      sourceUpdatedAt,
      sourceRecordId: order.amazonOrderId,
    },
    update: {},
  })

  for (const item of order.items) {
    const fields = {
      asin: item.asin,
      sellerSku: item.sellerSku,
      title: item.title,
      condition: item.condition,
      quantityOrdered: item.quantityOrdered,
      quantityShipped: item.quantityShipped,
      itemPrice: item.itemPrice,
      promotionDiscount: item.promotionDiscount,
      taxAmount: item.taxAmount,
      currency: item.currency,
      itemStatus: item.itemStatus,
      fulfillmentNetwork: networkOf(order.fulfillment),
      marketplaceId: order.marketplaceId,
      sourceUpdatedAt,
    }
    await prisma.orderItem.upsert({
      where: { sellerAccountId_orderItemId_orderPurchaseDate: { sellerAccountId, orderItemId: item.orderItemId, orderPurchaseDate: saved.purchaseDate } },
      create: { ...base, orderId: saved.id, orderPurchaseDate: saved.purchaseDate, amazonOrderId: order.amazonOrderId, orderItemId: item.orderItemId, sourceRecordId: item.orderItemId, ...fields },
      update: fields,
    })
  }

  // 逐项金额：整单重写（促销撤销、税拆分变化后，旧的组成项不会残留）。同一订单重复处理结果相同。
  await prisma.orderCharge.deleteMany({ where: { orderId: saved.id, purchaseDate: saved.purchaseDate } })
  const charges = order.items.flatMap(item => item.charges)
  if (charges.length > 0) {
    await prisma.orderCharge.createMany({
      data: charges.map(charge => ({
        ...base,
        orderId: saved.id,
        purchaseDate: saved.purchaseDate,
        amazonOrderId: order.amazonOrderId,
        orderItemId: charge.orderItemId,
        chargeKind: charge.chargeKind,
        componentKey: charge.componentKey,
        amount: charge.amount,
        currency: charge.currency,
        feeCategory: charge.feeCategory,
        sourceUpdatedAt,
        sourceRecordId: `${charge.orderItemId}:${charge.componentKey}`,
      })),
    })
  }

  for (const pack of order.packages) {
    const fields = { carrier: pack.carrier, shippingService: pack.shippingService, packageStatus: pack.packageStatus, shipDate: pack.shipDate, sourceUpdatedAt }
    await prisma.orderPackage.upsert({
      where: { sellerAccountId_orderId_packageId_trackingNumber: { sellerAccountId, orderId: saved.id, packageId: pack.packageId, trackingNumber: pack.trackingNumber } },
      create: {
        ...base,
        orderId: saved.id,
        orderPurchaseDate: saved.purchaseDate,
        packageId: pack.packageId,
        trackingNumber: pack.trackingNumber,
        sourceRecordId: `${order.amazonOrderId}:${pack.packageId}`,
        ...fields,
      },
      update: fields,
    })
  }

  if (order.cancellation) {
    const fields = { cancelledBy: order.cancellation.cancelledBy, reasonCode: order.cancellation.reasonCode, cancelledAt: order.cancellation.cancelledAt, sourceUpdatedAt }
    await prisma.orderCancellation.upsert({
      where: { sellerAccountId_orderId: { sellerAccountId, orderId: saved.id } },
      create: { ...base, orderId: saved.id, orderPurchaseDate: saved.purchaseDate, sourceRecordId: order.amazonOrderId, ...fields },
      update: fields,
    })
  }
  return 'written'
}
