import { PrismaService } from '../../platform/prisma.service'
import { DAY_MS } from './reviews-common'

// 已送达订单的读取（请求评价用）。只读订单编号、下单日期与包裹送达时间，不读买家与收件人信息。
// 订单表按下单月分区、主键含下单日期：下单不会晚于送达，也不会比送达早太多，用送达时间窗反推下单日期的范围，避免扫描全部分区。

/** 下单日期最早比送达窗口起点早这么多天（跨境运输加备货的上界）。 */
export const PURCHASE_LOOKBACK_DAYS = 120

export interface DeliveredOrder {
  storeId: string
  orderId: string
  purchaseDate: Date
  /** 订单最晚的包裹送达时间。 */
  deliveredAt: Date
}

/**
 * 全部包裹都已送达、且最晚送达时间落在 [from, to] 内的订单（按下单时间从新到旧最多读 limit 个，多出的标 truncated）。
 * 有任何一个包裹没有送达时间的订单不算已送达。
 */
export async function deliveredOrders(
  prisma: PrismaService,
  tenantId: string,
  storeIds: readonly string[],
  range: { from: Date; to: Date },
  limit: number,
): Promise<{ rows: DeliveredOrder[]; truncated: boolean }> {
  if (storeIds.length === 0) return { rows: [], truncated: false }
  const groups = await prisma.orderPackage.groupBy({
    by: ['sellerAccountId', 'orderId', 'orderPurchaseDate'],
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, orderPurchaseDate: { gte: new Date(range.from.getTime() - PURCHASE_LOOKBACK_DAYS * DAY_MS), lte: range.to } },
    _count: { _all: true, deliveredAt: true },
    _max: { deliveredAt: true },
    having: { deliveredAt: { _max: { gte: range.from, lte: range.to } } },
    orderBy: [{ orderPurchaseDate: 'desc' }, { orderId: 'asc' }, { sellerAccountId: 'asc' }],
    take: limit + 1,
  })
  const rows = groups
    .slice(0, limit)
    .filter(group => group._count._all === group._count.deliveredAt && group._max.deliveredAt)
    .map((group): DeliveredOrder => ({ storeId: group.sellerAccountId, orderId: group.orderId, purchaseDate: group.orderPurchaseDate, deliveredAt: group._max.deliveredAt as Date }))
  return { rows, truncated: groups.length > limit }
}
