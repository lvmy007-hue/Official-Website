import type { PromotionCostSection } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { feePreviewOf, num } from './promotions-common'
import { gateOf, PARTIAL_NOTE, type DetailContext } from './promotions-context'
import { feeOf, feeWindow, keywordsOf, loadFeeEvents } from './promotions-fees'

// 促销成本页签（M-161 折扣成本、M-162 平台费用）：
// 折扣成本 = 活动期间所选商品订单明细里的促销折扣（OrderItem.promotionDiscount）合计，美元，要订单读取权限；
// 平台费用 = 费用事件归集（见 promotions-fees.ts），要财务读取权限；价格折扣与满减没有登记的平台费用，按“不适用”处理。
// 都按“没有记录就写尚无记录”：订单明细里折扣列全空、没有匹配的费用事件，都不会显示成 0。

const NOT_CANCELED = [{ itemStatus: null }, { itemStatus: { not: 'Canceled' } }]

export async function costSection(prisma: PrismaService, ctx: DetailContext, canOrders: boolean, canFinance: boolean): Promise<PromotionCostSection> {
  const { row } = ctx
  const empty = { state: 'NO_DATA' as const, amount: null }
  const feePreview = feePreviewOf(row.feeJson)
  const gate = gateOf(ctx)
  const idle = { discount: { ...empty, orderLines: 0, note: null }, platformFee: { ...empty, lines: [], note: null }, total: null, feePreview, currency: 'USD' as const }
  if (gate) return { ...idle, state: gate.state, note: gate.note }

  const end = row.endAt && row.endAt < ctx.now ? row.endAt : ctx.now
  const keywords = keywordsOf(row.promotionType)
  const window = feeWindow(row.startAt, row.endAt, ctx.now)
  const [orders, fees] = await Promise.all([
    canOrders
      ? prisma.orderItem.aggregate({
          where: { tenantId: ctx.tenantId, sellerAccountId: row.sellerAccountId, asin: { in: ctx.asins }, currency: 'USD', orderPurchaseDate: { gte: row.startAt, lte: end }, OR: NOT_CANCELED },
          _sum: { promotionDiscount: true },
          _count: { _all: true, promotionDiscount: true },
        })
      : null,
    canFinance && keywords.length > 0 ? loadFeeEvents(prisma, { tenantId: ctx.tenantId, storeIds: [row.sellerAccountId], asins: ctx.asins, from: window.from, to: window.to, keywords }) : null,
  ])

  const discount: PromotionCostSection['discount'] = !orders
    ? { state: 'RESTRICTED', amount: null, orderLines: 0, note: '需要订单读取权限（orders.read）才能看折扣成本' }
    : orders._count.promotionDiscount > 0
      ? {
          state: 'OK',
          amount: Math.abs(Math.round((num(orders._sum.promotionDiscount) ?? 0) * 100) / 100),
          orderLines: orders._count._all,
          note: '来自订单明细里的促销折扣，只含所选商品；同一订单行同时享受多个促销时折扣不会拆分',
        }
      : {
          state: 'NO_DATA',
          amount: null,
          orderLines: orders._count._all,
          note: orders._count._all > 0 ? '尚无记录：这期间的订单明细都没有给出促销折扣金额' : '尚无记录：活动期间所选商品还没有订单明细',
        }

  let platformFee: PromotionCostSection['platformFee']
  if (!canFinance) platformFee = { state: 'RESTRICTED', amount: null, lines: [], note: '需要财务读取权限（finance.read）才能看平台费用' }
  else if (keywords.length === 0) platformFee = { state: 'NOT_APPLICABLE', amount: null, lines: [], note: '这类促销没有登记的平台费用' }
  else if (!fees || fees.truncated) platformFee = { state: 'NO_DATA', amount: null, lines: [], note: '同期费用事件太多没有读完，不给不完整的数字' }
  else {
    const found = feeOf(fees.events, { sellerAccountId: row.sellerAccountId, type: row.promotionType, startAt: row.startAt, endAt: row.endAt, asins: new Set(ctx.asins) }, ctx.now)
    platformFee =
      found.count > 0
        ? { state: 'OK', amount: found.amount, lines: found.lines, note: '按所选商品与活动期间（结束后 7 天内入账）从费用事件归集，事件没有商品标识的不计入' }
        : { state: 'NO_DATA', amount: null, lines: [], note: '尚无记录：没有找到归入这个促销的费用事件（可能尚未入账，或事件没有商品标识）' }
  }
  const feeAmount = platformFee.state === 'OK' ? platformFee.amount : platformFee.state === 'NOT_APPLICABLE' ? 0 : null
  const total = discount.amount !== null && feeAmount !== null ? Math.round((discount.amount + feeAmount) * 100) / 100 : null
  return { state: 'OK', note: ctx.asinsPartial ? PARTIAL_NOTE : null, currency: 'USD', discount, platformFee, total, feePreview }
}
