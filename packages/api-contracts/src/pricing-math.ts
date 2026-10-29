import {
  BREAKER_MIN_SESSIONS,
  GUARDRAIL_SPECIFICITY,
  PRICE_HEALTH_LABEL,
  PRICING_LIMITS,
  PRICING_MARKETPLACE_ID,
  PRICING_STRATEGY_LABEL,
  type GuardrailLimits,
  type GuardrailScope,
  type GuardrailViolation,
  type PriceCompareSide,
  type PriceHealth,
  type PricingBreaker,
  type PricingParams,
  type PricingRuleSpec,
  type PricingStrategy,
  type PricingTargetScope,
} from './pricing.js'
import { PRICING_ACTION_LABEL, PRICING_SITUATION_LABEL, describeCell, scenarioTarget, situationOf, type PricingSituation } from './pricing-scenario.js'

// 定价的纯计算（P4-11）：单位经济与利润率、护栏检查、价格健康、规则求价与评估、价格弹性估算、熔断判断、亚马逊改价内容。前端、接口与 worker 共用同一份。
// 价格一律保留两位小数；null 永远表示“没有数据”，不是 0。

export const round2 = (value: number): number => Math.round(value * 100) / 100
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
export const priceText = (value: number | null): string => (value === null ? '—' : `$${value.toFixed(2)}`)
const pctText = (value: number): string => `${round2(value * 100)}%`

// ---- 单位经济与利润率 ----

/** 每件的平均售价、净利润，以及随售价等比例变化的份额（佣金、退款、促销 ÷ 销售额）。 */
export interface PriceUnit {
  avgPrice: number
  netPerUnit: number
  proportionalShare: number
}
export interface UnitTotals {
  units: number
  revenue: number
  refunds: number
  feeCommission: number
  promotion: number
  /** 范围内净利润合计；只要有一行缺成本算不出就是 null。 */
  profit: number | null
}
export interface PriceUnitResult {
  state: 'OK' | 'NO_UNITS' | 'INCOMPLETE'
  unit: PriceUnit | null
  note: string | null
}

/** 把利润日表的合计折成每件经济；没有销量、没有销售额或净利润算不出时不给，并写明原因。 */
export function priceUnitOf(totals: UnitTotals): PriceUnitResult {
  if (totals.units <= 0) return { state: 'NO_UNITS', unit: null, note: '近 30 天这个商品没有销量，无法折算每件经济，利润率不给' }
  if (totals.revenue <= 0) return { state: 'INCOMPLETE', unit: null, note: '近 30 天没有销售额，无法折算平均售价，利润率不给' }
  if (totals.profit === null) return { state: 'INCOMPLETE', unit: null, note: '这个商品缺少生效的成本，净利润算不出，利润率不给（在商品成本页补全）' }
  return {
    state: 'OK',
    note: null,
    unit: {
      avgPrice: round6(totals.revenue / totals.units),
      netPerUnit: round6(totals.profit / totals.units),
      proportionalShare: round6((totals.refunds + totals.feeCommission + totals.promotion) / totals.revenue),
    },
  }
}

/** 按目标售价估算每件净利润（与 ASIN 360 的价格模拟同一公式）。 */
export function netAtPrice(unit: PriceUnit, price: number): number {
  return round6(unit.netPerUnit + (price - unit.avgPrice) * (1 - unit.proportionalShare))
}
export function marginAtPrice(unit: PriceUnit | null, price: number | null): number | null {
  if (!unit || price === null || !Number.isFinite(price) || price <= 0) return null
  return round6(netAtPrice(unit, price) / price)
}
/** 净利润为 0 的售价；比例项吃掉全部涨幅时为 null。 */
export function breakEvenOf(unit: PriceUnit): number | null {
  const keep = 1 - unit.proportionalShare
  return keep > 0.000001 ? round2(unit.avgPrice - unit.netPerUnit / keep) : null
}
/** 达到目标利润率所需的售价；目标不可能达到（利润率上限低于目标）时为 null。 */
export function priceForMargin(unit: PriceUnit, margin: number): number | null {
  const keep = 1 - unit.proportionalShare
  if (keep <= margin + 0.000001) return null
  const price = (unit.avgPrice * keep - unit.netPerUnit) / (keep - margin)
  return Number.isFinite(price) && price > 0 ? round2(price) : null
}

