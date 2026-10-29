import { PP_UNIT_LIMIT, US_MARKETPLACE_ID } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate } from '../overview'
import { loadSkuGroups, profitWhere, type SkuGroup } from '../profit'
import type { Facts } from './product-performance-math'

// 商品表现宽表的取数（P6-22）：全部用数据库汇总（groupBy），不把逐日行读回来；每个查询都带企业与数据范围条件，多读一行判断是否被截断。
// 来源：ASIN 日汇总（销量、销售额、流量、广告）、销售与流量 ASIN 日表（订单量、B2B；同键两个来源只留数据中心）、利润日表（按订单口径）、商品目录（维度属性）。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
export const unitKey = (storeId: string, asin: string) => `${storeId}|${asin}`

export interface ProductRef {
  id: string
  storeId: string
  storeName: string
  asin: string
  sku: string
  title: string
  imageUrl: string | null
  parentAsin: string | null
  brand: string | null
  category: string | null
  ownerUserId: string | null
}

export const catalogWhere = (tenantId: string, scope: ResolvedScope): Prisma.FbaProductWhereInput => ({ tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) })

const PRODUCT_SELECT = {
  id: true,
  sellerAccountId: true,
  asin: true,
  sellerSku: true,
  title: true,
  imageUrl: true,
  parentAsin: true,
  brand: true,
  categoryPath: true,
  ownerUserId: true,
  sellerAccount: { select: { displayName: true } },
} as const

type ProductRecord = Prisma.FbaProductGetPayload<{ select: typeof PRODUCT_SELECT }>
const refOf = (row: ProductRecord): ProductRef => ({
  id: row.id,
  storeId: row.sellerAccountId,
  storeName: row.sellerAccount.displayName,
  asin: row.asin,
  sku: row.sellerSku,
  title: row.title,
  imageUrl: row.imageUrl,
  parentAsin: row.parentAsin,
  brand: row.brand,
  category: row.categoryPath,
  ownerUserId: row.ownerUserId,
})

/** 范围内的商品目录（按店铺、SKU 排序，同一个 店铺 × ASIN 取 SKU 最小的那条做代表）。 */
export async function loadCatalog(prisma: PrismaService, where: Prisma.FbaProductWhereInput): Promise<{ products: ProductRef[]; truncated: boolean }> {
  const found = await prisma.fbaProduct.findMany({ where, select: PRODUCT_SELECT, orderBy: [{ sellerAccountId: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }], take: PP_UNIT_LIMIT + 1 })
  return { products: found.slice(0, PP_UNIT_LIMIT).map(refOf), truncated: found.length > PP_UNIT_LIMIT }
}

export interface PeriodFacts {
  facts: Map<string, Facts>
  profit: SkuGroup[]
  truncated: boolean
}

/** 一段时间内每个 店铺 × ASIN 的销售、流量、广告事实。 */
async function loadFacts(prisma: PrismaService, tenantId: string, scope: ResolvedScope, from: string, to: string): Promise<{ facts: Map<string, Facts>; truncated: boolean }> {
  const range = { gte: asDate(from), lte: asDate(to) }
  const [summary, traffic] = await Promise.all([
    prisma.asinDailySummary.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: { tenantId, ...storeWhere(scope), currency: 'USD', summaryDate: range },
      _sum: { units: true, salesAmount: true, sessions: true, pageViews: true, adsSpend: true, adsSales: true },
      _avg: { buyBoxPct: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: PP_UNIT_LIMIT + 1,
    }),
    prisma.salesTrafficAsinDaily.groupBy({
      by: ['sellerAccountId', 'asin', 'source'],
      where: { tenantId, ...storeWhere(scope), asinGranularity: 'CHILD', currency: 'USD', date: range },
      _sum: { ordersCount: true, b2bSales: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { source: 'asc' }],
      take: PP_UNIT_LIMIT + 1,
    }),
  ])
  const facts = new Map<string, Facts>()
  for (const row of summary.slice(0, PP_UNIT_LIMIT)) {
    facts.set(unitKey(row.sellerAccountId, row.asin), {
      units: row._sum.units,
      orders: null,
      sales: num(row._sum.salesAmount),
      b2bSales: null,
      sessions: row._sum.sessions,
      pageViews: row._sum.pageViews,
      buyBox: num(row._avg.buyBoxPct),
      adSpend: num(row._sum.adsSpend),
      adSales: num(row._sum.adsSales),
    })
  }
  // 同键两个来源只留数据中心的（没有才用报告补充）
  const best = new Map<string, (typeof traffic)[number]>()
  for (const row of traffic.slice(0, PP_UNIT_LIMIT)) {
    const key = unitKey(row.sellerAccountId, row.asin)
    const held = best.get(key)
    if (!held || (row.source === 'DATA_KIOSK' && held.source !== 'DATA_KIOSK')) best.set(key, row)
  }
  for (const [key, row] of best) {
    const orders = row._sum.ordersCount
    const b2b = num(row._sum.b2bSales)
    if (orders === null && b2b === null) continue
    const held = facts.get(key)
    facts.set(key, { ...(held ?? { units: null, sales: null, sessions: null, pageViews: null, buyBox: null, adSpend: null, adSales: null }), orders, b2bSales: b2b })
  }
  return { facts, truncated: summary.length > PP_UNIT_LIMIT || traffic.length > PP_UNIT_LIMIT }
}

/** 一段时间的全部事实；没有利润权限（`withProfit` 为 false）时不读利润日表。 */
export async function loadPeriod(prisma: PrismaService, tenantId: string, scope: ResolvedScope, from: string, to: string, withProfit: boolean): Promise<PeriodFacts> {
  const [base, profit] = await Promise.all([
    loadFacts(prisma, tenantId, scope, from, to),
    withProfit ? loadSkuGroups(prisma, profitWhere(tenantId, scope, 'ORDERED', from, to)) : Promise.resolve({ groups: [] as SkuGroup[], truncated: false }),
  ])
  return { facts: base.facts, profit: profit.groups, truncated: base.truncated || profit.truncated }
}
