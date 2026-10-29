import { describe, expect, it } from 'vitest'
import {
  BREAKER_MIN_SESSIONS,
  DEFAULT_BREAKER,
  NO_LIMITS,
  breakEvenOf,
  breakerVerdict,
  checkGuardrails,
  compareSideOf,
  describeScope,
  estimateElasticity,
  evaluatePricingRule,
  marginAtPrice,
  netAtPrice,
  priceAmazonPatches,
  priceChangeText,
  priceCompareOf,
  priceForMargin,
  priceHealthOf,
  priceUnitOf,
  pricingParamsIssue,
  pricingScopeIssue,
  projectAt,
  resolveLimits,
  shouldStorePrice,
  suggestPrice,
  type PriceUnit,
  type TrafficDay,
} from './index.js'

const unit: PriceUnit = { avgPrice: 20, netPerUnit: 4, proportionalShare: 0.3 }

describe('单位经济与利润率', () => {
  it('把合计折成每件经济；没有销量、销售额或成本时不给并说明原因，不是 0', () => {
    const ok = priceUnitOf({ units: 10, revenue: 200, refunds: 10, feeCommission: 30, promotion: 20, profit: 40 })
    expect(ok.state).toBe('OK')
    expect(ok.unit).toEqual({ avgPrice: 20, netPerUnit: 4, proportionalShare: 0.3 })
    expect(priceUnitOf({ units: 0, revenue: 0, refunds: 0, feeCommission: 0, promotion: 0, profit: 0 }).unit).toBeNull()
    expect(priceUnitOf({ units: 3, revenue: 0, refunds: 0, feeCommission: 0, promotion: 0, profit: 1 }).state).toBe('INCOMPLETE')
    const noCost = priceUnitOf({ units: 3, revenue: 60, refunds: 0, feeCommission: 9, promotion: 0, profit: null })
    expect(noCost.unit).toBeNull()
    expect(noCost.note).toContain('成本')
  })

  it('净利润随售价等比例变化：涨 1 元只留下 (1 - 比例) 部分；盈亏平衡价与目标利润率价互相印证', () => {
    expect(netAtPrice(unit, 20)).toBe(4)
    expect(netAtPrice(unit, 21)).toBeCloseTo(4.7, 6)
    expect(marginAtPrice(unit, 20)).toBeCloseTo(0.2, 6)
    expect(marginAtPrice(null, 20)).toBeNull()
    expect(marginAtPrice(unit, 0)).toBeNull()
    expect(breakEvenOf(unit)).toBe(14.29)
    const target = priceForMargin(unit, 0.3) as number
    expect(marginAtPrice(unit, target)).toBeCloseTo(0.3, 2)
    expect(priceForMargin(unit, 0.7)).toBeNull()
  })
})

describe('护栏', () => {
  it('四层合并：每个字段取最具体的一层里有值的那个', () => {
    const merged = resolveLimits([
      { scope: 'STORE', minPrice: 5, maxPrice: 100, minMarginPct: 0.1, maxChangePct: 0.2 },
      { scope: 'SKU', minPrice: 8, maxPrice: null, minMarginPct: null, maxChangePct: null },
    ])
    expect(merged).toEqual({ minPrice: 8, maxPrice: 100, minMarginPct: 0.1, maxChangePct: 0.2 })
  })

  it('返回全部违反项；要求核对利润率却算不出时按拦截处理', () => {
    const limits = { minPrice: 10, maxPrice: 30, minMarginPct: 0.1, maxChangePct: 0.1 }
    expect(checkGuardrails({ price: 20, currentPrice: 20, limits, unit }).map(item => item.code)).toEqual([])
    expect(checkGuardrails({ price: 5, currentPrice: 20, limits, unit }).map(item => item.code)).toEqual(['BELOW_MIN', 'MARGIN_TOO_LOW', 'STEP_TOO_LARGE'])
    expect(checkGuardrails({ price: 40, currentPrice: 38, limits, unit }).map(item => item.code)).toEqual(['ABOVE_MAX'])
    expect(checkGuardrails({ price: 20, currentPrice: 20, limits, unit: null }).map(item => item.code)).toEqual(['MARGIN_UNKNOWN'])
    expect(checkGuardrails({ price: 20, currentPrice: null, limits: NO_LIMITS, unit: null })).toEqual([])
    expect(checkGuardrails({ price: 12, currentPrice: 20, limits: { ...NO_LIMITS, maxChangePct: 0.1 }, unit: null, checkStep: false })).toEqual([])
  })
})

