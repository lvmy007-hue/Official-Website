// 新品定价试算（P6-29，16 章第 10 节）。零 zod：费率表、利润公式、任务类型与新鲜度键给前端和 worker 共用。
// 官方 Product Fees API 必须有 ASIN 或 SKU，没有“只按尺寸”的接口。未上架且没有参考 ASIN 时按下面的美国站公开费率表当场估算，并标明“模型估算”。

export const TOOLS_READ = 'tools.read'
export const PRICING_FEE_ESTIMATE_JOB = 'PRICING_FEE_ESTIMATE'
/** 费用预估 403 的新鲜度来源。不放进 JOB_FRESHNESS_SOURCES：任务成功返回时不能把 UNAUTHORIZED 覆盖成 NORMAL。 */
export const FEES_ESTIMATE_FRESHNESS_KEY = 'fees.estimate-v0'
export const FEES_ROLE_PENDING = 'FEES_ROLE_PENDING'
export const PRICING_RATE_CARD_VERSION = 'US-FBA-2025-NONPEAK'
export const PRICING_CALC_CACHE_MS = 24 * 60 * 60 * 1000
export const PRICING_CALC_RATE_PER_MINUTE = 10
export const PRICING_CALC_ACTIONS = { saved: 'PRICING_CALC_SAVED' } as const

export const PRICING_CATEGORIES = ['STANDARD', 'ELECTRONICS', 'CLOTHING', 'BEAUTY', 'GROCERY'] as const
export type PricingCategory = (typeof PRICING_CATEGORIES)[number]
export const PRICING_CATEGORY_LABEL: Readonly<Record<PricingCategory, string>> = {
  STANDARD: '综合（佣金 15%）',
  ELECTRONICS: '电子（佣金 8%）',
  CLOTHING: '服装（佣金 17%）',
  BEAUTY: '美妆（佣金 8%）',
  GROCERY: '食品杂货（佣金 8%）',
}
const REFERRAL_RATE: Readonly<Record<PricingCategory, number>> = { STANDARD: 0.15, ELECTRONICS: 0.08, CLOTHING: 0.17, BEAUTY: 0.08, GROCERY: 0.08 }
const REFERRAL_MIN = 0.3

export const FIRST_MILE_METHODS = ['NONE', 'PER_KG', 'PER_CBM', 'FLAT'] as const
export type FirstMileMethod = (typeof FIRST_MILE_METHODS)[number]
export const FIRST_MILE_METHOD_LABEL: Readonly<Record<FirstMileMethod, string>> = {
  NONE: '不计头程',
  PER_KG: '按公斤',
  PER_CBM: '按立方米',
  FLAT: '整票一口价',
}

export const AMAZON_FEE_STATES = ['NOT_REQUESTED', 'NO_CONNECTION', 'NO_PERMISSION', 'QUEUED', 'OK', 'FAILED'] as const
export type AmazonFeeState = (typeof AMAZON_FEE_STATES)[number]

export interface PricingInput {
  purchaseCost: number
  firstMile: { method: FirstMileMethod; unitPrice: number }
  lengthCm: number
  widthCm: number
  heightCm: number
  weightG: number
  category: PricingCategory
  /** 已排序、已四舍五入，最多 8 个 */
  prices: number[]
  referenceAsin: string | null
  storeId: string | null
}

export interface PricingScenario {
  price: number
  currency: 'USD'
  referralFee: number
  fulfillmentFee: number
  firstMileFee: number
  purchaseCost: number
  profit: number
  /** 利润 / 售价；售价为 0 时为空 */
  margin: number | null
  /** 利润 /（采购 + 头程）；分母为 0 时为空 */
  roi: number | null
  feeSource: 'RATE_CARD' | 'AMAZON'
}

export interface PricingAmazonPlan {
  state: AmazonFeeState
  message: string
  jobId?: string
  priceUsed?: number
}

export interface PricingCalcResult {
  source: 'RATE_CARD' | 'AMAZON'
  rateCardVersion: string
  estimateNote: string
  tier: string
  tierLabel: string
  referralRate: number
  scenarios: PricingScenario[]
  amazon: PricingAmazonPlan
  input: PricingInput
}

const round2 = (value: number) => Math.round(value * 100) / 100
const round4 = (value: number) => Math.round(value * 10000) / 10000
const cmToIn = (cm: number) => cm / 2.54
const gToOz = (g: number) => g / 28.349523125

