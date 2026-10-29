import { PRICING_LIMITS, priceUnitOf, resolveLimits, type GuardrailRow, type GuardrailScope, type PricingFact, type PricingTargetScope } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 定价规则评估要用的事实（P4-11）：每个 SKU 的当前价、预期价格、最低竞争报价、每件经济（近 30 天利润日表）与生效的护栏。
// “最近一次”只看 3 天内的行（价格类快照只在变化或每 24 小时写一次）；单次最多评估 FACT_LIMIT 个 SKU，超出的记 truncated，由规则的评估记录说明。

export const FACT_LIMIT = 5000
const ROW_CAP = 20_000
const CHUNK = 500
const PROFIT_DAYS = 30
const PROFIT_BASIS = 'ORDERED'

export interface StoreFact extends PricingFact {
  currency: string
  productType: string | null
}
export interface LoadedFacts {
  facts: StoreFact[]
  truncated: boolean
}

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, index) => items.slice(index * CHUNK, (index + 1) * CHUNK))
function firstBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) if (!map.has(keyOf(row))) map.set(keyOf(row), row)
  return map
}

async function loadExpected(db: PrismaClient, sellerAccountId: string, skus: readonly string[], since: Date) {
  const out = new Map<string, number | null>()
  for (const part of chunks(skus)) {
    const rows = await db.featuredOfferExpectedPrice.findMany({ where: { sellerAccountId, sellerSku: { in: part }, observedAt: { gte: since } }, orderBy: { observedAt: 'desc' }, take: ROW_CAP })
    for (const [sku, row] of firstBy(rows, item => item.sellerSku)) out.set(sku, num(row.expectedPrice))
  }
  return out
}

/** 每个 ASIN 最近一次“我方是否拿到推荐报价”的观察（情形矩阵的“失去推荐报价时”用）：只看有明确结论的行；since 之后没有观察的没有结论。 */
async function loadOwnFeatured(db: PrismaClient, sellerAccountId: string, asins: readonly string[], since: Date) {
  const out = new Map<string, boolean>()
  for (const part of chunks(asins)) {
    const rows = await db.buyBoxSnapshot.findMany({
      where: { sellerAccountId, asin: { in: part }, ownIsFeatured: { not: null }, observedAt: { gte: since } },
      select: { asin: true, ownIsFeatured: true, observedAt: true },
      orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
      take: ROW_CAP,
    })
    for (const [asin, row] of firstBy(rows, item => item.asin)) out.set(asin, row.ownIsFeatured === true)
  }
  return out
}

/** 每个 ASIN 最近一次观察里，其他卖家（不含我方）的最低报价。 */
async function loadLowestOthers(db: PrismaClient, sellerAccountId: string, asins: readonly string[], since: Date) {
  const out = new Map<string, number>()
  for (const part of chunks(asins)) {
    const rows = await db.competitiveOffer.findMany({
      where: { sellerAccountId, asin: { in: part }, isOwn: false, observedAt: { gte: since } },
      select: { asin: true, price: true, observedAt: true },
      orderBy: { observedAt: 'desc' },
      take: ROW_CAP,
    })
    const latest = firstBy(rows, item => item.asin)
    for (const row of rows) {
      const newest = latest.get(row.asin)
      if (newest && row.observedAt.getTime() === newest.observedAt.getTime()) out.set(row.asin, Math.min(out.get(row.asin) ?? Infinity, Number(row.price.toString())))
    }
  }
  return out
}

/** 每个 ASIN 最近一次（利润日表）：有任何一行因缺成本算不出利润，就整体不给。 */
async function loadUnits(db: PrismaClient, tenantId: string, sellerAccountId: string, skus: readonly string[], now: Date) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - PROFIT_DAYS))
  const out = new Map<string, ReturnType<typeof priceUnitOf>['unit']>()
  for (const part of chunks(skus)) {
    const where = { tenantId, sellerAccountId, basis: PROFIT_BASIS, sku: { in: part }, profitDate: { gte: from } }
    const [sums, gaps] = await Promise.all([
      db.profitDaily.groupBy({ by: ['sku'], where, _sum: { units: true, revenue: true, refunds: true, feeCommission: true, promotion: true, profit: true }, orderBy: { sku: 'asc' }, take: CHUNK }),
      db.profitDaily.groupBy({ by: ['sku'], where: { ...where, profit: null }, _count: { _all: true }, orderBy: { sku: 'asc' }, take: CHUNK }),
    ])
    const missing = new Set(gaps.map(item => item.sku))
    for (const row of sums) {
      const profit = num(row._sum.profit)
      out.set(
        row.sku,
        priceUnitOf({
          units: num(row._sum.units) ?? 0,
          revenue: num(row._sum.revenue) ?? 0,
          refunds: num(row._sum.refunds) ?? 0,
          feeCommission: num(row._sum.feeCommission) ?? 0,
          promotion: num(row._sum.promotion) ?? 0,
          profit: missing.has(row.sku) ? null : profit,
        }).unit,
      )
    }
  }
  return out
}

