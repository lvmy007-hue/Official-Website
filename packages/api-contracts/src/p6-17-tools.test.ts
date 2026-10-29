import { describe, expect, it } from 'vitest'
import { hijackDelayNote, hijackMaxDelayHours, sellerHintOf, sellerRefOf } from './hijack.js'
import { HijackWhitelistBodySchema } from './hijack-query.js'
import { NO_LIMITS, type GuardrailLimits } from './pricing.js'
import { evaluatePricingRule, type PricingFact } from './pricing-math.js'
import { PRICING_SITUATIONS, normalizeMatrix, scenarioMatrixIssue, situationOf, type ScenarioMatrix } from './pricing-scenario.js'
import { ScenarioMatrixSchema } from './pricing-query.js'
import { combineDepth, isDeep, isStacked, itemDepthOf, peakStacking, stackRowsOf, type StackItemInput, type StackPromotionInput } from './promo-stacking.js'

const T0 = Date.UTC(2026, 9, 27, 0, 0, 0)
const H = 3_600_000

describe('促销叠加：重叠边界（半开区间）', () => {
  it('首尾相接不算叠加：A 的结束时刻等于 B 的开始时刻', () => {
    const peak = peakStacking(
      [
        { id: 'a', start: T0, end: T0 + 10 * H, depth: 0.2 },
        { id: 'b', start: T0 + 10 * H, end: T0 + 20 * H, depth: 0.2 },
      ],
      T0,
    )
    expect(peak?.count).toBe(1)
  })

  it('相差 1 毫秒的重叠就算叠加，叠加深度逐层叠乘', () => {
    const peak = peakStacking(
      [
        { id: 'a', start: T0, end: T0 + 10 * H + 1, depth: 0.2 },
        { id: 'b', start: T0 + 10 * H, end: T0 + 20 * H, depth: 0.3 },
      ],
      T0,
    )
    expect(peak?.count).toBe(2)
    expect(peak?.depth).toBeCloseTo(1 - 0.8 * 0.7, 6)
    expect(peak?.promotionIds).toEqual(['a', 'b'])
  })

  it('结束时间为空表示长期有效；只看从现在起的时段，已结束的不计', () => {
    const peak = peakStacking(
      [
        { id: 'old', start: T0 - 20 * H, end: T0 - 10 * H, depth: 0.5 },
        { id: 'run', start: T0 - 5 * H, end: null, depth: 0.1 },
        { id: 'next', start: T0 + 5 * H, end: null, depth: 0.1 },
      ],
      T0,
    )
    expect(peak?.count).toBe(2)
    expect(peak?.from).toBe(T0 + 5 * H)
    expect(peak?.to).toBeNull()
    expect(peakStacking([{ id: 'old', start: T0 - 20 * H, end: T0, depth: 0.5 }], T0)).toBeNull()
  })

  it('算不出深度的促销计数但不参与深度，并单独计数', () => {
    const peak = peakStacking(
      [
        { id: 'a', start: T0, end: null, depth: 0.25 },
        { id: 'b', start: T0, end: null, depth: null },
      ],
      T0,
    )
    expect(peak).toMatchObject({ count: 2, unknownDepth: 1 })
    expect(peak?.depth).toBeCloseTo(0.25, 6)
    expect(combineDepth([])).toBeNull()
  })

  it('折扣深度口径：百分比直接用，立减与固定价要有当前价，赠品算不出', () => {
    const base = { benefitType: null, discountType: null, percentOff: null, amountOff: null, fixedPrice: null }
    expect(itemDepthOf({ ...base, discountType: 'PERCENTAGE_OFF', percentOff: 20 }, null)).toBeCloseTo(0.2, 6)
    expect(itemDepthOf({ ...base, discountType: 'AMOUNT_OFF', amountOff: 5 }, 25)).toBeCloseTo(0.2, 6)
    expect(itemDepthOf({ ...base, discountType: 'AMOUNT_OFF', amountOff: 5 }, null)).toBeNull()
    expect(itemDepthOf({ ...base, benefitType: 'FIXED_PRICE', fixedPrice: 15 }, 20)).toBeCloseTo(0.25, 6)
    expect(itemDepthOf({ ...base, benefitType: 'FIXED_PRICE', fixedPrice: 25 }, 20)).toBe(0)
    expect(itemDepthOf({ ...base, discountType: 'FREE_GIFT' }, 20)).toBeNull()
  })

  it('阈值边界：叠加数与深度恰好等于下限都算命中', () => {
    expect(isStacked({ peakCount: 2 }, 2)).toBe(true)
    expect(isStacked({ peakCount: 1 }, 2)).toBe(false)
    expect(isDeep({ depth: 0.3 }, 0.3)).toBe(true)
    expect(isDeep({ depth: 0.2999 }, 0.3)).toBe(false)
    expect(isDeep({ depth: null }, 0.3)).toBe(false)
  })

  it('按 店铺 × ASIN 归并：同一促销里同一 ASIN 多行只算一次，只算进行中与即将开始', () => {
    const promo = (rowId: string, status: string, start: number, end: number | null): StackPromotionInput => ({
      rowId,
      promotionId: `P-${rowId}`,
      title: rowId,
      type: 'PRICE_DISCOUNT',
      status,
      startAt: new Date(start),
      endAt: end === null ? null : new Date(end),
      sellerAccountId: 's1',
    })
    const item = (promotionRowId: string, asin: string, sku: string, percentOff: number): StackItemInput => ({
      promotionRowId,
      sellerAccountId: 's1',
      asin,
      sku,
      benefitType: null,
      discountType: 'PERCENTAGE_OFF',
      percentOff,
      amountOff: null,
      fixedPrice: null,
    })
    const rows = stackRowsOf(
      [promo('a', 'RUNNING', T0 - H, T0 + 10 * H), promo('b', 'UPCOMING', T0 + 5 * H, T0 + 15 * H), promo('c', 'ENDED', T0 - 9 * H, T0 + 5 * H), promo('d', 'RUNNING', T0 + 10 * H, T0 + 20 * H)],
      [item('a', 'B0A', 'sku1', 10), item('a', 'B0A', 'sku2', 15), item('b', 'B0A', 'sku1', 20), item('c', 'B0A', 'sku1', 50), item('d', 'B0B', 'sku3', 10), item('b', 'B0B', 'sku3', 10)],
      () => null,
      T0,
    )
    const a = rows.find(row => row.asin === 'B0A')
    expect(a).toMatchObject({ promotionCount: 2, peakCount: 2 })
    // 同一促销里同一 ASIN 取深度最大的一行：15% 与 20% 叠加
    expect(a?.depth).toBeCloseTo(1 - 0.85 * 0.8, 6)
    // B0B：b 在 T0+15h 结束，d 在 T0+10h 开始，叠加时段 [10h, 15h)
    expect(rows.find(row => row.asin === 'B0B')?.peakCount).toBe(2)
    expect(rows[0]!.asin).toBe('B0A')
  })
})

