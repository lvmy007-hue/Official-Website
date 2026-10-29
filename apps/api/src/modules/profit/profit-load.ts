import { PROFIT_GROUP_LIMIT, STORE_LEVEL_SKU } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate, dateText } from '../overview'
import { SUM_SELECT, totalsOf, type Totals } from './profit-aggregate'

// 利润分析的取数（P2b-10）：只读利润日表（P2b-09 派生），一律带企业、收入确认口径、日期范围与数据范围条件。
// 用数据库汇总（aggregate / groupBy）而不是把行读回来再加：行数可达数十万，Prisma 单次读取上限 20000。
// “因缺成本算不出利润”的行数另查一次（profit 为空的行），合计里只要有一行算不出，整体净利润就不给。

export function profitWhere(tenantId: string, scope: ResolvedScope, basis: string, from: string, to: string): Prisma.ProfitDailyWhereInput {
  return { tenantId, basis, ...storeWhere(scope), profitDate: { gte: asDate(from), lte: asDate(to) } }
}
const incomplete = (where: Prisma.ProfitDailyWhereInput): Prisma.ProfitDailyWhereInput => ({ ...where, profit: null })

/** 整个范围的合计（含店铺级行）。 */
export async function loadTotals(prisma: PrismaService, where: Prisma.ProfitDailyWhereInput): Promise<Totals> {
  const [sum, missing] = await Promise.all([prisma.profitDaily.aggregate({ where, _sum: SUM_SELECT, _count: { _all: true } }), prisma.profitDaily.count({ where: incomplete(where) })])
  return totalsOf(sum._sum, sum._count._all, missing)
}

/** 店铺级行（没有 SKU 的费用与账户级广告）的合计；一行都没有时为 null。 */
export async function loadStoreLevelTotals(prisma: PrismaService, where: Prisma.ProfitDailyWhereInput): Promise<Totals | null> {
  const totals = await loadTotals(prisma, { ...where, sku: STORE_LEVEL_SKU })
  return totals.rows === 0 ? null : totals
}

export async function loadTotalsByStore(prisma: PrismaService, where: Prisma.ProfitDailyWhereInput): Promise<Map<string, Totals>> {
  const [groups, missing] = await Promise.all([
    prisma.profitDaily.groupBy({ by: ['sellerAccountId'], where, _sum: SUM_SELECT, _count: { _all: true }, orderBy: { sellerAccountId: 'asc' }, take: 500 }),
    prisma.profitDaily.groupBy({ by: ['sellerAccountId'], where: incomplete(where), _count: { _all: true }, orderBy: { sellerAccountId: 'asc' }, take: 500 }),
  ])
  const gaps = new Map(missing.map(group => [group.sellerAccountId, group._count._all]))
  return new Map(groups.map(group => [group.sellerAccountId, totalsOf(group._sum, group._count._all, gaps.get(group.sellerAccountId) ?? 0)]))
}

export async function loadTotalsByDate(prisma: PrismaService, where: Prisma.ProfitDailyWhereInput): Promise<Array<{ date: string; totals: Totals }>> {
  const [groups, missing] = await Promise.all([
    prisma.profitDaily.groupBy({ by: ['profitDate'], where, _sum: SUM_SELECT, _count: { _all: true }, orderBy: { profitDate: 'asc' }, take: 1200 }),
    prisma.profitDaily.groupBy({ by: ['profitDate'], where: incomplete(where), _count: { _all: true }, orderBy: { profitDate: 'asc' }, take: 1200 }),
  ])
  const gaps = new Map(missing.map(group => [dateText(group.profitDate), group._count._all]))
  return groups.map(group => {
    const date = dateText(group.profitDate)
    return { date, totals: totalsOf(group._sum, group._count._all, gaps.get(date) ?? 0) }
  })
}

/** 店铺 × SKU × ASIN 的一个分组；memberKey 用来把成本折算明细对回所属分组。 */
export interface SkuGroup {
  memberKey: string
  sellerAccountId: string
  sku: string
  asin: string | null
  totals: Totals
}
/** 分隔符用不会出现在 SKU 里的控制字符（SKU 里可能有竖线）。 */
export const MEMBER_SEP = '\u001f'
export const memberKeyOf = (sellerAccountId: string, sku: string, asin: string | null) => [sellerAccountId, sku, asin ?? ''].join(MEMBER_SEP)

/** 不含店铺级行的 SKU 分组；超过读取上限时只取排在前面的并标记不完整。 */
export async function loadSkuGroups(prisma: PrismaService, where: Prisma.ProfitDailyWhereInput): Promise<{ groups: SkuGroup[]; truncated: boolean }> {
  const scoped = { ...where, sku: { not: STORE_LEVEL_SKU } }
  const order = [{ sellerAccountId: 'asc' }, { sku: 'asc' }, { asin: 'asc' }] as const
  const [groups, missing] = await Promise.all([
    prisma.profitDaily.groupBy({ by: ['sellerAccountId', 'sku', 'asin'], where: scoped, _sum: SUM_SELECT, _count: { _all: true }, orderBy: [...order], take: PROFIT_GROUP_LIMIT + 1 }),
    prisma.profitDaily.groupBy({ by: ['sellerAccountId', 'sku', 'asin'], where: incomplete(scoped), _count: { _all: true }, orderBy: [...order], take: PROFIT_GROUP_LIMIT + 1 }),
  ])
  const gaps = new Map(missing.map(group => [memberKeyOf(group.sellerAccountId, group.sku, group.asin), group._count._all]))
  const truncated = groups.length > PROFIT_GROUP_LIMIT
  return {
    truncated,
    groups: groups.slice(0, PROFIT_GROUP_LIMIT).map(group => {
      const memberKey = memberKeyOf(group.sellerAccountId, group.sku, group.asin)
      return { memberKey, sellerAccountId: group.sellerAccountId, sku: group.sku, asin: group.asin, totals: totalsOf(group._sum, group._count._all, gaps.get(memberKey) ?? 0) }
    }),
  }
}

export async function loadStoreNames(prisma: PrismaService, tenantId: string, scope: ResolvedScope, ids?: readonly string[]): Promise<Map<string, string>> {
  const rows = await prisma.sellerAccount.findMany({
    where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }), ...(ids ? { id: { in: [...ids] } } : {}) },
    select: { id: true, displayName: true },
    orderBy: { displayName: 'asc' },
    take: 500,
  })
  return new Map(rows.map(row => [row.id, row.displayName]))
}

export interface ProductMeta {
  id: string
  sellerAccountId: string
  sellerSku: string
  asin: string
  title: string
  parentAsin: string | null
}

/** 商品标题、父体与编号：按 SKU 或 ASIN 批量取，同一个键有多条时取编号小的（稳定）。 */
export async function loadProducts(prisma: PrismaService, tenantId: string, scope: ResolvedScope, filter: { skus?: readonly string[]; asins?: readonly string[] }): Promise<ProductMeta[]> {
  const or: Prisma.FbaProductWhereInput[] = []
  if (filter.skus?.length) or.push({ sellerSku: { in: [...filter.skus] } })
  if (filter.asins?.length) or.push({ asin: { in: [...filter.asins] } })
  if (or.length === 0) return []
  return prisma.fbaProduct.findMany({
    where: { tenantId, ...storeWhere(scope), OR: or },
    select: { id: true, sellerAccountId: true, sellerSku: true, asin: true, title: true, parentAsin: true },
    orderBy: { id: 'asc' },
    take: PROFIT_GROUP_LIMIT,
  })
}
