import { splitBatchTerms, type OrderListQuery } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'

// 订单列表的筛选条件（P2b-01）。
// 状态、日期、ASIN、SKU、促销、取消、搜索直接落到订单表与订单行上；退款、退货、替换、结算这几项数据在别的表里，
// 先在“不早于筛选起始时间”的范围内找出符合条件的订单号（有上限），再用订单号列表去过滤订单；
// 找订单号触到上限时返回 limited = true，页面提示“结果可能不完整”，不假装精确。

/** 每种筛选最多取多少个订单号（Prisma 单条语句的绑定参数上限约 3 万，留足余量）。 */
export const ID_SET_LIMIT = 5000

type IdSet = { ids: string[]; limited: boolean }
const toSet = (rows: Array<{ amazonOrderId: string | null }>): IdSet => ({ ids: rows.flatMap(row => (row.amazonOrderId ? [row.amazonOrderId] : [])), limited: rows.length >= ID_SET_LIMIT })

export type BuiltFilters = { where: Prisma.OrderWhereInput; limited: boolean }

export async function buildOrderFilters(prisma: PrismaService, input: { tenantId: string; scope: ResolvedScope; query: OrderListQuery; from: Date; to: Date }): Promise<BuiltFilters> {
  const { tenantId, scope, query, from, to } = input
  const store = storeWhere(scope)
  const and: Prisma.OrderWhereInput[] = [{ tenantId, ...store, purchaseDate: { gte: from, lt: to } }]
  let limited = false
  const take = ID_SET_LIMIT
  const cache = new Map<string, Promise<IdSet>>()
  const orderIdSet = async (name: string, load: () => Promise<IdSet>) => {
    if (!cache.has(name)) cache.set(name, load())
    const set = await (cache.get(name) as Promise<IdSet>)
    limited ||= set.limited
    return set.ids
  }

  const refundIds = () =>
    orderIdSet('refund', async () =>
      toSet(
        await prisma.fbaFinancialTransaction.findMany({
          where: { tenantId, ...store, transactionType: { contains: 'refund', mode: 'insensitive' }, amazonOrderId: { not: null }, postedAt: { gte: from } },
          select: { amazonOrderId: true },
          distinct: ['amazonOrderId'],
          take,
        }),
      ),
    )
  const returnIds = () =>
    orderIdSet('return', async () =>
      toSet(await prisma.fbaReturnCase.findMany({ where: { tenantId, ...store, returnDate: { gte: from } }, select: { amazonOrderId: true }, distinct: ['amazonOrderId'], take })),
    )
  const originalIds = () =>
    orderIdSet('original', async () =>
      toSet(
        (
          await prisma.order.findMany({
            where: { tenantId, ...store, replacedOrderId: { not: null }, purchaseDate: { gte: from } },
            select: { replacedOrderId: true },
            distinct: ['replacedOrderId'],
            take,
          })
        ).map(row => ({ amazonOrderId: row.replacedOrderId })),
      ),
    )
  const transactionIds = (status?: string) =>
    orderIdSet(`tx-${status ?? 'any'}`, async () =>
      toSet(
        await prisma.fbaFinancialTransaction.findMany({
          where: { tenantId, ...store, amazonOrderId: { not: null }, postedAt: { gte: from }, ...(status ? { transactionStatus: status } : {}) },
          select: { amazonOrderId: true },
          distinct: ['amazonOrderId'],
          take,
        }),
      ),
    )

  if (query.status) and.push({ status: query.status })
  if (query.asin || query.sku) and.push({ items: { some: { ...(query.asin ? { asin: query.asin.toUpperCase() } : {}), ...(query.sku ? { sellerSku: query.sku } : {}) } } })
  if (query.promotion !== undefined) and.push(query.promotion ? { items: { some: { promotionDiscount: { gt: 0 } } } } : { items: { none: { promotionDiscount: { gt: 0 } } } })
  if (query.q) and.push({ OR: [{ amazonOrderId: { startsWith: query.q } }, { packages: { some: { trackingNumber: query.q } } }] })
  // 批量搜索：订单号或追踪号精确匹配（上限 500 个词，已由契约校验）
  const terms = splitBatchTerms(query.qs) ?? []
  if (terms.length > 0) and.push({ OR: [{ amazonOrderId: { in: terms } }, { packages: { some: { trackingNumber: { in: terms } } } }] })

  const wantRefund = query.refunded === true || query.risk === 'REFUND'
  if (query.refunded === false) and.push({ amazonOrderId: { notIn: await refundIds() } })
  if (wantRefund) and.push({ amazonOrderId: { in: await refundIds() } })
  if (query.returned === false) and.push({ amazonOrderId: { notIn: await returnIds() } })
  if (query.returned === true || query.risk === 'RETURN') and.push({ amazonOrderId: { in: await returnIds() } })
  if (query.replacement === false) and.push({ isReplacement: false }, { amazonOrderId: { notIn: await originalIds() } })
  if (query.replacement === true || query.risk === 'REPLACEMENT') and.push({ OR: [{ isReplacement: true }, { amazonOrderId: { in: await originalIds() } }] })
  if (query.risk === 'CANCEL_REQUEST') and.push({ cancellations: { some: {} } })

  if (query.settlement === 'NONE') and.push({ amazonOrderId: { notIn: await transactionIds() } })
  if (query.settlement === 'DEFERRED') and.push({ amazonOrderId: { in: await transactionIds('DEFERRED') } })
  if (query.settlement === 'RELEASED') {
    const deferred = await transactionIds('DEFERRED')
    and.push({ amazonOrderId: { in: await transactionIds() } }, { amazonOrderId: { notIn: deferred } })
  }
  return { where: { AND: and }, limited }
}