// ---- 护栏 ----

export interface GuardrailRow extends GuardrailLimits {
  scope: GuardrailScope
}

/** 多层护栏合并：每个字段取最具体的一层里有值的那个（SKU > ASIN > 类目 > 店铺）。 */
export function resolveLimits(rows: readonly GuardrailRow[]): GuardrailLimits {
  const ordered = [...rows].sort((a, b) => GUARDRAIL_SPECIFICITY.indexOf(a.scope) - GUARDRAIL_SPECIFICITY.indexOf(b.scope))
  const pick = (field: keyof GuardrailLimits): number | null => ordered.find(row => row[field] !== null)?.[field] ?? null
  return { minPrice: pick('minPrice'), maxPrice: pick('maxPrice'), minMarginPct: pick('minMarginPct'), maxChangePct: pick('maxChangePct') }
}

export const hasAnyLimit = (limits: GuardrailLimits): boolean => Object.values(limits).some(value => value !== null)

/** 价格护栏的校验：返回全部违反项（空数组表示通过）。要求核对利润率却算不出时按拦截处理，不放行。 */
export function checkGuardrails(input: { price: number; currentPrice: number | null; limits: GuardrailLimits; unit: PriceUnit | null; checkStep?: boolean }): GuardrailViolation[] {
  const { price, currentPrice, limits, unit } = input
  const out: GuardrailViolation[] = []
  if (limits.minPrice !== null && price < limits.minPrice) out.push({ code: 'BELOW_MIN', text: `价格 ${priceText(price)} 低于最低价 ${priceText(limits.minPrice)}` })
  if (limits.maxPrice !== null && price > limits.maxPrice) out.push({ code: 'ABOVE_MAX', text: `价格 ${priceText(price)} 高于最高价 ${priceText(limits.maxPrice)}` })
  if (limits.minMarginPct !== null) {
    const margin = marginAtPrice(unit, price)
    if (margin === null) out.push({ code: 'MARGIN_UNKNOWN', text: `设置了最低利润率 ${pctText(limits.minMarginPct)}，但这个商品的利润率算不出（缺成本或没有销量），无法验证，按拦截处理` })
    else if (margin < limits.minMarginPct) out.push({ code: 'MARGIN_TOO_LOW', text: `预计利润率 ${pctText(margin)} 低于最低利润率 ${pctText(limits.minMarginPct)}` })
  }
  if (input.checkStep !== false && limits.maxChangePct !== null && currentPrice !== null && currentPrice > 0) {
    const change = Math.abs(price - currentPrice) / currentPrice
    if (change > limits.maxChangePct + 0.000001) out.push({ code: 'STEP_TOO_LARGE', text: `调幅 ${pctText(change)} 超过单次调幅上限 ${pctText(limits.maxChangePct)}` })
  }
  return out
}

// ---- 价格健康 ----

export interface HealthInput {
  ownPrice: number | null
  expectedPrice: number | null
  resultStatus: string | null
  ownIsFeatured: boolean | null
  /** 最近一次“价格健康”通知标记失去资格（推送暂缓，目前只可能来自后续接入）。 */
  eligibilityLost: boolean
  hasObservation: boolean
}

