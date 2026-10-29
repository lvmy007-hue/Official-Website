import { dispositionCodesOf, type ReturnListQuery } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { ID_SET_LIMIT } from '../orders'

// 退货列表的筛选条件（P2b-02）。
// 订单号前缀、退货件编号、ASIN、SKU、原因、处置分组直接落到退货表上；“是否已退款”要看财务交易：
// 先在“不早于筛选起始时间前 180 天”的范围内找出有退款交易的订单号（有上限），再用订单号去过滤退货；
// 订单号触到上限时 limited = true，页面提示“结果可能不完整”，不假装精确（与订单页同一做法）。

/** 退款可能早于收到退货，所以退款交易的回看起点比退货日期范围早这么多天。 */
const REFUND_LOOKBACK_MS = 180 * 86_400_000

export type BuiltReturnFilters = { where: Prisma.FbaReturnCaseWhereInput; limited: boolean }

export async function buildReturnFilters(prisma: PrismaService, input: { tenantId: string; scope: ResolvedScope; query: ReturnListQuery; from: Date; to: Date }): Promise<BuiltReturnFilters> {
  const { tenantId, scope, query, from, to } = input
  const store = storeWhere(scope)
  const and: Prisma.FbaReturnCaseWhereInput[] = [{ tenantId, ...store, returnDate: { gte: from, lt: to } }]
  let limited = false

  if (query.q) and.push({ OR: [{ amazonOrderId: { startsWith: query.q } }, { licensePlateNumber: query.q }] })
  if (query.asin) and.push({ asin: query.asin.toUpperCase() })
  if (query.sku) and.push({ sellerSku: query.sku })
  if (query.reason) and.push({ reason: { equals: query.reason, mode: 'insensitive' } })
  if (query.disposition) {
    const codes = dispositionCodesOf(query.disposition)
    // 旧导入器写入的行没有分组列以外的信息：detailedDisposition 已由迁移回填，这里只认它
    and.push({ detailedDisposition: { in: codes, mode: 'insensitive' } })
  }
  if (query.refunded !== undefined) {
    const rows = await prisma.fbaFinancialTransaction.findMany({
      where: { tenantId, ...store, transactionType: { contains: 'refund', mode: 'insensitive' }, amazonOrderId: { not: null }, postedAt: { gte: new Date(from.getTime() - REFUND_LOOKBACK_MS) } },
      select: { amazonOrderId: true },
      distinct: ['amazonOrderId'],
      take: ID_SET_LIMIT,
    })
    limited = rows.length >= ID_SET_LIMIT
    const ids = rows.flatMap(row => (row.amazonOrderId ? [row.amazonOrderId] : []))
    and.push({ amazonOrderId: query.refunded ? { in: ids } : { notIn: ids } })
  }
  return { where: { AND: and }, limited }
}
