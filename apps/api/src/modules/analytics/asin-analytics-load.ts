import { ASIN_PRODUCT_LIMIT, US_MARKETPLACE_ID } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate, dateText } from '../overview'
import type { ProductLite, StockDay } from './asin-analytics-math'

// ASIN 与父体分析的取数（P4-03）：每个查询都带企业与数据范围条件，读取上限 19,999 行 / 查询，多读一行判断是否被截断。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))

const PRODUCT_SELECT = {
  id: true,
  sellerAccountId: true,
  sellerSku: true,
  asin: true,
  parentAsin: true,
  title: true,
  brand: true,
  imageUrl: true,
  categoryPath: true,
  listingStatus: true,
  catalogStatus: true,
  variantAttributes: true,
  ownerUserId: true,
  tagIds: true,
} as const

/** 范围内全部商品目录记录（树的筛选与筛选项都在内存里做）。 */
export async function loadProducts(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<{ products: ProductLite[]; truncated: boolean }> {
  const found = await prisma.fbaProduct.findMany({
    where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) },
    select: PRODUCT_SELECT,
    orderBy: { id: 'asc' },
    take: ASIN_PRODUCT_LIMIT + 1,
  })
  return { products: found.slice(0, ASIN_PRODUCT_LIMIT), truncated: found.length > ASIN_PRODUCT_LIMIT }
}

export interface Family {
  products: ProductLite[]
  /** 只在父子关系表里出现、商品目录里没有记录的子体。 */
  relationOnly: string[]
  variationTheme: string | null
}

/** 一个父体名下的商品：商品目录里父体字段指向它的、它自己的记录，以及父子关系表里的子体。 */
export async function loadFamily(prisma: PrismaService, tenantId: string, scope: ResolvedScope, parentAsin: string): Promise<Family> {
  const [products, relations] = await Promise.all([
    prisma.fbaProduct.findMany({
      where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope), OR: [{ parentAsin }, { asin: parentAsin }] },
      select: PRODUCT_SELECT,
      orderBy: { id: 'asc' },
      take: ASIN_PRODUCT_LIMIT,
    }),
    prisma.productVariantRelation.findMany({
      where: { tenantId, ...storeWhere(scope), parentAsin },
      select: { childAsin: true, variationTheme: true },
      orderBy: { childAsin: 'asc' },
      take: ASIN_PRODUCT_LIMIT,
    }),
  ])
  const theme = relations.find(relation => relation.variationTheme)?.variationTheme ?? null
  return { products, relationOnly: [...new Set(relations.map(relation => relation.childAsin))], variationTheme: theme }
}

export interface SummaryDay {
  stock: Map<string, StockDay>
  ads: Map<string, number> | null
}

/** ASIN 日汇总（订单口径件数、已绑定店铺的广告销售、当天可售库存）：按日合并这些 ASIN 在范围内所有店铺的行。 */
export async function loadSummaryDays(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asins: readonly string[], from: string, to: string): Promise<SummaryDay & { truncated: boolean }> {
  const stock = new Map<string, StockDay>()
  if (asins.length === 0) return { stock, ads: null, truncated: false }
  const found = await prisma.asinDailySummary.findMany({
    where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, currency: 'USD', summaryDate: { gte: asDate(from), lte: asDate(to) } },
    select: { summaryDate: true, units: true, adsSales: true, inventoryAvailable: true },
    orderBy: [{ summaryDate: 'asc' }, { id: 'asc' }],
    take: ASIN_PRODUCT_LIMIT + 1,
  })
  const ads = new Map<string, number>()
  for (const row of found.slice(0, ASIN_PRODUCT_LIMIT)) {
    const date = dateText(row.summaryDate)
    const held = stock.get(date)
    stock.set(date, { units: (held?.units ?? 0) + row.units, available: row.inventoryAvailable === null ? (held?.available ?? null) : (held?.available ?? 0) + row.inventoryAvailable })
    const sales = num(row.adsSales)
    if (sales !== null) ads.set(date, (ads.get(date) ?? 0) + sales)
  }
  return { stock, ads: ads.size > 0 ? ads : null, truncated: found.length > ASIN_PRODUCT_LIMIT }
}

/** 退货件数逐日（按退货日）；这些店铺从没同步过退货记录时返回 null（页面写“尚未接入”，不是 0）。 */
export async function loadReturnsByDay(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asins: readonly string[], from: string, to: string): Promise<Map<string, number> | null> {
  const base = { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) }
  const any = await prisma.fbaReturnCase.findFirst({ where: base, select: { id: true } })
  if (!any) return null
  const result = new Map<string, number>()
  if (asins.length === 0) return result
  const found = await prisma.fbaReturnCase.findMany({
    where: { ...base, asin: { in: [...asins] }, returnDate: { gte: asDate(from), lt: new Date(asDate(to).getTime() + 86_400_000) } },
    select: { returnDate: true, quantity: true },
    orderBy: { id: 'asc' },
    take: ASIN_PRODUCT_LIMIT,
  })
  for (const row of found) result.set(dateText(row.returnDate), (result.get(dateText(row.returnDate)) ?? 0) + row.quantity)
  return result
}

/** 销售排名逐日：同一天有多个分类时取名次最靠前（数值最小）的；没有任何快照返回 null。 */
export async function loadRanksByDay(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asin: string, from: string, to: string): Promise<Map<string, number> | null> {
  const found = await prisma.salesRankSnapshot.findMany({
    where: { tenantId, ...storeWhere(scope), asin, snapshotDate: { gte: asDate(from), lte: asDate(to) } },
    select: { snapshotDate: true, rank: true },
    orderBy: [{ snapshotDate: 'asc' }, { id: 'asc' }],
    take: ASIN_PRODUCT_LIMIT,
  })
  if (found.length === 0) return null
  const result = new Map<string, number>()
  for (const row of found) {
    const date = dateText(row.snapshotDate)
    const held = result.get(date)
    result.set(date, held === undefined ? row.rank : Math.min(held, row.rank))
  }
  return result
}