export function priceHealthOf(input: HealthInput): PriceHealth {
  if (input.eligibilityLost) return 'LOST_ELIGIBILITY'
  const status = input.resultStatus ?? ''
  if (/NOT_ELIGIBLE/.test(status)) return 'NOT_ELIGIBLE'
  if (input.ownIsFeatured === true) return 'WINNING'
  if (/NO_COMPETING/.test(status)) return 'NO_COMPETITION'
  if (input.ownPrice !== null && input.expectedPrice !== null) return input.ownPrice > input.expectedPrice + 0.005 ? 'ABOVE_EXPECTED' : 'NOT_FEATURED'
  return input.hasObservation ? 'NOT_FEATURED' : 'UNKNOWN'
}
export const priceHealthLabel = (state: PriceHealth): string => PRICE_HEALTH_LABEL[state]

// ---- 规则 ----

export interface PricingFact {
  sku: string
  asin: string
  currentPrice: number | null
  expectedPrice: number | null
  /** 其他卖家里最低的报价（不含我方）。 */
  lowestOtherPrice: number | null
  unit: PriceUnit | null
  limits: GuardrailLimits
  /** 最近一次推荐报价观察里我方是否获得者（P6-17 情形矩阵用）；没有观察为 null/缺省。 */
  ownIsFeatured?: boolean | null
}

/** 策略求价：算不出时返回原因，不猜。 */
export function suggestPrice(
  strategy: PricingStrategy,
  params: PricingParams,
  fact: Pick<PricingFact, 'expectedPrice' | 'lowestOtherPrice' | 'unit'>,
): { price: number | null; reason: string | null } {
  if (strategy === 'FOLLOW_EXPECTED') {
    if (fact.expectedPrice === null) return { price: null, reason: '没有推荐报价的预期价格' }
    return { price: round2(fact.expectedPrice * (1 + (params.offsetPct ?? 0))), reason: null }
  }
  if (strategy === 'MATCH_LOWEST') {
    if (fact.lowestOtherPrice === null) return { price: null, reason: '没有其他卖家的竞争报价' }
    const price = round2(fact.lowestOtherPrice + (params.offsetAmount ?? 0))
    return price > 0 ? { price, reason: null } : { price: null, reason: '按差额算出的价格不是正数' }
  }
  if (params.targetMarginPct === undefined) return { price: null, reason: '规则没有设置目标利润率' }
  if (!fact.unit) return { price: null, reason: '这个商品的利润率算不出（缺成本或没有销量）' }
  const price = priceForMargin(fact.unit, params.targetMarginPct)
  return price === null ? { price: null, reason: '目标利润率在当前成本结构下无法达到' } : { price, reason: null }
}

export const GUARDRAIL_RESULT_TEXT: Record<string, string> = {
  PASS: '通过护栏',
  CLAMPED_STEP: '按单次调幅上限收窄后通过护栏',
  NO_CHANGE: '建议价与当前价相同，无需调整',
  NO_INPUT: '缺少求价所需的数据',
  NO_ACTION: '所处情形配置为不调价',
  'BLOCKED:BELOW_MIN': '低于最低价，被拦截',
  'BLOCKED:ABOVE_MAX': '高于最高价，被拦截',
  'BLOCKED:MARGIN_TOO_LOW': '低于最低利润率，被拦截',
  'BLOCKED:MARGIN_UNKNOWN': '利润率算不出，无法验证最低利润率，被拦截',
  'BLOCKED:STEP_TOO_LARGE': '超过单次调幅上限，被拦截',
}
export const guardrailResultText = (code: string): string => GUARDRAIL_RESULT_TEXT[code] ?? code

export interface RuleEvaluation {
  rawPrice: number | null
  suggestedPrice: number | null
  result: string
  text: string
  /** 规则命中：算出了与当前价不同的建议价（被护栏拦截的也算命中，结果里写明拦截）。 */
  hit: boolean
  blocked: boolean
  /** 用了情形矩阵时，这个商品所处的情形（没用矩阵或判断不出为空）。 */
  situation?: PricingSituation | null
}