describe('定价情形矩阵：判断情形与护栏', () => {
  const limits = (patch: Partial<GuardrailLimits> = {}): GuardrailLimits => ({ ...NO_LIMITS, ...patch })
  const fact = (patch: Partial<PricingFact>): PricingFact => ({
    sku: 's',
    asin: 'B0A',
    currentPrice: 12,
    expectedPrice: null,
    lowestOtherPrice: 11,
    unit: null,
    limits: limits({ minPrice: 8, maxPrice: 18 }),
    ownIsFeatured: null,
    ...patch,
  })

  it('五种情形各自命中，顺序为失去推荐报价优先', () => {
    expect(situationOf({ currentPrice: 12, ownIsFeatured: false, lowestOtherPrice: 11, minPrice: 8, maxPrice: 18 })).toBe('LOST_BUYBOX')
    expect(situationOf({ currentPrice: 10, ownIsFeatured: true, lowestOtherPrice: 10, minPrice: 8, maxPrice: 18 })).toBe('I_AM_LOWEST')
    expect(situationOf({ currentPrice: 12, ownIsFeatured: null, lowestOtherPrice: 7, minPrice: 8, maxPrice: 18 })).toBe('OTHER_BELOW_MIN')
    expect(situationOf({ currentPrice: 25, ownIsFeatured: null, lowestOtherPrice: 20, minPrice: 8, maxPrice: 18 })).toBe('OTHER_ABOVE_MAX')
    expect(situationOf({ currentPrice: 12, ownIsFeatured: null, lowestOtherPrice: 11, minPrice: 8, maxPrice: 18 })).toBe('OTHER_BETWEEN')
    expect(situationOf({ currentPrice: 12, ownIsFeatured: null, lowestOtherPrice: null, minPrice: 8, maxPrice: 18 })).toBeNull()
    expect(situationOf({ currentPrice: null, ownIsFeatured: null, lowestOtherPrice: 11, minPrice: 8, maxPrice: 18 })).toBeNull()
    // 对方恰好等于最低价边界不算“低于我的最低价”
    expect(situationOf({ currentPrice: 12, ownIsFeatured: null, lowestOtherPrice: 8, minPrice: 8, maxPrice: 18 })).toBe('OTHER_BETWEEN')
    expect(PRICING_SITUATIONS).toHaveLength(5)
  })

  const matrix = (cells: ScenarioMatrix['cells'], basePrice: number | null = null): ScenarioMatrix => ({ cells, basePrice })
  const spec = (m: ScenarioMatrix | null, maxChangePct = 0.9) => ({ strategy: 'FOLLOW_EXPECTED' as const, params: {}, maxChangePct, matrix: m })

  it('护栏之内的格子：跟随对方价格减 0.5 得到建议价', () => {
    const result = evaluatePricingRule(spec(matrix({ OTHER_BETWEEN: { action: 'FOLLOW_OTHER', offset: -0.5 } })), fact({}))
    expect(result).toMatchObject({ hit: true, blocked: false, suggestedPrice: 10.5, situation: 'OTHER_BETWEEN' })
    expect(result.text).toContain('对方介于我的最低价和最高价之间')
  })

  it('护栏之外的格子不执行：目标价低于最低价被拦截，并写明原因', () => {
    const result = evaluatePricingRule(spec(matrix({ OTHER_BELOW_MIN: { action: 'FOLLOW_OTHER', offset: -1 } })), fact({ lowestOtherPrice: 7 }))
    expect(result).toMatchObject({ hit: true, blocked: true, situation: 'OTHER_BELOW_MIN' })
    expect(result.result).toBe('BLOCKED:BELOW_MIN')
    expect(result.text).toContain('最低价')
  })

  it('调到最高价但超过最高价护栏之外的目标：被拦截；没设护栏的一侧算不出目标价，不调价并写原因', () => {
    const blocked = evaluatePricingRule(spec(matrix({ OTHER_ABOVE_MAX: { action: 'FOLLOW_OTHER', offset: 3 } })), fact({ currentPrice: 25, lowestOtherPrice: 20 }))
    expect(blocked.result).toBe('BLOCKED:ABOVE_MAX')
    const noMax = evaluatePricingRule(spec(matrix({ LOST_BUYBOX: { action: 'TO_MAX' } })), fact({ ownIsFeatured: false, limits: limits({ minPrice: 8 }) }))
    expect(noMax).toMatchObject({ hit: false, result: 'NO_INPUT' })
    expect(noMax.text).toContain('最高价')
  })

  it('这一格不调价：不命中也不报错；单次调幅仍然收窄', () => {
    const none = evaluatePricingRule(spec(matrix({ OTHER_BETWEEN: { action: 'NONE' }, LOST_BUYBOX: { action: 'TO_MIN' } })), fact({}))
    expect(none).toMatchObject({ hit: false, result: 'NO_ACTION', situation: 'OTHER_BETWEEN' })
    const clamped = evaluatePricingRule(spec(matrix({ OTHER_BETWEEN: { action: 'TO_MIN' } }), 0.05), fact({}))
    expect(clamped).toMatchObject({ hit: true, blocked: false, result: 'CLAMPED_STEP', suggestedPrice: 11.4 })
  })

  it('回到基础价：优先用矩阵里的基础价，没有时取近 30 天平均成交价，都没有则算不出', () => {
    const withBase = evaluatePricingRule(spec(matrix({ OTHER_BETWEEN: { action: 'TO_BASE' } }, 13)), fact({}))
    expect(withBase.suggestedPrice).toBe(13)
    const fromUnit = evaluatePricingRule(spec(matrix({ OTHER_BETWEEN: { action: 'TO_BASE' } })), fact({ unit: { avgPrice: 14, netPerUnit: 5, proportionalShare: 0 } }))
    expect(fromUnit.suggestedPrice).toBe(14)
    const nothing = evaluatePricingRule(spec(matrix({ OTHER_BETWEEN: { action: 'TO_BASE' } })), fact({}))
    expect(nothing).toMatchObject({ hit: false, result: 'NO_INPUT' })
  })

  it('没有矩阵时按策略求价，行为不变', () => {
    const result = evaluatePricingRule({ strategy: 'MATCH_LOWEST', params: { offsetAmount: -0.5 }, maxChangePct: 0.5, matrix: null }, fact({}))
    expect(result).toMatchObject({ hit: true, suggestedPrice: 10.5 })
    expect(result.situation ?? null).toBeNull()
  })

  it('矩阵校验：全是不调价、加减额超范围、基础价不是正数都拒绝；脏数据规整成不调价', () => {
    expect(scenarioMatrixIssue(matrix({}))).toContain('没有任何会调价的格子')
    expect(scenarioMatrixIssue(matrix({ OTHER_BETWEEN: { action: 'FOLLOW_OTHER', offset: 21 } }))).toContain('加减额')
    expect(scenarioMatrixIssue(matrix({ OTHER_BETWEEN: { action: 'TO_MIN' } }, 0))).toContain('基础价')
    expect(scenarioMatrixIssue(matrix({ OTHER_BETWEEN: { action: 'TO_MIN' } }))).toBeNull()
    expect(normalizeMatrix(null)).toBeNull()
    expect(normalizeMatrix({ cells: { OTHER_BETWEEN: { action: 'FLY' }, I_AM_LOWEST: { action: 'TO_MAX' } }, basePrice: 'x' })).toEqual({
      cells: { I_AM_LOWEST: { action: 'TO_MAX' } },
      basePrice: null,
    })
    expect(ScenarioMatrixSchema.safeParse({ cells: { OTHER_BETWEEN: { action: 'TO_MIN' } } }).success).toBe(true)
    expect(ScenarioMatrixSchema.safeParse({ cells: {} }).success).toBe(false)
  })
})