async function loadProductTypes(db: PrismaClient, sellerAccountId: string, skus: readonly string[]) {
  const out = new Map<string, string>()
  for (const part of chunks(skus)) {
    const rows = await db.listingSnapshot.findMany({ where: { sellerAccountId, sellerSku: { in: part } }, select: { sellerSku: true, productType: true }, take: CHUNK })
    for (const row of rows) if (row.productType) out.set(row.sellerSku, row.productType)
    // 刊登同步还没读到的商品，退回商品目录里的类型（与接口写入口同一个取法）
    const missing = part.filter(sku => !out.has(sku))
    if (missing.length === 0) continue
    const products = await db.fbaProduct.findMany({ where: { sellerAccountId, sellerSku: { in: missing }, productType: { not: null } }, select: { sellerSku: true, productType: true }, take: CHUNK })
    for (const row of products) if (row.productType) out.set(row.sellerSku, row.productType)
  }
  return out
}

export async function loadGuardrailRows(db: PrismaClient, tenantId: string, sellerAccountId: string) {
  return db.priceGuardrail.findMany({ where: { tenantId, sellerAccountId, enabled: true }, orderBy: { id: 'asc' }, take: 2000 })
}
type GuardrailRecord = Awaited<ReturnType<typeof loadGuardrailRows>>[number]

/** 一个 SKU 适用的护栏：店铺级、所属类目、ASIN、SKU 四层里命中的，合并后取最具体的值。 */
export function limitsFor(rows: readonly GuardrailRecord[], sku: string, asin: string, productType: string | null) {
  const applicable: GuardrailRow[] = rows
    .filter(
      row =>
        row.scope === 'STORE' ||
        (row.scope === 'SKU' && row.scopeRef === sku) ||
        (row.scope === 'ASIN' && asin !== '' && row.scopeRef === asin) ||
        (row.scope === 'CATEGORY' && productType !== null && row.scopeRef === productType),
    )
    .map(row => ({ scope: row.scope as GuardrailScope, minPrice: num(row.minPrice), maxPrice: num(row.maxPrice), minMarginPct: num(row.minMarginPct), maxChangePct: num(row.maxChangePct) }))
  return resolveLimits(applicable)
}

export async function loadFacts(db: PrismaClient, input: { tenantId: string; sellerAccountId: string; scope: PricingTargetScope }, now: Date): Promise<LoadedFacts> {
  const { tenantId, sellerAccountId, scope } = input
  const since = new Date(now.getTime() - PRICING_LIMITS.freshWindowMs)
  const scopeFilter = scope.all ? {} : { OR: [{ sellerSku: { in: scope.skus } }, ...(scope.asins.length > 0 ? [{ asin: { in: scope.asins } }] : [])] }
  const priceRows = await db.priceSnapshot.findMany({ where: { tenantId, sellerAccountId, observedAt: { gte: since }, ...scopeFilter }, orderBy: { observedAt: 'desc' }, take: ROW_CAP })
  const latest = [...firstBy(priceRows, row => row.sellerSku).values()].sort((a, b) => a.sellerSku.localeCompare(b.sellerSku))
  const truncated = priceRows.length >= ROW_CAP || latest.length > FACT_LIMIT
  const rows = latest.slice(0, FACT_LIMIT)
  const skus = rows.map(row => row.sellerSku)
  const asins = [...new Set(rows.map(row => row.asin).filter(asin => asin !== ''))]
  const [expected, lowest, units, types, guardrails, featured] = await Promise.all([
    loadExpected(db, sellerAccountId, skus, since),
    loadLowestOthers(db, sellerAccountId, asins, since),
    loadUnits(db, tenantId, sellerAccountId, skus, now),
    loadProductTypes(db, sellerAccountId, skus),
    loadGuardrailRows(db, tenantId, sellerAccountId),
    loadOwnFeatured(db, sellerAccountId, asins, since),
  ])
  const facts = rows.map(row => {
    const productType = types.get(row.sellerSku) ?? null
    return {
      sku: row.sellerSku,
      asin: row.asin,
      currentPrice: Number(row.price.toString()),
      expectedPrice: expected.get(row.sellerSku) ?? null,
      lowestOtherPrice: row.asin ? (lowest.get(row.asin) ?? null) : null,
      ownIsFeatured: row.asin ? (featured.get(row.asin) ?? null) : null,
      unit: units.get(row.sellerSku) ?? null,
      limits: limitsFor(guardrails, row.sellerSku, row.asin, productType),
      currency: row.currency,
      productType,
    }
  })
  return { facts, truncated }
}