describe('价格健康', () => {
  const base = { ownPrice: 20, expectedPrice: 18, resultStatus: null, ownIsFeatured: null, eligibilityLost: false, hasObservation: true }
  it('按优先级判断：失去资格 > 不符合资格 > 已获得 > 无竞争 > 高于预期 > 未获得 > 未知', () => {
    expect(priceHealthOf({ ...base, eligibilityLost: true, ownIsFeatured: true })).toBe('LOST_ELIGIBILITY')
    expect(priceHealthOf({ ...base, resultStatus: 'VALID_NOT_ELIGIBLE' })).toBe('NOT_ELIGIBLE')
    expect(priceHealthOf({ ...base, ownIsFeatured: true })).toBe('WINNING')
    expect(priceHealthOf({ ...base, resultStatus: 'NO_COMPETING_OFFERS' })).toBe('NO_COMPETITION')
    expect(priceHealthOf(base)).toBe('ABOVE_EXPECTED')
    expect(priceHealthOf({ ...base, ownPrice: 18 })).toBe('NOT_FEATURED')
    expect(priceHealthOf({ ...base, ownPrice: null, expectedPrice: null, hasObservation: false })).toBe('UNKNOWN')
  })
})

describe('规则求价与评估', () => {
  const fact = { sku: 'A', asin: 'B000000001', currentPrice: 20, expectedPrice: 18, lowestOtherPrice: 17.5, unit, limits: NO_LIMITS }
  it('三种策略求价；缺输入时给原因而不是猜', () => {
    expect(suggestPrice('FOLLOW_EXPECTED', { offsetPct: 0.05 }, fact).price).toBe(18.9)
    expect(suggestPrice('MATCH_LOWEST', { offsetAmount: -0.5 }, fact).price).toBe(17)
    expect(suggestPrice('TARGET_MARGIN', { targetMarginPct: 0.3 }, fact).price).not.toBeNull()
    expect(suggestPrice('FOLLOW_EXPECTED', {}, { ...fact, expectedPrice: null }).reason).toContain('预期价格')
    expect(suggestPrice('MATCH_LOWEST', {}, { ...fact, lowestOtherPrice: null }).reason).toContain('竞争报价')
    expect(suggestPrice('TARGET_MARGIN', { targetMarginPct: 0.3 }, { ...fact, unit: null }).reason).toContain('利润率')
  })

  it('单次调幅取规则与护栏中更严的；超出收窄；相同价不命中', () => {
    const spec = { strategy: 'FOLLOW_EXPECTED' as const, params: {}, maxChangePct: 0.05 }
    const clamped = evaluatePricingRule(spec, fact)
    expect(clamped).toMatchObject({ suggestedPrice: 19, result: 'CLAMPED_STEP', hit: true, blocked: false })
    const stricter = evaluatePricingRule(spec, { ...fact, limits: { ...NO_LIMITS, maxChangePct: 0.02 } })
    expect(stricter.suggestedPrice).toBe(19.6)
    expect(evaluatePricingRule(spec, { ...fact, currentPrice: 18 })).toMatchObject({ hit: false, result: 'NO_CHANGE', suggestedPrice: null })
    expect(evaluatePricingRule(spec, { ...fact, currentPrice: null })).toMatchObject({ result: 'NO_INPUT', hit: false })
  })

  it('护栏拦截的也算命中，结果写明拦截原因', () => {
    const spec = { strategy: 'FOLLOW_EXPECTED' as const, params: {}, maxChangePct: 0.5 }
    const blocked = evaluatePricingRule(spec, { ...fact, limits: { ...NO_LIMITS, minPrice: 19 } })
    expect(blocked).toMatchObject({ hit: true, blocked: true, result: 'BLOCKED:BELOW_MIN' })
    expect(blocked.text).toContain('最低价')
  })

  it('参数与范围的问题提示', () => {
    expect(pricingParamsIssue('FOLLOW_EXPECTED', { offsetPct: 0.3 })).toContain('20%')
    expect(pricingParamsIssue('MATCH_LOWEST', { offsetAmount: 30 })).toContain('20')
    expect(pricingParamsIssue('TARGET_MARGIN', {})).toContain('目标利润率')
    expect(pricingParamsIssue('TARGET_MARGIN', { targetMarginPct: 0.25 })).toBeNull()
    expect(pricingScopeIssue({ all: false, skus: [], asins: [] })).toContain('选择')
    expect(pricingScopeIssue({ all: true, skus: [], asins: [] })).toBeNull()
    expect(describeScope({ all: false, skus: ['A', 'B'], asins: ['X'] })).toBe('2 个 SKU、1 个 ASIN')
  })
})

