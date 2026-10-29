import { LISTING_PERF_LIMIT, US_MARKETPLACE_ID, type ListingFilterOptions } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { FORMER_MEMBER_LABEL, memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate, dateText } from '../overview'
import { factKey, skuKey, type DailyGroup, type ProductRecord, type TrafficGroup } from './listing-perf-math'

// 刊登表现的取数（P4-09）：每个查询都带企业与数据范围条件，只取美元行；读取上限 19,999 行，多读一行判断是否被截断。
// 销售与流量用数据库汇总（groupBy），不把明细行读回来再加。官方没给的列是空（不是 0），这里原样带回 null。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const CURRENCY = 'USD'
const OPTION_LIMIT = 300

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
      title: true,
      imageUrl: true,
      brand: true,
      fulfillmentChannel: true,
      listingStatus: true,
      price: true,
      currency: true,
      ownerUserId: true,
      updatedAt: true,
      sellerAccount: { select: { displayName: true } },
    },
    orderBy: [{ id: 'asc' }],
    take: LISTING_PERF_LIMIT + 1,
  })
  const records = found.slice(0, LISTING_PERF_LIMIT).map(({ sellerAccount, price, ...rest }) => ({ ...rest, price: num(price), storeName: sellerAccount.displayName }))
  return { records, truncated: found.length > LISTING_PERF_LIMIT }
}

/** 一段日期里按 店铺 × ASIN × 来源 汇总的销售与流量（子体粒度、美元）。 */
export async function loadTraffic(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  asins: readonly string[],
  from: string,
  to: string,
): Promise<{ groups: TrafficGroup[]; truncated: boolean }> {
  if (asins.length === 0) return { groups: [], truncated: false }
  const found = await prisma.salesTrafficAsinDaily.groupBy({
    by: ['sellerAccountId', 'asin', 'source'],
    where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, asinGranularity: 'CHILD', currency: CURRENCY, date: { gte: asDate(from), lte: asDate(to) } },
    _sum: { orderedSales: true, units: true, sessions: true, pageViews: true },
    _avg: { buyBoxPct: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { source: 'asc' }],
    take: LISTING_PERF_LIMIT + 1,
  })
  const groups = found.slice(0, LISTING_PERF_LIMIT).map<TrafficGroup>(group => ({
    sellerAccountId: group.sellerAccountId,
    asin: group.asin,
    source: group.source,
    sessions: group._sum.sessions,
    pageViews: group._sum.pageViews,
    units: group._sum.units,
    sales: num(group._sum.orderedSales),
    buyBox: num(group._avg.buyBoxPct),
  }))
  return { groups, truncated: found.length > LISTING_PERF_LIMIT }
}

/** 逐日趋势用的汇总：按 店铺 × 日 × 来源，只含这些 ASIN。 */
export async function loadDaily(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  asins: readonly string[],
  from: string,
  to: string,
): Promise<{ groups: DailyGroup[]; truncated: boolean }> {
  if (asins.length === 0) return { groups: [], truncated: false }
  const found = await prisma.salesTrafficAsinDaily.groupBy({
    by: ['sellerAccountId', 'date', 'source'],
    where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, asinGranularity: 'CHILD', currency: CURRENCY, date: { gte: asDate(from), lte: asDate(to) } },
    _sum: { orderedSales: true, units: true, sessions: true, pageViews: true, buyBoxPct: true },
    _count: { buyBoxPct: true },
    orderBy: [{ date: 'asc' }, { sellerAccountId: 'asc' }, { source: 'asc' }],
    take: LISTING_PERF_LIMIT + 1,
  })
  const groups = found.slice(0, LISTING_PERF_LIMIT).map<DailyGroup>(group => ({
    sellerAccountId: group.sellerAccountId,
    date: dateText(group.date),
    source: group.source,
    sessions: group._sum.sessions,
    pageViews: group._sum.pageViews,
    units: group._sum.units,
    sales: num(group._sum.orderedSales),
    buyBoxSum: num(group._sum.buyBoxPct),
    buyBoxCount: group._count.buyBoxPct,
  }))
  return { groups, truncated: found.length > LISTING_PERF_LIMIT }
}

