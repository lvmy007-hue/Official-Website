import { RETURN_REASON_MAP_LIMIT, RETURN_REASON_PRESETS, UNCLASSIFIED_CATEGORY, UNSPECIFIED_REASON_KEY, reasonKey } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { commentExpiry } from './comment-vault'

// 退货报告导入后的两个补充步骤（P6-13）：
//   1. 按订单回填退货记录的下单时间与发货时间（退货周期、跨月退货、队列退货率要用）；订单还没同步下来的保持为空，由下一次导入补上；
//   2. 报告里出现、预置与企业映射里都没有的新原因代码，自动加入映射表（大类“未分类”），页面提醒去补全。
// 两步都不让导入失败：失败只记日志，退货明细已经写入，下一次导入会再做一遍（幂等）。

const ORDER_BATCH = 500
/** 每次导入顺带补齐的“还没有下单时间”的订单数上限（最近的退货优先）。 */
const STALE_ORDER_LIMIT = 2000
const MAX_CODE_CHARS = 80
const MAX_LABEL_CHARS = 60

export interface OrderDatesResult {
  /** 实际回填了下单时间的退货记录数。 */
  updated: number
  /** 订单在本系统里找不到、仍然为空的订单数。 */
  missing: number
}

/**
 * 回填下单与发货时间：同一订单有多个下单时间时取最早的一个（发货时间取同一条订单的）。
 * amazonOrderIds 是本次导入涉及的订单；另外还会补齐该店铺里仍为空的最近 STALE_ORDER_LIMIT 个订单（订单晚到的情形）。
 */
export async function backfillReturnOrderDates(prisma: PrismaClient, tenantId: string, sellerAccountId: string, amazonOrderIds: Iterable<string>, retentionDays?: number): Promise<OrderDatesResult> {
  const wanted = new Set(amazonOrderIds)
  const stale = await prisma.fbaReturnCase.findMany({
    where: { tenantId, sellerAccountId, orderPurchasedAt: null },
    select: { amazonOrderId: true },
    distinct: ['amazonOrderId'],
    orderBy: { amazonOrderId: 'asc' },
    take: STALE_ORDER_LIMIT,
  })
  for (const row of stale) wanted.add(row.amazonOrderId)
  const ids = [...wanted]
  const result: OrderDatesResult = { updated: 0, missing: 0 }
  for (let start = 0; start < ids.length; start += ORDER_BATCH) {
    const batch = ids.slice(start, start + ORDER_BATCH)
    const orders = await prisma.order.findMany({
      where: { tenantId, sellerAccountId, amazonOrderId: { in: batch } },
      select: { amazonOrderId: true, purchaseDate: true, shippedAt: true },
      orderBy: { purchaseDate: 'asc' },
      take: batch.length * 4,
    })
    const earliest = new Map<string, { purchaseDate: Date; shippedAt: Date | null }>()
    for (const order of orders) if (!earliest.has(order.amazonOrderId)) earliest.set(order.amazonOrderId, order)
    result.missing += batch.length - earliest.size
    for (const [amazonOrderId, order] of earliest) {
      const done = await prisma.fbaReturnCase.updateMany({
        // 已经相同的不再写（避免每次导入都改 updatedAt）；空值在 SQL 里不等于任何值，要单独写出来
        where: {
          tenantId,
          sellerAccountId,
          amazonOrderId,
          OR: [
            { orderPurchasedAt: null },
            { orderPurchasedAt: { not: order.purchaseDate } },
            order.shippedAt ? { orderShippedAt: null } : { orderShippedAt: { not: null } },
            ...(order.shippedAt ? [{ orderShippedAt: { not: order.shippedAt } }] : []),
          ],
        },
        data: { orderPurchasedAt: order.purchaseDate, orderShippedAt: order.shippedAt },
      })
      result.updated += done.count
      // 买家备注的保留期按发货日起算：订单的发货日晚到时，把已经算出的（按退货日起算的）截止时间提前，只提前不推后
      if (order.shippedAt) {
        const expiry = commentExpiry({ shippedAt: order.shippedAt, returnDate: order.shippedAt, retentionDays })
        await prisma.fbaReturnCase.updateMany({
          where: { tenantId, sellerAccountId, amazonOrderId, customerCommentsCipher: { not: null }, customerCommentsExpiresAt: { gt: expiry } },
          data: { customerCommentsExpiresAt: expiry },
        })
      }
    }
  }
  return result
}

/** 原因代码的映射表键与展示名：转大写，超长截断；没有原因不登记。 */
export function reasonCodesOf(reasons: Iterable<string | null | undefined>): string[] {
  const codes = new Set<string>()
  for (const raw of reasons) {
    const code = reasonKey(raw)
    if (code !== UNSPECIFIED_REASON_KEY) codes.add(code.slice(0, MAX_CODE_CHARS))
  }
  return [...codes]
}

/**
 * 新原因代码自动加入映射表：预置里有的不加；表里已有的（含企业改过的）不动；企业映射满 RETURN_REASON_MAP_LIMIT 行后不再自动加，只记警告。
 * 返回新加入的代码。
 */
export async function registerNewReasons(prisma: PrismaClient, tenantId: string, reasons: Iterable<string | null | undefined>, logger?: Pick<Logger, 'warn'>): Promise<string[]> {
  const fresh = reasonCodesOf(reasons).filter(code => !(code in RETURN_REASON_PRESETS))
  if (fresh.length === 0) return []
  const existing = await prisma.returnReasonMap.findMany({ where: { tenantId }, select: { code: true }, take: RETURN_REASON_MAP_LIMIT })
  const known = new Set(existing.map(row => row.code))
  const missing = fresh.filter(code => !known.has(code))
  const room = RETURN_REASON_MAP_LIMIT - existing.length
  if (missing.length === 0) return []
  if (room <= 0) {
    logger?.warn({ tenantId, codes: missing.length }, '退货原因映射已满，新的原因代码没有自动加入')
    return []
  }
  const added = missing.slice(0, room)
  if (added.length < missing.length) logger?.warn({ tenantId, skipped: missing.length - added.length }, '退货原因映射接近上限，部分新原因代码没有自动加入')
  await prisma.returnReasonMap.createMany({
    data: added.map(code => ({ tenantId, code, labelZh: code.slice(0, MAX_LABEL_CHARS), category: UNCLASSIFIED_CATEGORY, isSystem: false })),
    skipDuplicates: true,
  })
  return added
}
