import type { JsonObject } from '../../types'

// 订阅省接口响应的解析（I-19）。只做字段搬运与类型收敛：缺失的字段一律是 null，不补 0——
// “亚马逊没给”和“亚马逊说是 0”在补货计算里含义完全不同（前者是尚未接入，后者是确实没有）。

const record = (value: unknown): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {})
const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
export const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const whole = (value: unknown): number | null => {
  const n = num(value)
  return n === null ? null : Math.round(n)
}
const day = (value: unknown): Date | null => {
  const t = text(value)
  if (!t) return null
  const date = new Date(t)
  return Number.isNaN(date.getTime()) ? null : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export interface ParsedOffer {
  sku: string
  asin: string
  eligibility: string | null
  fulfillment: string | null
  sellerFundedBasePct: number | null
  price: number | null
  currency: string | null
  inventory: number | null
  stockRisk: string | null
  subscriptions: number | null
  forecastNext15: number | null
  forecastNext30: number | null
  forecastNext60: number | null
  forecastNext90: number | null
}

/** 报价列表的一页；没有 SKU 的报价无法对应到库存，计入 skipped。 */
export function parseOffers(body: JsonObject): { offers: ParsedOffer[]; skipped: number; total: number | null } {
  const raw = Array.isArray(body.offers) ? (body.offers as unknown[]) : []
  const offers: ParsedOffer[] = []
  let skipped = 0
  for (const item of raw) {
    const o = record(item)
    const sku = text(o.sku)
    if (!sku) {
      skipped += 1
      continue
    }
    const promotions = record(record(o.offerProgramConfiguration).promotions)
    const forecast = record(o.forecastDeliveries)
    offers.push({
      sku,
      asin: text(o.asin) ?? '',
      eligibility: text(o.eligibility),
      fulfillment: text(o.fulfillmentNetworkIDType),
      sellerFundedBasePct: num(record(promotions.sellingPartnerFundedBaseDiscount).percentage),
      price: num(o.price),
      currency: text(o.priceCurrencyCode),
      inventory: whole(o.inventory),
      stockRisk: text(o.stockRisk),
      subscriptions: whole(o.subscriptions),
      forecastNext15: whole(forecast.next15DaysDeliveries),
      forecastNext30: whole(forecast.next30DaysDeliveries),
      forecastNext60: whole(forecast.next60DaysDeliveries),
      forecastNext90: whole(forecast.next90DaysDeliveries),
    })
  }
  return { offers, skipped, total: num(record(body.pagination).totalResults) }
}

/** 报价指标的一页：SKU → 该时间窗内的订阅出货件数（亚马逊没给的 SKU 不出现，不补 0）。 */
export function parseOfferUnits(body: JsonObject): { units: Map<string, number>; count: number } {
  const raw = Array.isArray(body.offers) ? (body.offers as unknown[]) : []
  const units = new Map<string, number>()
  for (const item of raw) {
    const o = record(item)
    const sku = text(o.sku)
    const shipped = whole(o.shippedSubscriptionUnits)
    if (sku && shipped !== null) units.set(sku, (units.get(sku) ?? 0) + shipped)
  }
  return { units, count: raw.length }
}

export interface ParsedMetric {
  metricDate: Date
  activeSubscribers: number | null
  shippedUnits: number | null
  revenue: number | null
  currency: string | null
}

/** 卖家整体指标：每个元素的 timeInterval.startDate 是该聚合单位的起点；没有时间区间的元素无法落日，计入 skipped。 */
export function parseSellerMetrics(body: JsonObject): { metrics: ParsedMetric[]; skipped: number } {
  const raw = Array.isArray(body.metrics) ? (body.metrics as unknown[]) : []
  const metrics: ParsedMetric[] = []
  let skipped = 0
  for (const item of raw) {
    const m = record(item)
    const metricDate = day(record(m.timeInterval).startDate)
    if (!metricDate) {
      skipped += 1
      continue
    }
    metrics.push({
      metricDate,
      activeSubscribers: whole(m.activeSubscriptions),
      shippedUnits: whole(m.shippedSubscriptionUnits),
      revenue: num(m.totalSubscriptionsRevenue),
      currency: text(m.currencyCode),
    })
  }
  return { metrics, skipped }
}