/** 范围内每个 店铺 × ASIN 的广告销售额（ASIN 日汇总里已绑定店铺的美元广告销售额）；只返回有值的，一个都没有就是空表。 */
export async function loadAdsSales(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asins: readonly string[], from: string, to: string): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (asins.length === 0) return result
  const groups = await prisma.asinDailySummary.groupBy({
    by: ['sellerAccountId', 'asin'],
    where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, currency: CURRENCY, adsSales: { not: null }, summaryDate: { gte: asDate(from), lte: asDate(to) } },
    _sum: { adsSales: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
    take: LISTING_PERF_LIMIT,
  })
  for (const group of groups) {
    const value = num(group._sum.adsSales)
    if (value !== null) result.set(factKey(group.sellerAccountId, group.asin), value)
  }
  return result
}

/** 范围最后几天每个 店铺 × ASIN 的订购件数（订单口径的 ASIN 日汇总，可售天数用）。 */
export async function loadRecentUnits(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asins: readonly string[], from: string, to: string): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (asins.length === 0) return result
  const groups = await prisma.asinDailySummary.groupBy({
    by: ['sellerAccountId', 'asin'],
    where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, currency: CURRENCY, summaryDate: { gte: asDate(from), lte: asDate(to) } },
    _sum: { units: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
    take: LISTING_PERF_LIMIT,
  })
  for (const group of groups) if (group._sum.units !== null) result.set(factKey(group.sellerAccountId, group.asin), group._sum.units)
  return result
}

/** 范围内每个 店铺 × ASIN 的退货件数（按退货日）；这些店铺从没同步过退货记录时返回 null（页面写“尚未接入”，不是 0）。 */
export async function loadReturns(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asins: readonly string[], from: string, to: string): Promise<Map<string, number> | null> {
  const base = { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) }
  const any = await prisma.fbaReturnCase.findFirst({ where: base, select: { id: true } })
  if (!any) return null
  const result = new Map<string, number>()
  if (asins.length === 0) return result
  const groups = await prisma.fbaReturnCase.groupBy({
    by: ['sellerAccountId', 'asin'],
    where: { ...base, asin: { in: [...asins] }, returnDate: { gte: asDate(from), lt: new Date(asDate(to).getTime() + 86_400_000) } },
    _sum: { quantity: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
    take: LISTING_PERF_LIMIT,
  })
  for (const group of groups) result.set(factKey(group.sellerAccountId, group.asin), group._sum.quantity ?? 0)
  return result
}

/** 店铺 × SKU 的可售数量（库存接口最近一次同步值）。 */
export async function loadSellable(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<Map<string, number>> {
  const rows = await prisma.fbaInventoryRecord.findMany({
    where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) },
    select: { sellerAccountId: true, sellerSku: true, fulfillableQuantity: true },
    orderBy: [{ id: 'asc' }],
    take: LISTING_PERF_LIMIT,
  })
  return new Map(rows.map(row => [skuKey(row.sellerAccountId, row.sellerSku), row.fulfillableQuantity]))
}

/** 筛选下拉：只看可见范围内已有的品牌、类目、状态、负责人（不随当前筛选变化，避免选了一项其他选项就消失）。 */
export async function loadFilterOptions(prisma: PrismaService, base: Prisma.FbaProductWhereInput, tenantId: string): Promise<ListingFilterOptions> {
  const [brands, categories, statuses, owners] = await Promise.all([
    prisma.fbaProduct.groupBy({ by: ['brand'], where: { ...base, brand: { not: null } }, orderBy: { brand: 'asc' }, take: OPTION_LIMIT }),
    prisma.fbaProduct.groupBy({ by: ['categoryPath'], where: { ...base, categoryPath: { not: null } }, orderBy: { categoryPath: 'asc' }, take: OPTION_LIMIT }),
    prisma.fbaProduct.groupBy({ by: ['listingStatus'], where: base, orderBy: { listingStatus: 'asc' }, take: 50 }),
    prisma.fbaProduct.groupBy({ by: ['ownerUserId'], where: { ...base, ownerUserId: { not: null } }, orderBy: { ownerUserId: 'asc' }, take: 200 }),
  ])
  const ownerIds = owners.flatMap(group => (group.ownerUserId ? [group.ownerUserId] : []))
  const names = await memberNames(prisma, tenantId, ownerIds)
  return {
    brands: brands.flatMap(group => (group.brand ? [group.brand] : [])).sort(byText),
    categories: categories.flatMap(group => (group.categoryPath ? [group.categoryPath] : [])).sort(byText),
    statuses: statuses.map(group => group.listingStatus),
    owners: ownerIds.map(id => ({ id, name: names.get(id) ?? FORMER_MEMBER_LABEL })).sort((a, b) => byText(a.name, b.name)),
  }
}
