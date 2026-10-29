import { createHash } from 'node:crypto'
import { LISTING_MARKETPLACE_ID, PRICING_LIMITS } from '@nova/api-contracts'

// 定价接口响应的解析（importers.md I-13、I-10 的报价部分）。字段依据官方文档整理，未经真实响应核对（CR-086）；
// 规则：解析宽松（缺字段给 null，不抛错）、批内失败项单独计数、不存别家卖家编号原文（只存哈希）、金额一律转数字并要求为正。

const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 金额：接受数字或数字文字，必须是正数；否则为 null。 */
export function amountOf(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1_000_000) / 1_000_000 : null
}
const money = (value: unknown): { amount: number | null; currency: string } => {
  const row = obj(value)
  return { amount: row ? amountOf(row.amount) : null, currency: row ? str(row.currencyCode) || str(row.currency) : '' }
}

export const sellerKeyOf = (sellerId: string): string => createHash('sha256').update(sellerId).digest('hex').slice(0, 16)
export const fulfillmentOf = (value: string): string => (value === 'AFN' ? 'FBA' : value === 'MFN' ? 'FBM' : value)

// ---- 我方报价（刊登接口，includedData=summaries,offers） ----

export interface OwnPrice {
  sku: string
  asin: string
  price: number
  currency: string
}
export interface ParsedOwnPrices {
  items: OwnPrice[]
  nextToken: string | null
  /** 没有报价（下架或没有美国站报价）的刊登数。 */
  withoutPrice: number
}

export function parseOwnPrices(raw: unknown): ParsedOwnPrices {
  const root = obj(raw)
  if (!root) throw new Error('LISTINGS_RESPONSE_INVALID')
  const items: OwnPrice[] = []
  let withoutPrice = 0
  for (const entry of list(root.items)) {
    const row = obj(entry)
    const sku = row ? str(row.sku) : ''
    if (!row || !sku) continue
    const offer = list(row.offers)
      .map(obj)
      .find(item => item && str(item.marketplaceId) === LISTING_MARKETPLACE_ID && (str(item.offerType) || 'B2C') === 'B2C')
    const price = money(offer?.price)
    const summary = list(row.summaries)
      .map(obj)
      .find(item => item && str(item.marketplaceId) === LISTING_MARKETPLACE_ID)
    if (price.amount === null) {
      withoutPrice += 1
      continue
    }
    items.push({ sku: sku.slice(0, 200), asin: summary ? str(summary.asin).toUpperCase() : '', price: price.amount, currency: price.currency || 'USD' })
  }
  return { items, nextToken: str(obj(root.pagination)?.nextToken) || null, withoutPrice }
}

// ---- 推荐报价预期价格 ----

export interface ExpectedPriceRow {
  sku: string
  asin: string
  expectedPrice: number | null
  currentFeaturedPrice: number | null
  currency: string
  resultStatus: string
}
export interface ParsedExpected {
  rows: ExpectedPriceRow[]
  failed: number
}

export function parseExpectedPrices(raw: unknown): ParsedExpected {
  const rows: ExpectedPriceRow[] = []
  let failed = 0
  for (const entry of list(obj(raw)?.responses)) {
    const response = obj(entry)
    const status = Number(obj(response?.status)?.statusCode ?? 200)
    const body = obj(response?.body)
    const identifier = obj(body?.offerIdentifier)
    const sku = str(identifier?.sku) || str(obj(response?.request)?.sku)
    if (!response || status !== 200 || !body || !sku) {
      failed += 1
      continue
    }
    const result = obj(list(body.featuredOfferExpectedPriceResults)[0])
    const expected = money(obj(result?.featuredOfferExpectedPrice)?.listingPrice)
    const current = obj(obj(result?.currentFeaturedOffer)?.price)
    const currentPrice = money(current?.listingPrice ?? current)
    rows.push({
      sku: sku.slice(0, 200),
      asin: str(identifier?.asin).toUpperCase(),
      expectedPrice: expected.amount,
      currentFeaturedPrice: currentPrice.amount,
      currency: expected.currency || currentPrice.currency || 'USD',
      resultStatus: (str(result?.resultStatus) || 'UNKNOWN').slice(0, 80),
    })
  }
  return { rows, failed }
}

// ---- 竞争摘要 ----

