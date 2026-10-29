// 头程运费预估的计费规则与货件三种数量差异（P6-26，16 章第 5 节；纯函数，零 zod，前后端共用）。
//
// 计费规则（渠道报价，写进 CR-136）：
//   1. 实重 = 各 SKU 重量合计（千克）；体积 = 各 SKU 体积合计（立方米）；体积重 = 体积 × 1,000,000 ÷ 材积除数（立方厘米每千克）；
//   2. 计费重 = 实重；体积重大于实重时，计费重 = 实重 +（体积重 − 实重）× 分抛系数（系数为 1 即取两者较大者，0.5 即多出的部分只算一半）；
//   3. 按计费重找报价：同一地区、有效日当天生效、下限 ≤ 计费重 < 上限（上限为空表示无上限）的那一段；找不到就说明原因，不用相邻段顶替；
//   4. 金额：PER_KG = 计费重 × 单价；PER_CBM = 体积 × 单价；FLAT = 单价（该段一口价）；金额保留 2 位小数（四舍五入）。
// 任何一个 SKU 缺重量或体积都不预估（不拿 0 顶替），把缺的项逐个列出。

export const BILLING_MODES = ['PER_KG', 'PER_CBM', 'FLAT'] as const
export type BillingMode = (typeof BILLING_MODES)[number]
export const BILLING_MODE_LABEL: Record<BillingMode, string> = { PER_KG: '按计费重量（每千克）', PER_CBM: '按体积（每立方米）', FLAT: '重量段一口价' }

export const CARRIER_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type CarrierStatus = (typeof CARRIER_STATUSES)[number]
export const CARRIER_STATUS_LABEL: Record<CarrierStatus, string> = { ACTIVE: '使用中', INACTIVE: '已停用' }

export const CARRIER_ACTIONS = {
  carrierCreated: 'CARRIER_CREATED',
  carrierUpdated: 'CARRIER_UPDATED',
  carrierDeleted: 'CARRIER_DELETED',
  channelCreated: 'CARRIER_CHANNEL_CREATED',
  channelUpdated: 'CARRIER_CHANNEL_UPDATED',
  channelDeleted: 'CARRIER_CHANNEL_DELETED',
  rateCreated: 'CHANNEL_RATE_CREATED',
  rateUpdated: 'CHANNEL_RATE_UPDATED',
  rateDeleted: 'CHANNEL_RATE_DELETED',
  itemsFilled: 'FIRST_MILE_ITEMS_FILLED',
} as const

export const CARRIER_BLOCKED_NO_PERMISSION = '没有“头程物流维护”权限（firstmile.write），只能查看物流渠道与报价'

/** 预估与实际相差超过这个比例（绝对值）算异常单；列表筛选可改。 */
export const DEVIATION_DEFAULT_PCT = 20

const round = (value: number, digits: number) => {
  const base = 10 ** digits
  return Math.round((value + Number.EPSILON) * base) / base
}

export interface ChannelParams {
  volumetricDivisor: number
  splitFactor: number
}

export interface RateTier {
  id: string
  region: string
  weightFrom: number
  weightTo: number | null
  unitPrice: number
  currency: string
  billingMode: BillingMode
  effectiveFrom: string
  effectiveTo: string | null
}

/** 体积重（千克）：体积（立方米）× 1,000,000 ÷ 材积除数。 */
export function volumetricWeightKg(volumeCbm: number, divisor: number): number {
  return round((volumeCbm * 1_000_000) / divisor, 4)
}

export interface ChargeableWeight {
  actualKg: number
  volumetricKg: number
  chargeableKg: number
  /** 体积重大于实重（泡货）。 */
  bulky: boolean
}

/** 计费重：见文件头第 2 条。 */
export function chargeableWeightOf(input: { actualKg: number; volumeCbm: number } & ChannelParams): ChargeableWeight {
  const volumetricKg = volumetricWeightKg(input.volumeCbm, input.volumetricDivisor)
  const bulky = volumetricKg > input.actualKg
  const chargeableKg = bulky ? round(input.actualKg + (volumetricKg - input.actualKg) * input.splitFactor, 4) : input.actualKg
  return { actualKg: input.actualKg, volumetricKg, chargeableKg, bulky }
}

