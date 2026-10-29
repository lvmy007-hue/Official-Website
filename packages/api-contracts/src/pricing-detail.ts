import type { InventoryFreshness } from './inventory.js'
import type { ListingRunView } from './listing-quality-write.js'
import type { GuardrailLimits, GuardrailView, GuardrailViolation, PriceChangeSource, PriceCompare, PricingRow, PricingWriteStatuses, RuleRunView } from './pricing.js'

// 定价与购物车（P4-11）的详情、模拟与写入响应类型，以及口径文字。常量与列表类型在 pricing.ts（单文件不超过 400 行，所以拆开）。
// 没有数据显示“尚无记录”，没有权限显示“无权限”，来源没接上显示“尚未接入”，永远不显示成 0。

// ---- 详情 ----

export interface PricingHistoryPoint {
  at: string
  ownPrice: number | null
  featuredPrice: number | null
  lowestPrice: number | null
  expectedPrice: number | null
}
export interface PricingOfferRow {
  offerKey: string
  isOwn: boolean
  isFeatured: boolean
  price: number | null
  shipping: number | null
  condition: string
  fulfillment: string
}
export interface PricingEventRow {
  at: string
  kind: 'PRICE_CHANGE' | 'FEATURED_GAINED' | 'FEATURED_LOST' | 'PRICING_HEALTH' | 'PRICE_WRITE'
  title: string
  detail: string | null
}
export interface PriceAdjustmentRow {
  runId: string
  at: string
  source: PriceChangeSource
  sourceLabel: string
  from: number | null
  to: number
  status: string
  statusLabel: string
  by: string | null
  compare: PriceCompare
}

export interface PricingDetailResponse {
  row: PricingRow
  history: { state: 'OK' | 'NO_DATA'; note: string | null; points: PricingHistoryPoint[] }
  offers: { state: 'OK' | 'NO_DATA'; note: string | null; observedAt: string | null; rows: PricingOfferRow[] }
  events: PricingEventRow[]
  adjustments: PriceAdjustmentRow[]
  limits: GuardrailLimits | null
  guardrails: GuardrailView[]
  pendingRuns: RuleRunView[]
  write: PricingWriteStatuses
  basis: string
  freshness: InventoryFreshness
}

export interface PriceSimulationResponse {
  state: 'OK' | 'NO_UNITS' | 'INCOMPLETE' | 'NO_DATA'
  note: string | null
  price: number
  currentPrice: number | null
  /** 估算：佣金、退款、促销按售价等比例变化，其余费用与成本每件固定。 */
  net: number | null
  margin: number | null
  deltaNet: number | null
  breakEvenPrice: number | null
  expectedPrice: number | null
  /** 目标价是否达到预期获胜价（价格不高于预期价）；没有预期价为 null。 */
  reachesExpected: boolean | null
  guardrail: { ok: boolean; violations: GuardrailViolation[] }
  elasticity: { state: 'OK' | 'INSUFFICIENT'; value: number | null; samples: number; note: string }
  projection: { state: 'OK' | 'UNAVAILABLE'; note: string | null; unitsPerDay: number | null; profitPerDay: number | null; baselineUnitsPerDay: number | null }
  basis: string
}

export interface PriceWriteSubmitResponse {
  run: ListingRunView
  state: 'QUEUED' | 'FAILED'
}

export const PRICING_BASIS =
  '价格来自刊登接口的报价（每 2 小时同步），推荐报价预期价格与竞争摘要来自定价接口（Product Pricing v2022-05-01，每 2 小时）；推送（报价变化、价格健康）的接收端暂缓（14 章 14.10），所以事件只来自同步比对。'
export const PRICING_MARGIN_BASIS = '利润率是估算：取近 30 天这个商品已发生的单位经济（下单口径），假设佣金、退款、促销按售价等比例变化，其余费用与成本每件固定；缺成本时不给，不用别的数字代替。'
export const PRICING_ELASTICITY_NOTE =
  '价格弹性按这个商品近 90 天“每天的价格与销量”做对数回归估算，只在价格有过至少 3% 的变动且样本不少于 8 天时给出；它是历史相关性，不是因果，也没有排除季节、促销与广告的影响。'