/** 规则对一个 SKU 的评估：求价 → 单次调幅收窄（规则与护栏取更严的）→ 最低价、最高价、最低利润率检查。 */
export function evaluatePricingRule(spec: Pick<PricingRuleSpec, 'strategy' | 'params' | 'maxChangePct' | 'matrix'>, fact: PricingFact): RuleEvaluation {
  const none = (result: string, text: string): RuleEvaluation => ({ rawPrice: null, suggestedPrice: null, result, text, hit: false, blocked: false })
  if (fact.currentPrice === null || fact.currentPrice <= 0) return none('NO_INPUT', '没有当前价格')
  let situation: PricingSituation | null = null
  let raw: { price: number | null; reason: string | null }
  if (spec.matrix) {
    // 情形 × 动作矩阵（P6-17）：先判断所处情形，再按这一格的动作求目标价；这一格不调价或算不出目标价都不命中，目标价之后与策略求价走同一套调幅收窄与护栏检查
    situation = situationOf({
      currentPrice: fact.currentPrice,
      ownIsFeatured: fact.ownIsFeatured ?? null,
      lowestOtherPrice: fact.lowestOtherPrice,
      minPrice: fact.limits.minPrice,
      maxPrice: fact.limits.maxPrice,
    })
    if (situation === null) return { ...none('NO_INPUT', '没有推荐报价观察，也没有其他卖家的报价，判断不出所处情形'), situation }
    const cell = spec.matrix.cells[situation]
    const target = scenarioTarget(cell, { lowestOtherPrice: fact.lowestOtherPrice, limits: fact.limits, unit: fact.unit, basePrice: spec.matrix.basePrice })
    if (target.price === null) {
      const label = PRICING_SITUATION_LABEL[situation]
      return target.reason === null
        ? { ...none('NO_ACTION', `${label}：${PRICING_ACTION_LABEL[cell?.action ?? 'NONE']}`), situation }
        : { ...none('NO_INPUT', `${label}：${target.reason}`), situation }
    }
    raw = { price: target.price, reason: null }
  } else raw = suggestPrice(spec.strategy, spec.params, fact)
  if (raw.price === null) return none('NO_INPUT', raw.reason ?? '算不出建议价')
  const step = Math.min(spec.maxChangePct, fact.limits.maxChangePct ?? spec.maxChangePct)
  const move = (raw.price - fact.currentPrice) / fact.currentPrice
  let price = raw.price
  let result = 'PASS'
  if (Math.abs(move) > step + 0.000001) {
    price = round2(fact.currentPrice * (1 + Math.sign(move) * step))
    result = 'CLAMPED_STEP'
  }
  // 用了矩阵时，说明里带上所处情形与这一格的动作，建议、被拦截的记录都能看出“为什么是这个价”
  const prefix = situation !== null && spec.matrix ? `${PRICING_SITUATION_LABEL[situation]}→${describeCell(spec.matrix.cells[situation])}；` : ''
  if (Math.abs(price - fact.currentPrice) < 0.01)
    return { rawPrice: raw.price, suggestedPrice: null, result: 'NO_CHANGE', text: `${prefix}${guardrailResultText('NO_CHANGE')}`, hit: false, blocked: false, situation }
  const violations = checkGuardrails({ price, currentPrice: fact.currentPrice, limits: fact.limits, unit: fact.unit, checkStep: false })
  if (violations.length > 0) {
    const code = `BLOCKED:${violations[0]!.code}`
    return { rawPrice: raw.price, suggestedPrice: price, result: code, text: `${prefix}${violations.map(item => item.text).join('；')}`, hit: true, blocked: true, situation }
  }
  return { rawPrice: raw.price, suggestedPrice: price, result, text: `${prefix}${guardrailResultText(result)}`, hit: true, blocked: false, situation }
}