const inWeight = (tier: Pick<RateTier, 'weightFrom' | 'weightTo'>, weight: number) => weight >= tier.weightFrom && (tier.weightTo === null || weight < tier.weightTo)
const inEffect = (tier: Pick<RateTier, 'effectiveFrom' | 'effectiveTo'>, day: string) => day >= tier.effectiveFrom && (tier.effectiveTo === null || day <= tier.effectiveTo)

/** 找报价：地区、重量段、生效日都对得上的那一条；没有返回 null；多条（数据不应出现）时取生效日最晚的。 */
export function pickRate(tiers: readonly RateTier[], input: { region: string; weightKg: number; on: string }): RateTier | null {
  const hits = tiers.filter(tier => tier.region === input.region && inWeight(tier, input.weightKg) && inEffect(tier, input.on))
  if (hits.length === 0) return null
  return hits.reduce((best, tier) => (tier.effectiveFrom > best.effectiveFrom ? tier : best))
}

/** 报价金额（见文件头第 4 条）。 */
export function rateAmount(tier: Pick<RateTier, 'billingMode' | 'unitPrice'>, input: { chargeableKg: number; volumeCbm: number }): number {
  if (tier.billingMode === 'FLAT') return round(tier.unitPrice, 2)
  if (tier.billingMode === 'PER_CBM') return round(tier.unitPrice * input.volumeCbm, 2)
  return round(tier.unitPrice * input.chargeableKg, 2)
}

type Range = { weightFrom: number; weightTo: number | null; effectiveFrom: string; effectiveTo: string | null }
const weightOverlap = (a: Range, b: Range) => (a.weightTo === null || b.weightFrom < a.weightTo) && (b.weightTo === null || a.weightFrom < b.weightTo)
const dayOverlap = (a: Range, b: Range) => (a.effectiveTo === null || b.effectiveFrom <= a.effectiveTo) && (b.effectiveTo === null || a.effectiveFrom <= b.effectiveTo)

/** 两条同渠道同地区的报价冲突：重量段重叠且生效区间也重叠（相邻不算：上限等于下一段下限、截止日的下一天起新价）。 */
export function ratesConflict(a: Range, b: Range): boolean {
  return weightOverlap(a, b) && dayOverlap(a, b)
}

export interface EstimateItemInput {
  sku: string
  quantity: number
  weightKg: number | null
  volumeCbm: number | null
}
export interface MissingFreightField {
  sku: string
  /** 缺什么：WEIGHT 重量、VOLUME 体积。 */
  missing: Array<'WEIGHT' | 'VOLUME'>
}

/** 逐个 SKU 找缺的字段（重量与体积是这个 SKU 这批货的合计，为空表示没填；0 不算缺）。 */
export function missingFreightFields(items: readonly EstimateItemInput[]): MissingFreightField[] {
  return items.flatMap(item => {
    const missing: Array<'WEIGHT' | 'VOLUME'> = []
    if (item.weightKg === null) missing.push('WEIGHT')
    if (item.volumeCbm === null) missing.push('VOLUME')
    return missing.length ? [{ sku: item.sku, missing }] : []
  })
}

export type EstimateBlock = 'MISSING_FIELDS' | 'NO_RATE' | 'NO_CHANNEL' | 'CURRENCY_MISMATCH'
export const ESTIMATE_BLOCK_LABEL: Record<EstimateBlock, string> = {
  MISSING_FIELDS: '有 SKU 缺重量或体积',
  NO_RATE: '没有匹配的报价',
  NO_CHANNEL: '没有选择渠道',
  CURRENCY_MISMATCH: '币种与运单不一致',
}

export interface FreightEstimate {
  state: 'OK' | 'BLOCKED'
  block: EstimateBlock | null
  /** 不能预估时写明为什么，页面照实显示。 */
  reason: string | null
  missing: MissingFreightField[]
  actualKg: number | null
  volumeCbm: number | null
  volumetricKg: number | null
  chargeableKg: number | null
  bulky: boolean | null
  tier: RateTier | null
  amount: number | null
  currency: string | null
}

const blocked = (block: EstimateBlock, reason: string, missing: MissingFreightField[] = []): FreightEstimate => ({
  state: 'BLOCKED',
  block,
  reason,
  missing,
  actualKg: null,
  volumeCbm: null,
  volumetricKg: null,
  chargeableKg: null,
  bulky: null,
  tier: null,
  amount: null,
  currency: null,
})