describe('价格弹性与推算', () => {
  const points = (e: number) => Array.from({ length: 12 }, (_, index) => ({ price: 10 + index * 0.5, units: Math.round(100 * ((10 + index * 0.5) / 10) ** e) }))
  it('样本不足、价格没动、价高销量反而高时不给', () => {
    expect(estimateElasticity(points(-2).slice(0, 5)).state).toBe('INSUFFICIENT')
    expect(estimateElasticity(Array.from({ length: 12 }, () => ({ price: 10, units: 50 }))).note).toContain('没有变动')
    expect(estimateElasticity(points(1.5)).state).toBe('INSUFFICIENT')
  })
  it('价高销量低时给出负的弹性，并按弹性推算日销量与日利润', () => {
    const result = estimateElasticity(points(-2))
    expect(result.state).toBe('OK')
    expect(result.value as number).toBeLessThan(-1.5)
    expect(result.value as number).toBeGreaterThan(-2.5)
    const projected = projectAt({ elasticity: -2, baselinePrice: 20, baselineUnits: 10, price: 22, unit })
    expect(projected.unitsPerDay).toBe(8.26)
    expect(projected.profitPerDay).toBeCloseTo(8.26 * netAtPrice(unit, 22), 0)
  })
})

describe('熔断判断', () => {
  const day = (conversionPct: number, sessions: number) => ({ days: 7, unitsPerDay: 1, sessions, conversionPct, buyBoxPct: 0.9 })
  it('连续失败达到次数就熔断；中间有成功就不熔断', () => {
    expect(breakerVerdict(DEFAULT_BREAKER, { recent: ['FAILED', 'FAILED', 'FAILED'], before: null, after: null, realizedMargin: null }).trip).toBe(true)
    expect(breakerVerdict(DEFAULT_BREAKER, { recent: ['FAILED', 'APPLIED', 'FAILED'], before: null, after: null, realizedMargin: null }).trip).toBe(false)
    expect(breakerVerdict(DEFAULT_BREAKER, { recent: ['FAILED', 'FAILED'], before: null, after: null, realizedMargin: null }).trip).toBe(false)
  })
  it('转化率下降要同时满足样本量与阈值；缺数据不熔断', () => {
    const wide = BREAKER_MIN_SESSIONS + 50
    expect(breakerVerdict(DEFAULT_BREAKER, { recent: [], before: day(0.1, wide), after: day(0.05, wide), realizedMargin: null }).trip).toBe(true)
    expect(breakerVerdict(DEFAULT_BREAKER, { recent: [], before: day(0.1, wide), after: day(0.05, 10), realizedMargin: null }).trip).toBe(false)
    expect(breakerVerdict(DEFAULT_BREAKER, { recent: [], before: day(0.1, wide), after: day(0.09, wide), realizedMargin: null }).trip).toBe(false)
    expect(breakerVerdict(DEFAULT_BREAKER, { recent: [], before: null, after: null, realizedMargin: null }).trip).toBe(false)
  })
  it('设置了利润率下限时，实际利润率低于它才熔断；没有数据不熔断', () => {
    const breaker = { ...DEFAULT_BREAKER, minMarginPct: 0.1 }
    expect(breakerVerdict(breaker, { recent: [], before: null, after: null, realizedMargin: 0.05 }).trip).toBe(true)
    expect(breakerVerdict(breaker, { recent: [], before: null, after: null, realizedMargin: 0.2 }).trip).toBe(false)
    expect(breakerVerdict(breaker, { recent: [], before: null, after: null, realizedMargin: null }).trip).toBe(false)
  })
})