export function describeParams(strategy: PricingStrategy, params: PricingParams): string {
  if (strategy === 'FOLLOW_EXPECTED') {
    const offset = params.offsetPct ?? 0
    return offset === 0 ? '等于预期获胜价' : `预期获胜价${offset > 0 ? '上浮' : '下浮'} ${pctText(Math.abs(offset))}`
  }
  if (strategy === 'MATCH_LOWEST') {
    const offset = params.offsetAmount ?? 0
    return offset === 0 ? '与最低竞争报价相同' : `最低竞争报价${offset > 0 ? '加' : '减'} ${priceText(Math.abs(offset))}`
  }
  return params.targetMarginPct === undefined ? '未设置目标利润率' : `目标利润率 ${pctText(params.targetMarginPct)}`
}
export const describeStrategy = (strategy: PricingStrategy, params: PricingParams): string => `${PRICING_STRATEGY_LABEL[strategy]}：${describeParams(strategy, params)}`

export function describeScope(scope: PricingTargetScope): string {
  if (scope.all) return '店铺内全部商品'
  const parts: string[] = []
  if (scope.skus.length > 0) parts.push(`${scope.skus.length} 个 SKU`)
  if (scope.asins.length > 0) parts.push(`${scope.asins.length} 个 ASIN`)
  return parts.length > 0 ? parts.join('、') : '没有选择商品'
}
/** 策略参数的问题（没有问题返回 null）：前后端共用。 */
export function pricingParamsIssue(strategy: PricingStrategy, params: PricingParams): string | null {
  if (strategy === 'FOLLOW_EXPECTED') {
    const offset = params.offsetPct ?? 0
    return Number.isFinite(offset) && Math.abs(offset) <= 0.2 ? null : '相对预期获胜价的浮动要在 -20% 到 20% 之间'
  }
  if (strategy === 'MATCH_LOWEST') {
    const offset = params.offsetAmount ?? 0
    return Number.isFinite(offset) && Math.abs(offset) <= 20 ? null : '与最低竞争报价的差额要在 -20 到 20 美元之间'
  }
  const target = params.targetMarginPct
  return target !== undefined && Number.isFinite(target) && target >= 0.01 && target <= 0.9 ? null : '目标利润率要在 1% 到 90% 之间'
}
export function pricingScopeIssue(scope: PricingTargetScope): string | null {
  if (!scope.all && scope.skus.length === 0 && scope.asins.length === 0) return '请选择规则适用的商品（全部商品，或指定 SKU、ASIN）'
  if (scope.skus.length + scope.asins.length > PRICING_LIMITS.ruleSkusMax) return `指定的 SKU 与 ASIN 合计最多 ${PRICING_LIMITS.ruleSkusMax} 个`
  return null
}

export const scopeIncludes = (scope: PricingTargetScope, sku: string, asin: string): boolean => scope.all || scope.skus.includes(sku) || (asin !== '' && scope.asins.includes(asin))

// ---- 价格弹性（估算） ----

export interface ElasticityResult {
  state: 'OK' | 'INSUFFICIENT'
  value: number | null
  samples: number
  note: string
}
const ELASTICITY_MIN_SAMPLES = 8
const ELASTICITY_MIN_SPREAD = 1.03

/** 对数回归：ln(销量) = a + e × ln(价格)。样本不足、价格没有变动或结果不是负数时不给，并写原因。 */
export function estimateElasticity(points: ReadonlyArray<{ price: number; units: number }>): ElasticityResult {
  const usable = points.filter(point => point.price > 0 && point.units > 0)
  const samples = usable.length
  const fail = (note: string): ElasticityResult => ({ state: 'INSUFFICIENT', value: null, samples, note })
  if (samples < ELASTICITY_MIN_SAMPLES) return fail(`有价格和销量的天数只有 ${samples} 天，少于 ${ELASTICITY_MIN_SAMPLES} 天，不估算弹性`)
  const prices = usable.map(point => point.price)
  if (Math.max(...prices) / Math.min(...prices) < ELASTICITY_MIN_SPREAD) return fail('这段时间价格几乎没有变动（不足 3%），看不出价格对销量的影响')
  const xs = usable.map(point => Math.log(point.price))
  const ys = usable.map(point => Math.log(point.units))
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const mx = mean(xs)
  const my = mean(ys)
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0)
  if (sxx === 0) return fail('价格没有变化，无法估算')
  const slope = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index]! - my), 0) / sxx
  if (!(slope < 0)) return fail('历史上价格与销量没有呈现“价高销量低”的关系，无法给出可信的弹性')
  return { state: 'OK', value: round2(Math.max(slope, -5)), samples, note: '' }
}