/** 头程预估：缺重量或体积、找不到报价都不预估并写明原因。 */
export function estimateFreight(input: {
  items: readonly EstimateItemInput[]
  channel: ChannelParams
  tiers: readonly RateTier[]
  region: string
  on: string
  shipmentCurrency?: string
}): FreightEstimate {
  const missing = missingFreightFields(input.items)
  if (input.items.length === 0) return blocked('MISSING_FIELDS', '运单还没有明细')
  if (missing.length > 0) return blocked('MISSING_FIELDS', `有 ${missing.length} 个 SKU 缺重量或体积，补录后才能预估`, missing)
  const actualKg = round(
    input.items.reduce((sum, item) => sum + (item.weightKg ?? 0), 0),
    4,
  )
  const volumeCbm = round(
    input.items.reduce((sum, item) => sum + (item.volumeCbm ?? 0), 0),
    4,
  )
  const weight = chargeableWeightOf({ actualKg, volumeCbm, ...input.channel })
  const tier = pickRate(input.tiers, { region: input.region, weightKg: weight.chargeableKg, on: input.on })
  const base: FreightEstimate = { ...blocked('NO_RATE', ''), actualKg, volumeCbm, volumetricKg: weight.volumetricKg, chargeableKg: weight.chargeableKg, bulky: weight.bulky }
  if (!tier) return { ...base, reason: `渠道在“${input.region}”没有覆盖计费重量 ${weight.chargeableKg} 千克、且 ${input.on} 当天生效的报价` }
  if (input.shipmentCurrency && tier.currency !== input.shipmentCurrency) {
    return { ...base, block: 'CURRENCY_MISMATCH', reason: `报价币种 ${tier.currency} 与运单币种 ${input.shipmentCurrency} 不一致，系统不做汇率换算`, tier }
  }
  return { ...base, state: 'OK', block: null, reason: null, tier, amount: rateAmount(tier, { chargeableKg: weight.chargeableKg, volumeCbm }), currency: tier.currency }
}

export interface EstimateGap {
  /** 实际 − 预估（正数是超支）。 */
  diff: number | null
  /** 差异 ÷ 预估 × 100，保留 1 位；预估为空或为 0 没有比例。 */
  pct: number | null
}

/** 预估与实际的差异；任何一边没有就没有差异（不拿 0 顶替）。 */
export function estimateGap(estimated: number | null, actual: number | null): EstimateGap {
  if (estimated === null || actual === null) return { diff: null, pct: null }
  const diff = round(actual - estimated, 2)
  return { diff, pct: estimated === 0 ? null : round((diff / estimated) * 100, 1) }
}

/** 异常单：差异比例绝对值达到阈值（含）。 */
export const isDeviationAbnormal = (pct: number | null, threshold: number): boolean => pct !== null && Math.abs(pct) >= threshold

// ---- 货件三种数量差异 ----

export const SHIPMENT_GAP_FILTERS = ['DECLARED_GT_SHIPPED', 'DECLARED_GT_RECEIVED', 'SHIPPED_GT_RECEIVED'] as const
export type ShipmentGapFilter = (typeof SHIPMENT_GAP_FILTERS)[number]
export const SHIPMENT_GAP_FILTER_LABEL: Record<ShipmentGapFilter, string> = {
  DECLARED_GT_SHIPPED: '申报大于已发',
  DECLARED_GT_RECEIVED: '申报大于签收',
  SHIPPED_GT_RECEIVED: '已发大于签收',
}

export interface ShipmentGaps {
  /** 申报 − 已发。 */
  declaredVsShipped: number | null
  /** 已发 − 签收（货件关闭后才有）。 */
  shippedVsReceived: number | null
  /** 申报 − 签收（货件关闭后才有）。 */
  declaredVsReceived: number | null
}

const minus = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b)

/** 申报、已发、签收两两相减；签收相关的两项只在货件关闭后判定（接收数量在关闭前还会变）。 */
export function shipmentGapsOf(input: { declared: number | null; shipped: number | null; received: number | null; closed: boolean }): ShipmentGaps {
  const received = input.closed ? input.received : null
  return { declaredVsShipped: minus(input.declared, input.shipped), shippedVsReceived: minus(input.shipped, received), declaredVsReceived: minus(input.declared, received) }
}

export function matchesGapFilter(gaps: ShipmentGaps, filter: ShipmentGapFilter): boolean {
  const value = filter === 'DECLARED_GT_SHIPPED' ? gaps.declaredVsShipped : filter === 'DECLARED_GT_RECEIVED' ? gaps.declaredVsReceived : gaps.shippedVsReceived
  return value !== null && value > 0
}
