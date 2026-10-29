import { PRICING_LIMITS, priceUnitOf, type PriceUnit } from '@nova/api-contracts'
import type { CompetitiveSummarySnapshot, FeaturedOfferExpectedPrice, Prisma, PriceSnapshot } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'

// 定价取数（P4-11）：价格类快照只在价格变化或每 24 小时写一次，所以“最近一次”只看 3 天内的行；利润与流量只读汇总。一律带企业与数据范围条件。

export const ROW_CAP = 20_000
export const PRODUCT_CAP = 5000
export const SEP = '\u001f'
export const keyOf = (storeId: string, value: string) => `${storeId}${SEP}${value}`
export const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`)

export const ymd = (date: Date): string => date.toISOString().slice(0, 10)
export const daysAgo = (now: Date, days: number): Date => new Date(now.getTime() - days * 86_400_000)

/** 每个键只留最近的一行（输入需按时间倒序）。 */
export function firstBy<T>(rows: readonly T[], keyFn: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) if (!map.has(keyFn(row))) map.set(keyFn(row), row)
  return map
}

export interface ProductRow {
  id: string
  sellerAccountId: string
  sellerSku: string
  asin: string
  title: string
  imageUrl: string | null
  productType: string | null
}
const PRODUCT_SELECT = { id: true, sellerAccountId: true, sellerSku: true, asin: true, title: true, imageUrl: true, productType: true } as const

export async function loadProducts(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  filter: { q?: string; storeId?: string; sku?: string },
): Promise<{ rows: ProductRow[]; truncated: boolean }> {
  const where: Prisma.FbaProductWhereInput = { tenantId, ...storeWhere(scope), ...(filter.storeId ? { sellerAccountId: filter.storeId } : {}), ...(filter.sku ? { sellerSku: filter.sku } : {}) }
  if (filter.q) {
    where.OR = [{ title: { contains: filter.q, mode: 'insensitive' } }, { sellerSku: { contains: filter.q, mode: 'insensitive' } }, { asin: { contains: filter.q, mode: 'insensitive' } }]
  }
  const rows = await prisma.fbaProduct.findMany({ where, select: PRODUCT_SELECT, orderBy: [{ sellerAccountId: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }], take: PRODUCT_CAP + 1 })
  return { rows: rows.slice(0, PRODUCT_CAP), truncated: rows.length > PRODUCT_CAP }
}

export interface PriceFact {
  price: number
  currency: string
  observedAt: Date
  asin: string
  /** 窗口内最近一次价格变化：变化后的第一次观察时间与变化前的价格。 */
  change: { at: Date; from: number } | null
}

/** 窗口内每个 SKU 的最近价格，以及最近一次价格变化。 */
export async function loadLatestPrices(prisma: PrismaService, tenantId: string, storeIds: readonly string[], now: Date, onlySku?: string): Promise<Map<string, PriceFact>> {
  const rows = await prisma.priceSnapshot.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, ...(onlySku ? { sellerSku: onlySku } : {}), observedAt: { gte: new Date(now.getTime() - PRICING_LIMITS.freshWindowMs) } },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take: ROW_CAP,
  })
  const bySku = new Map<string, PriceSnapshot[]>()
  for (const row of rows) {
    const key = keyOf(row.sellerAccountId, row.sellerSku)
    const list = bySku.get(key)
    if (list) list.push(row)
    else bySku.set(key, [row])
  }
  const out = new Map<string, PriceFact>()
  for (const [key, list] of bySku) {
    const latest = list[0]!
    const price = Number(latest.price.toString())
    const index = list.findIndex(row => Math.abs(Number(row.price.toString()) - price) >= 0.005)
    out.set(key, {
      price,
      currency: latest.currency,
      observedAt: latest.observedAt,
      asin: latest.asin,
      change: index > 0 ? { at: list[index - 1]!.observedAt, from: Number(list[index]!.price.toString()) } : null,
    })
  }
  return out
}

export async function loadLatestExpected(prisma: PrismaService, tenantId: string, storeIds: readonly string[], now: Date, onlySku?: string): Promise<Map<string, FeaturedOfferExpectedPrice>> {
  const rows = await prisma.featuredOfferExpectedPrice.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, ...(onlySku ? { sellerSku: onlySku } : {}), observedAt: { gte: new Date(now.getTime() - PRICING_LIMITS.freshWindowMs) } },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take: ROW_CAP,
  })
  return firstBy(rows, row => keyOf(row.sellerAccountId, row.sellerSku))
}

export async function loadLatestSummaries(prisma: PrismaService, tenantId: string, storeIds: readonly string[], now: Date, onlyAsin?: string): Promise<Map<string, CompetitiveSummarySnapshot>> {
  const rows = await prisma.competitiveSummarySnapshot.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, ...(onlyAsin ? { asin: onlyAsin } : {}), observedAt: { gte: new Date(now.getTime() - PRICING_LIMITS.freshWindowMs) } },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take: ROW_CAP,
  })
  return firstBy(rows, row => keyOf(row.sellerAccountId, row.asin))
}

/** 近 30 天每个 SKU 的每件经济（下单口径利润日表）：有任何一行缺成本算不出利润就不给，并带上原因。 */
export async function loadUnits(prisma: PrismaService, tenantId: string, scope: ResolvedScope, now: Date, sku?: string): Promise<Map<string, ReturnType<typeof priceUnitOf>>> {
  const where: Prisma.ProfitDailyWhereInput = { tenantId, ...storeWhere(scope), basis: 'ORDERED', profitDate: { gte: asDate(ymd(daysAgo(now, 30))) }, sku: sku ? sku : { not: '' } }
  const order = [{ sellerAccountId: 'asc' }, { sku: 'asc' }] as const
  const [sums, gaps] = await Promise.all([
    prisma.profitDaily.groupBy({
      by: ['sellerAccountId', 'sku'],
      where,
      _sum: { units: true, revenue: true, refunds: true, feeCommission: true, promotion: true, profit: true },
      orderBy: [...order],
      take: PRODUCT_CAP,
    }),
    prisma.profitDaily.groupBy({ by: ['sellerAccountId', 'sku'], where: { ...where, profit: null }, _count: { _all: true }, orderBy: [...order], take: PRODUCT_CAP }),
  ])
  const missing = new Set(gaps.map(item => keyOf(item.sellerAccountId, item.sku)))
  return new Map(
    sums.map(item => {
      const key = keyOf(item.sellerAccountId, item.sku)
      return [
        key,
        priceUnitOf({
          units: num(item._sum.units) ?? 0,
          revenue: num(item._sum.revenue) ?? 0,
          refunds: num(item._sum.refunds) ?? 0,
          feeCommission: num(item._sum.feeCommission) ?? 0,
          promotion: num(item._sum.promotion) ?? 0,
          profit: missing.has(key) ? null : num(item._sum.profit),
        }),
      ] as const
    }),
  )
}
export const unitOf = (map: ReadonlyMap<string, ReturnType<typeof priceUnitOf>>, key: string): PriceUnit | null => map.get(key)?.unit ?? null

/** 近 30 天每个 ASIN 的推荐报价获得率（逐日值的简单平均）；数据中心优先于报告，不重复相加。 */
export async function loadBuyBoxPct(prisma: PrismaService, tenantId: string, scope: ResolvedScope, now: Date, onlyAsin?: string): Promise<Map<string, number>> {
  const found = await prisma.salesTrafficAsinDaily.groupBy({
    by: ['sellerAccountId', 'asin', 'source'],
    where: {
      tenantId,
      ...storeWhere(scope),
      ...(onlyAsin ? { asin: onlyAsin } : {}),
      asinGranularity: 'CHILD',
      currency: 'USD',
      buyBoxPct: { not: null },
      date: { gte: asDate(ymd(daysAgo(now, 30))) },
    },
    _avg: { buyBoxPct: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { source: 'asc' }],
    take: PRODUCT_CAP * 2,
  })
  const out = new Map<string, { value: number; kiosk: boolean }>()
  for (const row of found) {
    const value = num(row._avg.buyBoxPct)
    if (value === null) continue
    const key = keyOf(row.sellerAccountId, row.asin)
    const kiosk = row.source === 'DATA_KIOSK'
    const kept = out.get(key)
    if (!kept || (!kept.kiosk && kiosk)) out.set(key, { value, kiosk })
  }
  return new Map([...out].map(([key, item]) => [key, item.value]))
}

export interface GuardrailRecord {
  id: string
  sellerAccountId: string
  scope: string
  scopeRef: string
  minPrice: number | null
  maxPrice: number | null
  minMarginPct: number | null
  maxChangePct: number | null
  enabled: boolean
  version: number
  updatedAt: Date
}
export async function loadGuardrails(prisma: PrismaService, tenantId: string, storeIds: readonly string[]): Promise<GuardrailRecord[]> {
  const rows = await prisma.priceGuardrail.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] } },
    orderBy: [{ sellerAccountId: 'asc' }, { scope: 'asc' }, { scopeRef: 'asc' }],
    take: 2000,
  })
  return rows.map(row => ({
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    scope: row.scope,
    scopeRef: row.scopeRef,
    minPrice: num(row.minPrice),
    maxPrice: num(row.maxPrice),
    minMarginPct: num(row.minMarginPct),
    maxChangePct: num(row.maxChangePct),
    enabled: row.enabled,
    version: row.version,
    updatedAt: row.updatedAt,
  }))
}