/** 按弹性推算新价格下的日销量与日利润（估算）。 */
export function projectAt(input: { elasticity: number; baselinePrice: number; baselineUnits: number; price: number; unit: PriceUnit }): { unitsPerDay: number; profitPerDay: number } {
  const units = input.baselineUnits * (input.price / input.baselinePrice) ** input.elasticity
  return { unitsPerDay: round2(units), profitPerDay: round2(units * netAtPrice(input.unit, input.price)) }
}

// ---- 熔断 ----

export interface BreakerInput {
  /** 这条规则最近几次已有结论的执行结果，新的在前。 */
  recent: ReadonlyArray<'APPLIED' | 'FAILED'>
  before: PriceCompareSide | null
  after: PriceCompareSide | null
  /** 调价后一段时间内实际的利润率（利润日表）；没有为 null。 */
  realizedMargin: number | null
}

export function breakerVerdict(breaker: PricingBreaker, input: BreakerInput): { trip: boolean; reason: string | null } {
  const streak = input.recent.slice(0, breaker.failureStreak)
  if (breaker.failureStreak > 0 && streak.length === breaker.failureStreak && streak.every(item => item === 'FAILED')) return { trip: true, reason: `连续 ${breaker.failureStreak} 次执行失败` }
  const { before, after } = input
  if (breaker.conversionDropPct !== null && before && after && before.conversionPct !== null && after.conversionPct !== null && before.conversionPct > 0) {
    const enough = (before.sessions ?? 0) >= BREAKER_MIN_SESSIONS && (after.sessions ?? 0) >= BREAKER_MIN_SESSIONS
    const drop = (before.conversionPct - after.conversionPct) / before.conversionPct
    if (enough && drop >= breaker.conversionDropPct)
      return { trip: true, reason: `调价后转化率从 ${pctText(before.conversionPct)} 降到 ${pctText(after.conversionPct)}（下降 ${pctText(drop)}，阈值 ${pctText(breaker.conversionDropPct)}）` }
  }
  if (breaker.minMarginPct !== null && input.realizedMargin !== null && input.realizedMargin < breaker.minMarginPct) {
    return { trip: true, reason: `调价后实际利润率 ${pctText(input.realizedMargin)} 低于熔断阈值 ${pctText(breaker.minMarginPct)}` }
  }
  return { trip: false, reason: null }
}

// ---- 快照去重与亚马逊改价内容 ----

/** 价格快照只在价格变化、或距上一条已超过 24 小时（心跳）时才写。 */
export function shouldStorePrice(last: { price: number; observedAt: Date } | null, price: number, now: Date): boolean {
  if (!last) return true
  return Math.abs(last.price - price) >= 0.005 || now.getTime() - last.observedAt.getTime() >= PRICING_LIMITS.heartbeatMs
}

/** 亚马逊刊登接口的改价内容（purchasable_offer.our_price）。 */
export function priceAmazonPatches(price: number, currency: string, marketplaceId: string = PRICING_MARKETPLACE_ID): Array<{ op: string; path: string; value: unknown }> {
  return [{ op: 'replace', path: '/attributes/purchasable_offer', value: [{ marketplace_id: marketplaceId, currency, our_price: [{ schedule: [{ value_with_tax: round2(price) }] }] }] }]
}
/** 校验预览令牌的稳定文字：提交时的 SKU、商品类型、价格与币种必须与校验过的完全一致。 */
export const priceChangeText = (sku: string, productType: string, price: number, currency: string): string => JSON.stringify({ sku, productType, price: round2(price), currency })
