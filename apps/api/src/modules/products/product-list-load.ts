import { PRODUCT_LIST_LIMIT, STORE_LEVEL_SKU, US_MARKETPLACE_ID, type ProductFilterOptions } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { FORMER_MEMBER_LABEL, memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate } from '../overview'
import { profitWhere } from '../profit'
import { distinctTags, salesKey, skuKey, type MarginFact, type ProductRecord, type SalesFact } from './product-list-math'

// 商品列表的取数（P4-07）：每个查询都带企业与数据范围条件；读取上限 19,999 行，多读一行判断是否被截断。
// 销售与利润用数据库汇总（groupBy），不把明细行读回来再加；库存可售数量按店铺 × SKU 读最近一次接口快照。

const OPTION_LIMIT = 300
const TAG_SCAN_LIMIT = 5000
const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const baseWhere = (tenantId: string, scope: ResolvedScope): Prisma.FbaProductWhereInput => ({ tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) })

/** 按条件取商品记录（含店铺名）；多读一行用来判断是否被截断。 */
export async function loadProducts(prisma: PrismaService, where: Prisma.FbaProductWhereInput): Promise<{ records: ProductRecord[]; truncated: boolean }> {
  const found = await prisma.fbaProduct.findMany({
    where,
    select: {
      id: true,
      sellerAccountId: true,
      asin: true,
      sellerSku: true,
      fnsku: true,
      title: true,
      imageUrl: true,
      parentAsin: true,
      brand: true,
      categoryPath: true,
      fulfillmentChannel: true,
      listingStatus: true,
      price: true,
      currency: true,
      ownerUserId: true,
      tagIds: true,
      version: true,
      updatedAt: true,
      catalogStatus: true,
      sellerAccount: { select: { displayName: true } },
    },
    orderBy: [{ id: 'asc' }],
    take: PRODUCT_LIST_LIMIT + 1,
  })
  const records = found.slice(0, PRODUCT_LIST_LIMIT).map(({ sellerAccount, price, ...rest }) => ({ ...rest, price: num(price), storeName: sellerAccount.displayName }))
  return { records, truncated: found.length > PRODUCT_LIST_LIMIT }
}

/** 近 30 天订单口径销量与销售额（美元），按店铺 × ASIN 汇总。 */
export async function loadSales(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asins: readonly string[], from: string, to: string): Promise<Map<string, SalesFact>> {
  const result = new Map<string, SalesFact>()
  if (asins.length === 0) return result
  const groups = await prisma.asinDailySummary.groupBy({
    by: ['sellerAccountId', 'asin'],
    where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, currency: 'USD', summaryDate: { gte: asDate(from), lte: asDate(to) } },
    _sum: { units: true, salesAmount: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
    take: PRODUCT_LIST_LIMIT,
  })
  for (const group of groups) result.set(salesKey(group.sellerAccountId, group.asin), { amount: num(group._sum.salesAmount) ?? 0, units: group._sum.units ?? 0 })
  return result
}

/** 店铺 × SKU 的可售数量（库存接口最近一次同步值）。 */
export async function loadSellable(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<Map<string, number>> {
  const rows = await prisma.fbaInventoryRecord.findMany({
    where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) },
    select: { sellerAccountId: true, sellerSku: true, fulfillableQuantity: true },
    orderBy: [{ id: 'asc' }],
    take: PRODUCT_LIST_LIMIT,
  })
  return new Map(rows.map(row => [skuKey(row.sellerAccountId, row.sellerSku), row.fulfillableQuantity]))
}

