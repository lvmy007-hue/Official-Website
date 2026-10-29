import {
  PRICE_HEALTH_STATES,
  hasAnyLimit,
  marginAtPrice,
  priceHealthLabel,
  priceHealthOf,
  resolveLimits,
  round2,
  type GuardrailLimits,
  type GuardrailRow,
  type GuardrailScope,
  type PriceUnitResult,
  type PricingRow,
  type PricingSort,
  type PricingSummary,
} from '@nova/api-contracts'
import type { CompetitiveSummarySnapshot, FeaturedOfferExpectedPrice } from '@prisma/client'
import { keyOf, num, type GuardrailRecord, type PriceFact, type ProductRow } from './pricing-load'

// 定价列表的行：把商品、最近价格、预期价格、竞争摘要、利润与护栏拼成一行。没有数据的字段是 null，不是 0；排序时 null 永远排在最后（与方向无关）。

export const MARGIN_RESTRICTED_NOTE = '需要利润字段权限（field.profit）才能查看利润率'
export const MARGIN_NO_DATA_NOTE = '近 30 天这个商品没有利润数据（订单与财务交易同步后自动派生；没有生效的成本时利润为空，不当 0）'

/** 一个 SKU 适用的护栏（店铺、类目、ASIN、SKU 四层里命中且启用的），合并成一组限制；一项限制都没有返回 null。 */
export function limitsOf(rows: readonly GuardrailRecord[], target: { storeId: string; sku: string; asin: string; productType: string | null }): GuardrailLimits | null {
  const applicable: GuardrailRow[] = rows
    .filter(
      row =>
        row.enabled &&
        row.sellerAccountId === target.storeId &&
        (row.scope === 'STORE' ||
          (row.scope === 'SKU' && row.scopeRef === target.sku) ||
          (row.scope === 'ASIN' && target.asin !== '' && row.scopeRef === target.asin) ||
          (row.scope === 'CATEGORY' && target.productType !== null && row.scopeRef === target.productType)),
    )
    .map(row => ({ scope: row.scope as GuardrailScope, minPrice: row.minPrice, maxPrice: row.maxPrice, minMarginPct: row.minMarginPct, maxChangePct: row.maxChangePct }))
  const limits = resolveLimits(applicable)
  return hasAnyLimit(limits) ? limits : null
}

export interface RowInput {
  product: ProductRow
  storeName: string
  price: PriceFact | undefined
  expected: FeaturedOfferExpectedPrice | undefined
  summary: CompetitiveSummarySnapshot | undefined
  buyBoxPct: number | null
  unit: PriceUnitResult | undefined
  canProfit: boolean
  guardrails: readonly GuardrailRecord[]
}

function marginOf(input: RowInput, price: number | null, expectedPrice: number | null): PricingRow['margin'] {
  if (!input.canProfit) return { state: 'RESTRICTED', note: MARGIN_RESTRICTED_NOTE, atCurrent: null, atExpected: null }
  if (!input.unit) return { state: 'NO_DATA', note: MARGIN_NO_DATA_NOTE, atCurrent: null, atExpected: null }
  if (input.unit.state === 'NO_UNITS') return { state: 'NO_DATA', note: input.unit.note, atCurrent: null, atExpected: null }
  if (input.unit.state === 'INCOMPLETE') return { state: 'INCOMPLETE', note: input.unit.note, atCurrent: null, atExpected: null }
  return { state: 'OK', note: null, atCurrent: marginAtPrice(input.unit.unit, price), atExpected: marginAtPrice(input.unit.unit, expectedPrice) }
}

export function buildRow(input: RowInput): PricingRow {
  const { product, price, expected, summary } = input
  const own = price?.price ?? null
  const expectedPrice = expected ? num(expected.expectedPrice) : null
  const health = priceHealthOf({
    ownPrice: own,
    expectedPrice,
    resultStatus: expected?.resultStatus ?? null,
    ownIsFeatured: summary?.featuredIsOwn ?? null,
    eligibilityLost: false,
    hasObservation: expected !== undefined || summary !== undefined,
  })
  const asin = product.asin || price?.asin || ''
  return {
    id: product.id,
    storeId: product.sellerAccountId,
    storeName: input.storeName,
    sku: product.sellerSku,
    asin,
    title: product.title,
    imageUrl: product.imageUrl,
    price: own,
    currency: price?.currency ?? 'USD',
    priceObservedAt: price ? price.observedAt.toISOString() : null,
    lowestPrice: summary ? num(summary.lowestPrice) : null,
    featured: { price: summary ? num(summary.featuredPrice) : null, ownIsFeatured: summary?.featuredIsOwn ?? null, fulfillment: summary?.featuredFulfillment ?? null },
    expectedPrice,
    expectedStatus: expected?.resultStatus ?? null,
    gap: own !== null && expectedPrice !== null ? round2(own - expectedPrice) : null,
    buyBoxPct: input.buyBoxPct,
    viewWeight: { member: summary ? num(summary.viewWeightMember) : null, nonMember: summary ? num(summary.viewWeightNonMember) : null },
    health,
    healthLabel: priceHealthLabel(health),
    lastChange: price?.change ? { at: price.change.at.toISOString(), from: price.change.from, to: price.price } : null,
    margin: marginOf(input, own, expectedPrice),
    limits: limitsOf(input.guardrails, { storeId: product.sellerAccountId, sku: product.sellerSku, asin, productType: product.productType }),
  }
}

const sortValue = (row: PricingRow, field: PricingSort): number | string | null => {
  switch (field) {
    case 'sku':
      return row.sku
    case 'price':
      return row.price
    case 'gap':
      return row.gap
    case 'margin':
      return row.margin.atCurrent
    case 'buyBox':
      return row.buyBoxPct
    case 'lastChange':
      return row.lastChange?.at ?? null
  }
}

export function comparePricingRows(a: PricingRow, b: PricingRow, field: PricingSort, dir: 'asc' | 'desc'): number {
  const left = sortValue(a, field)
  const right = sortValue(b, field)
  if (left === null && right === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  if (left === null) return 1
  if (right === null) return -1
  const order = left < right ? -1 : left > right ? 1 : 0
  return order === 0 ? (a.id < b.id ? -1 : 1) : dir === 'asc' ? order : -order
}

export function summaryOf(rows: readonly PricingRow[]): PricingSummary {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.health, (counts.get(row.health) ?? 0) + 1)
  return {
    total: rows.length,
    health: PRICE_HEALTH_STATES.map(state => ({ state, label: priceHealthLabel(state), count: counts.get(state) ?? 0 })),
    withPrice: rows.filter(row => row.price !== null).length,
    withoutPrice: rows.filter(row => row.price === null).length,
  }
}

export { keyOf }