describe('改价前后对照', () => {
  const row = (date: string, units: number | null, sessions: number | null, buyBoxPct: number | null, source = 'REPORT'): TrafficDay => ({ date, source, units, sessions, buyBoxPct })
  it('同一天两个来源优先数据中心，不重复相加；转化率只用两个值都有的行', () => {
    const side = compareSideOf([row('2026-10-01', 2, 100, 0.9), row('2026-10-01', 4, 200, 0.8, 'DATA_KIOSK'), row('2026-10-02', 3, 100, 1), row('2026-10-03', null, 50, null)])
    expect(side).toMatchObject({ days: 3, unitsPerDay: 3.5, sessions: 350 })
    expect(side?.conversionPct).toBeCloseTo(7 / 300, 5)
    expect(side?.buyBoxPct).toBeCloseTo((0.8 * 200 + 1 * 100) / 300, 5)
  })
  it('没有任何天数返回 null，不是 0', () => {
    expect(compareSideOf([])).toBeNull()
    expect(compareSideOf([row('2026-10-01', null, null, null)])).toMatchObject({ unitsPerDay: null, sessions: null, conversionPct: null, buyBoxPct: null })
  })
  it('观察期未满等待；两侧都没有数据是没有数据', () => {
    const changedAt = new Date('2026-10-10T00:00:00Z')
    const side = compareSideOf([row('2026-10-01', 1, 10, 0.5)])
    expect(priceCompareOf({ changedAt, now: new Date('2026-10-11T00:00:00Z'), observeDays: 3, before: side, after: null })).toMatchObject({ state: 'WAITING', after: null })
    expect(priceCompareOf({ changedAt, now: new Date('2026-10-20T00:00:00Z'), observeDays: 3, before: null, after: null }).state).toBe('NO_DATA')
    expect(priceCompareOf({ changedAt, now: new Date('2026-10-20T00:00:00Z'), observeDays: 3, before: side, after: side }).state).toBe('OK')
  })
})

describe('快照去重与亚马逊改价内容', () => {
  it('价格变化或超过 24 小时才写快照', () => {
    const last = { price: 10, observedAt: new Date('2026-10-01T00:00:00Z') }
    expect(shouldStorePrice(null, 10, new Date())).toBe(true)
    expect(shouldStorePrice(last, 10, new Date('2026-10-01T12:00:00Z'))).toBe(false)
    expect(shouldStorePrice(last, 10.01, new Date('2026-10-01T01:00:00Z'))).toBe(true)
    expect(shouldStorePrice(last, 10, new Date('2026-10-02T00:00:01Z'))).toBe(true)
  })
  it('改价内容走 purchasable_offer.our_price，价格保留两位小数；令牌文字对价格取整到分', () => {
    const patches = priceAmazonPatches(19.999, 'USD', 'ATVPDKIKX0DER')
    expect(patches[0]).toMatchObject({ op: 'replace', path: '/attributes/purchasable_offer' })
    expect(JSON.stringify(patches)).toContain('"value_with_tax":20')
    expect(priceChangeText('A', 'LUGGAGE', 19.999, 'USD')).toBe(priceChangeText('A', 'LUGGAGE', 20, 'USD'))
    expect(priceChangeText('A', 'LUGGAGE', 20, 'USD')).not.toBe(priceChangeText('A', 'LUGGAGE', 20.01, 'USD'))
  })
})