/** 近 30 天下单口径的利润合计，按店铺 × SKU；整组净利润在有任何一天缺成本时为 null（与利润分析一致）。 */
export async function loadMargins(prisma: PrismaService, tenantId: string, scope: ResolvedScope, from: string, to: string): Promise<Map<string, MarginFact>> {
  const where: Prisma.ProfitDailyWhereInput = { ...profitWhere(tenantId, scope, 'ORDERED', from, to), sku: { not: STORE_LEVEL_SKU } }
  const order = [{ sellerAccountId: 'asc' }, { sku: 'asc' }] as const
  const [groups, missing] = await Promise.all([
    prisma.profitDaily.groupBy({ by: ['sellerAccountId', 'sku'], where, _sum: { revenue: true, profit: true }, _count: { _all: true }, orderBy: [...order], take: PRODUCT_LIST_LIMIT }),
    prisma.profitDaily.groupBy({ by: ['sellerAccountId', 'sku'], where: { ...where, profit: null }, _count: { _all: true }, orderBy: [...order], take: PRODUCT_LIST_LIMIT }),
  ])
  const gaps = new Set(missing.map(group => skuKey(group.sellerAccountId, group.sku)))
  return new Map(
    groups.map(group => {
      const key = skuKey(group.sellerAccountId, group.sku)
      return [key, { rows: group._count._all, revenue: num(group._sum.revenue) ?? 0, profit: gaps.has(key) ? null : (num(group._sum.profit) ?? 0) }]
    }),
  )
}

/** 当前成员已关注的商品编号（只查传入的这一批）。 */
export async function loadWatched(prisma: PrismaService, tenantId: string, userId: string, ids: readonly string[], entityType: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await prisma.watch.findMany({ where: { tenantId, userId, entityType, entityId: { in: [...ids] } }, select: { entityId: true }, take: ids.length })
  return new Set(rows.map(row => row.entityId))
}

/** 当前成员关注的全部商品编号（“只看已关注”用）。 */
export async function loadWatchedIds(prisma: PrismaService, tenantId: string, userId: string, entityType: string): Promise<string[]> {
  const rows = await prisma.watch.findMany({ where: { tenantId, userId, entityType }, select: { entityId: true }, orderBy: [{ id: 'asc' }], take: 2000 })
  return rows.map(row => row.entityId)
}

/** 筛选下拉：只看可见范围内已有的品牌、类目、状态、标签、负责人（不随当前筛选变化，避免选了一项其他选项就消失）。 */
export async function loadFilterOptions(prisma: PrismaService, base: Prisma.FbaProductWhereInput, tenantId: string): Promise<ProductFilterOptions> {
  const [brands, categories, statuses, tagRows, owners] = await Promise.all([
    prisma.fbaProduct.groupBy({ by: ['brand'], where: { ...base, brand: { not: null } }, orderBy: { brand: 'asc' }, take: OPTION_LIMIT }),
    prisma.fbaProduct.groupBy({ by: ['categoryPath'], where: { ...base, categoryPath: { not: null } }, orderBy: { categoryPath: 'asc' }, take: OPTION_LIMIT }),
    prisma.fbaProduct.groupBy({ by: ['listingStatus'], where: base, orderBy: { listingStatus: 'asc' }, take: 50 }),
    prisma.fbaProduct.findMany({ where: { ...base, tagIds: { isEmpty: false } }, select: { tagIds: true }, orderBy: [{ id: 'asc' }], take: TAG_SCAN_LIMIT }),
    prisma.fbaProduct.groupBy({ by: ['ownerUserId'], where: { ...base, ownerUserId: { not: null } }, orderBy: { ownerUserId: 'asc' }, take: 200 }),
  ])
  const ownerIds = owners.flatMap(group => (group.ownerUserId ? [group.ownerUserId] : []))
  const names = await memberNames(prisma, tenantId, ownerIds)
  return {
    brands: brands.flatMap(group => (group.brand ? [group.brand] : [])).sort(byText),
    categories: categories.flatMap(group => (group.categoryPath ? [group.categoryPath] : [])).sort(byText),
    statuses: statuses.map(group => group.listingStatus),
    tags: distinctTags(tagRows, 200),
    owners: ownerIds.map(id => ({ id, name: names.get(id) ?? FORMER_MEMBER_LABEL })).sort((a, b) => byText(a.name, b.name)),
  }
}

/** 可设置的负责人候选：企业在职成员。 */
export async function activeMembers(prisma: PrismaService, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.membership.findMany({
    where: { tenantId, status: 'ACTIVE' },
    select: { userId: true, user: { select: { displayName: true, email: true } } },
    orderBy: [{ userId: 'asc' }],
    take: 200,
  })
  return rows.map(row => ({ id: row.userId, name: row.user.displayName || row.user.email })).sort((a, b) => byText(a.name, b.name))
}