describe('跟卖监控：延迟说明与白名单录入', () => {
  it('最长延迟随商品数轮转：不超过一次同步容量时 2 小时，超过则翻倍', () => {
    expect(hijackMaxDelayHours(0)).toBe(2)
    expect(hijackMaxDelayHours(600)).toBe(2)
    expect(hijackMaxDelayHours(601)).toBe(4)
    expect(hijackDelayNote(2)).toContain('最长延迟 2 小时')
    expect(hijackDelayNote(2)).toContain('不抓前台页面')
  })

  it('卖家只给提示与哈希前缀，不给原文', () => {
    expect(sellerHintOf('a1b2c3d4e5f6g7')).toBe('A1…G7')
    expect(sellerHintOf('ABCDEF')).toBe('A…F')
    expect(sellerRefOf('0123456789abcdef')).toBe('卖家 012345')
  })

  it('白名单录入：去空白、转大写，太短或带符号的拒绝', () => {
    expect(HijackWhitelistBodySchema.parse({ sellerId: ' a1b2c3d4e5f6g7 ', note: '  自己的欧洲店 ' })).toEqual({ sellerId: 'A1B2C3D4E5F6G7', note: '自己的欧洲店' })
    expect(HijackWhitelistBodySchema.safeParse({ sellerId: 'A1B2' }).success).toBe(false)
    expect(HijackWhitelistBodySchema.safeParse({ sellerId: 'A1B2C3D4-E5' }).success).toBe(false)
    expect(HijackWhitelistBodySchema.safeParse({ sellerId: 'A1B2C3D4E5', extra: 1 }).success).toBe(false)
  })
})