/** 小标准件：最长 ≤15 英寸、次长 ≤12、最短 ≤0.75、重量 ≤16 盎司。大标准件：最长 ≤18、次长 ≤14、最短 ≤8、重量 ≤20 磅。其余按大件。 */
export function sizeTier(input: Pick<PricingInput, 'lengthCm' | 'widthCm' | 'heightCm' | 'weightG'>): { tier: string; tierLabel: string; fulfillmentFee: number } {
  const sides = [cmToIn(input.lengthCm), cmToIn(input.widthCm), cmToIn(input.heightCm)].sort((a, b) => b - a)
  const [longest, median, shortest] = sides
  const oz = gToOz(input.weightG)
  const small = longest <= 15 && median <= 12 && shortest <= 0.75 && oz <= 16
  const large = longest <= 18 && median <= 14 && shortest <= 8 && oz <= 20 * 16
  if (small) {
    const bands: Array<[number, number]> = [
      [4, 3.22],
      [8, 3.4],
      [12, 3.58],
      [16, 3.77],
    ]
    const fee = bands.find(([max]) => oz <= max)?.[1] ?? 3.77
    return { tier: 'SMALL_STANDARD', tierLabel: '小标准件', fulfillmentFee: fee }
  }
  if (large) {
    const bands: Array<[number, number]> = [
      [4, 3.86],
      [8, 4.08],
      [12, 4.32],
      [16, 4.75],
      [24, 5.4],
      [32, 5.69],
      [48, 6.1],
    ]
    const hit = bands.find(([max]) => oz <= max)
    const fee = hit ? hit[1] : round2(6.1 + Math.ceil((oz - 48) / 16) * 0.3)
    return { tier: 'LARGE_STANDARD', tierLabel: '大标准件', fulfillmentFee: fee }
  }
  const pounds = Math.max(1, oz / 16)
  return { tier: 'OVERSIZE', tierLabel: '大件', fulfillmentFee: round2(9.73 + Math.max(0, pounds - 1) * 0.42) }
}

export function firstMileFee(input: PricingInput): number {
  const { method, unitPrice } = input.firstMile
  if (method === 'NONE') return 0
  if (method === 'FLAT') return round2(unitPrice)
  if (method === 'PER_KG') return round2(unitPrice * (input.weightG / 1000))
  const cbm = (input.lengthCm * input.widthCm * input.heightCm) / 1_000_000
  return round2(unitPrice * cbm)
}

export function scenarioOf(price: number, referralFee: number, fulfillmentFee: number, firstMile: number, purchaseCost: number, feeSource: PricingScenario['feeSource']): PricingScenario {
  const profit = round2(price - referralFee - fulfillmentFee - firstMile - purchaseCost)
  const invested = round2(purchaseCost + firstMile)
  return {
    price,
    currency: 'USD',
    referralFee,
    fulfillmentFee,
    firstMileFee: firstMile,
    purchaseCost,
    profit,
    margin: price > 0 ? round4(profit / price) : null,
    roi: invested > 0 ? round4(profit / invested) : null,
    feeSource,
  }
}

/** 公开费率表现算。数字是模型估算，和亚马逊实收不一致时以费用预估接口回写为准。 */
export function estimateFromRateCard(input: PricingInput, amazon: PricingAmazonPlan): PricingCalcResult {
  const sized = sizeTier(input)
  const mile = firstMileFee(input)
  const rate = REFERRAL_RATE[input.category]
  const scenarios = input.prices.map(price => scenarioOf(price, Math.max(REFERRAL_MIN, round2(price * rate)), sized.fulfillmentFee, mile, input.purchaseCost, 'RATE_CARD'))
  return {
    source: 'RATE_CARD',
    rateCardVersion: PRICING_RATE_CARD_VERSION,
    estimateNote: '模型估算，不保证与亚马逊实际收取的费用一致',
    tier: sized.tier,
    tierLabel: sized.tierLabel,
    referralRate: rate,
    scenarios,
    amazon,
    input,
  }
}

/** 费用预估接口只对第一个售价打一次：佣金按售价比例放大，配送费（尺寸不变）沿用这一次。 */
export function withAmazonFees(result: PricingCalcResult, referral: number | null, fulfillment: number | null, priceUsed: number): PricingCalcResult {
  const mile = result.scenarios[0]?.firstMileFee ?? 0
  const purchase = result.input.purchaseCost
  const scenarios = result.scenarios.map(row => {
    const scaled = referral !== null && priceUsed > 0 ? round2((referral * row.price) / priceUsed) : row.referralFee
    const fba = fulfillment !== null ? round2(fulfillment) : row.fulfillmentFee
    return scenarioOf(row.price, scaled, fba, mile, purchase, referral !== null || fulfillment !== null ? 'AMAZON' : row.feeSource)
  })
  return {
    ...result,
    source: referral !== null || fulfillment !== null ? 'AMAZON' : result.source,
    estimateNote: '佣金与配送费已按费用预估接口回写（只对第一个售价请求一次，佣金按售价比例，配送费不变）',
    scenarios,
    amazon: { ...result.amazon, state: 'OK', message: '费用预估接口已返回。佣金按参考售价折算到其他售价，配送费沿用这一次。', priceUsed },
  }
}

export interface PricingEstimateView {
  id: string
  reused: boolean
  canSave: boolean
  saved: boolean
  name: string | null
  estimatedAt: string
  result: PricingCalcResult
}

export interface PricingRecordRow {
  id: string
  name: string | null
  saved: boolean
  estimatedAt: string
  price: number | null
  profit: number | null
  margin: number | null
  currency: 'USD'
  amazonState: AmazonFeeState | null
}

export interface PricingRecordList {
  items: PricingRecordRow[]
  total: number
  page: number
  pageSize: number
}

/** 键顺序固定，供服务端做 sha256。不要在这个文件里用 node:crypto（前端会引用）。 */
export function pricingInputCanonical(input: PricingInput): string {
  return JSON.stringify({
    purchaseCost: input.purchaseCost,
    firstMile: input.firstMile,
    lengthCm: input.lengthCm,
    widthCm: input.widthCm,
    heightCm: input.heightCm,
    weightG: input.weightG,
    category: input.category,
    prices: input.prices,
    referenceAsin: input.referenceAsin,
    storeId: input.storeId,
  })
}