export interface SummaryOffer {
  offerKey: string
  isOwn: boolean
  isFeatured: boolean
  price: number
  shipping: number | null
  condition: string
  fulfillment: string
}
export interface SummaryRow {
  asin: string
  hasFeatured: boolean
  featuredPrice: number | null
  featuredFulfillment: string | null
  featuredIsOwn: boolean | null
  viewWeightMember: number | null
  viewWeightNonMember: number | null
  referencePrice: number | null
  referencePriceType: string | null
  lowestPrice: number | null
  currency: string
  offers: SummaryOffer[]
}
export interface ParsedSummaries {
  rows: SummaryRow[]
  failed: number
}

/** 浏览权重在接口里是百分数（0 到 100），转成 0 到 1 的小数；超出范围当作没有。 */
const weightOf = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round((number / 100) * 1_000_000) / 1_000_000 : null
}

function offerOf(raw: unknown, ownSellerId: string, featured: boolean): (SummaryOffer & { weights: Array<{ member: boolean; weight: number | null }> }) | null {
  const offer = obj(raw)
  const sellerId = offer ? str(offer.sellerId) : ''
  const price = money(offer?.listingPrice)
  if (!offer || !sellerId || price.amount === null) return null
  const shipping = list(offer.shippingOptions)
    .map(item => money(obj(item)?.price).amount)
    .find(item => item !== null)
  const weights = list(offer.featuredOfferSegments).map(segment => {
    const row = obj(segment)
    const membership = str(row?.customerMembership).toUpperCase()
    return { member: membership === 'PRIME' || membership === 'MEMBER', weight: weightOf(obj(row?.segmentDetails)?.glanceViewWeightPercentage) }
  })
  return {
    offerKey: sellerKeyOf(sellerId),
    isOwn: ownSellerId !== '' && sellerId === ownSellerId,
    isFeatured: featured,
    price: price.amount,
    shipping: shipping ?? null,
    condition: str(offer.condition).slice(0, 40),
    fulfillment: fulfillmentOf(str(offer.fulfillmentType)).slice(0, 20),
    weights,
  }
}

export function parseSummaries(raw: unknown, ownSellerId: string): ParsedSummaries {
  const rows: SummaryRow[] = []
  let failed = 0
  for (const entry of list(obj(raw)?.responses)) {
    const response = obj(entry)
    const status = Number(obj(response?.status)?.statusCode ?? 200)
    const body = obj(response?.body)
    const asin = (str(body?.asin) || str(obj(response?.request)?.asin)).toUpperCase()
    if (!response || status !== 200 || !body || !asin) {
      failed += 1
      continue
    }
    const featured = list(body.featuredBuyingOptions)
      .flatMap(option => list(obj(option)?.segmentedFeaturedOffers))
      .flatMap(item => {
        const offer = offerOf(item, ownSellerId, true)
        return offer ? [offer] : []
      })
    const others = list(body.lowestPricedOffers)
      .flatMap(group => list(obj(group)?.offers))
      .flatMap(item => {
        const offer = offerOf(item, ownSellerId, false)
        return offer ? [offer] : []
      })
    const member = featured.flatMap(offer => offer.weights.filter(item => item.member && item.weight !== null)).map(item => item.weight as number)
    const nonMember = featured.flatMap(offer => offer.weights.filter(item => !item.member && item.weight !== null)).map(item => item.weight as number)
    const first = featured[0]
    const reference = list(body.referencePrices)
      .map(item => ({ name: str(obj(item)?.name), price: money(obj(item)?.price) }))
      .find(item => item.price.amount !== null)
    const seen = new Set<string>()
    const offers = [...featured, ...others]
      .filter(offer => {
        const key = `${offer.offerKey}|${offer.price}|${offer.fulfillment}|${offer.isFeatured}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => a.price - b.price)
      .slice(0, PRICING_LIMITS.offersMax)
      .map(({ weights: _weights, ...offer }) => offer)
    const lowest = [...featured, ...others].map(offer => offer.price)
    rows.push({
      asin,
      hasFeatured: featured.length > 0,
      featuredPrice: first?.price ?? null,
      featuredFulfillment: first?.fulfillment || null,
      featuredIsOwn: featured.length > 0 ? featured.some(offer => offer.isOwn) : null,
      viewWeightMember: member.length > 0 ? Math.max(...member) : null,
      viewWeightNonMember: nonMember.length > 0 ? Math.max(...nonMember) : null,
      referencePrice: reference?.price.amount ?? null,
      referencePriceType: reference?.name || null,
      lowestPrice: lowest.length > 0 ? Math.min(...lowest) : null,
      currency: reference?.price.currency || 'USD',
      offers,
    })
  }
  return { rows, failed }
}
