import { describe, expect, it } from 'vitest'
import {
  chargeableWeightOf,
  estimateFreight,
  estimateGap,
  isDeviationAbnormal,
  matchesGapFilter,
  missingFreightFields,
  pickRate,
  rateAmount,
  ratesConflict,
  shipmentGapsOf,
  volumetricWeightKg,
  type RateTier,
} from './freight-pricing'
import { CarrierCreateBodySchema, ChannelCreateBodySchema, FillItemsBodySchema, RateCreateBodySchema, RateUpdateBodySchema } from './carriers'

const tier = (over: Partial<RateTier>): RateTier => ({
  id: 't',
  region: 'US-West',
  weightFrom: 0,
  weightTo: null,
  unitPrice: 5,
  currency: 'USD',
  billingMode: 'PER_KG',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  ...over,
})

describe('计费重量', () => {
  it('体积重 = 体积 × 1,000,000 ÷ 材积除数', () => {
    expect(volumetricWeightKg(1, 6000)).toBeCloseTo(166.6667, 4)
    expect(volumetricWeightKg(0.06, 6000)).toBe(10)
  })

  it('实重大于体积重时按实重', () => {
    const result = chargeableWeightOf({ actualKg: 100, volumeCbm: 0.3, volumetricDivisor: 6000, splitFactor: 1 })
    expect(result).toMatchObject({ actualKg: 100, volumetricKg: 50, chargeableKg: 100, bulky: false })
  })

  it('体积重大于实重且分抛系数为 1 时取较大者', () => {
    const result = chargeableWeightOf({ actualKg: 100, volumeCbm: 1.2, volumetricDivisor: 6000, splitFactor: 1 })
    expect(result).toMatchObject({ volumetricKg: 200, chargeableKg: 200, bulky: true })
  })

  it('分抛系数 0.5：多出的体积重只算一半', () => {
    expect(chargeableWeightOf({ actualKg: 100, volumeCbm: 1.2, volumetricDivisor: 6000, splitFactor: 0.5 }).chargeableKg).toBe(150)
  })

  it('体积重刚好等于实重不算泡货', () => {
    const result = chargeableWeightOf({ actualKg: 50, volumeCbm: 0.3, volumetricDivisor: 6000, splitFactor: 0.5 })
    expect(result.bulky).toBe(false)
    expect(result.chargeableKg).toBe(50)
  })
})

describe('阶梯价边界', () => {
  const tiers = [tier({ id: 'a', weightFrom: 0, weightTo: 45 }), tier({ id: 'b', weightFrom: 45, weightTo: 100, unitPrice: 4 }), tier({ id: 'c', weightFrom: 100, weightTo: null, unitPrice: 3 })]
  const pick = (weightKg: number, region = 'US-West', on = '2026-06-01') => pickRate(tiers, { region, weightKg, on })?.id ?? null

  it('下限含、上限不含', () => {
    expect(pick(0)).toBe('a')
    expect(pick(44.9999)).toBe('a')
    expect(pick(45)).toBe('b')
    expect(pick(99.9999)).toBe('b')
    expect(pick(100)).toBe('c')
    expect(pick(10_000)).toBe('c')
  })

  it('地区不同没有报价；生效区间之外没有报价', () => {
    expect(pick(50, 'US-East')).toBeNull()
    expect(pickRate([tier({ effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31' })], { region: 'US-West', weightKg: 10, on: '2026-04-01' })).toBeNull()
    expect(pickRate([tier({ effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31' })], { region: 'US-West', weightKg: 10, on: '2026-03-31' })).not.toBeNull()
  })

  it('三种计费方式', () => {
    expect(rateAmount({ billingMode: 'PER_KG', unitPrice: 4.5 }, { chargeableKg: 100, volumeCbm: 9 })).toBe(450)
    expect(rateAmount({ billingMode: 'PER_CBM', unitPrice: 120 }, { chargeableKg: 100, volumeCbm: 0.35 })).toBe(42)
    expect(rateAmount({ billingMode: 'FLAT', unitPrice: 80 }, { chargeableKg: 100, volumeCbm: 9 })).toBe(80)
  })
})

describe('报价冲突', () => {
  const base = { weightFrom: 0, weightTo: 45, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }
  it('重量段重叠且生效区间重叠才冲突', () => {
    expect(ratesConflict(base, { ...base, weightFrom: 30, weightTo: 60 })).toBe(true)
    expect(ratesConflict(base, { ...base, weightFrom: 45, weightTo: 60 })).toBe(false)
    expect(ratesConflict(base, { ...base, effectiveFrom: '2026-07-01', effectiveTo: null })).toBe(false)
    expect(ratesConflict(base, { ...base, effectiveFrom: '2026-06-30', effectiveTo: null })).toBe(true)
    expect(ratesConflict({ ...base, weightTo: null }, { weightFrom: 999, weightTo: null, effectiveFrom: '2026-02-01', effectiveTo: null })).toBe(true)
  })
})

describe('头程预估', () => {
  const channel = { volumetricDivisor: 6000, splitFactor: 1 }
  const tiers = [tier({ weightFrom: 0, weightTo: 100, unitPrice: 5 }), tier({ id: 'big', weightFrom: 100, weightTo: null, unitPrice: 4 })]
  const items = [
    { sku: 'A', quantity: 10, weightKg: 60, volumeCbm: 0.2 },
    { sku: 'B', quantity: 5, weightKg: 30, volumeCbm: 0.1 },
  ]

  it('合计重量与体积后按计费重量找阶梯价', () => {
    const result = estimateFreight({ items, channel, tiers, region: 'US-West', on: '2026-06-01', shipmentCurrency: 'USD' })
    expect(result).toMatchObject({ state: 'OK', actualKg: 90, volumeCbm: 0.3, volumetricKg: 50, chargeableKg: 90, amount: 450, currency: 'USD' })
  })

  it('泡货按体积重落到更高的阶梯', () => {
    const bulky = [{ sku: 'A', quantity: 1, weightKg: 60, volumeCbm: 0.9 }]
    const result = estimateFreight({ items: bulky, channel, tiers, region: 'US-West', on: '2026-06-01' })
    expect(result).toMatchObject({ chargeableKg: 150, bulky: true, amount: 600 })
    expect(result.tier?.id).toBe('big')
  })

  it('缺重量或体积不预估，逐个 SKU 列出缺什么', () => {
    const result = estimateFreight({
      items: [
        { sku: 'A', quantity: 1, weightKg: null, volumeCbm: 0.1 },
        { sku: 'B', quantity: 1, weightKg: 5, volumeCbm: null },
        { sku: 'C', quantity: 1, weightKg: 0, volumeCbm: 0 },
      ],
      channel,
      tiers,
      region: 'US-West',
      on: '2026-06-01',
    })
    expect(result.state).toBe('BLOCKED')
    expect(result.block).toBe('MISSING_FIELDS')
    expect(result.missing).toEqual([
      { sku: 'A', missing: ['WEIGHT'] },
      { sku: 'B', missing: ['VOLUME'] },
    ])
    expect(result.amount).toBeNull()
  })

  it('重量填 0 不算缺', () => {
    expect(missingFreightFields([{ sku: 'C', quantity: 1, weightKg: 0, volumeCbm: 0 }])).toEqual([])
  })

  it('没有匹配报价不预估并写明原因；币种不一致不换算', () => {
    const none = estimateFreight({ items, channel, tiers, region: 'EU', on: '2026-06-01' })
    expect(none).toMatchObject({ state: 'BLOCKED', block: 'NO_RATE', amount: null })
    expect(none.reason).toContain('EU')
    const cny = estimateFreight({ items, channel, tiers: [tier({ currency: 'CNY' })], region: 'US-West', on: '2026-06-01', shipmentCurrency: 'USD' })
    expect(cny).toMatchObject({ state: 'BLOCKED', block: 'CURRENCY_MISMATCH', amount: null })
  })

  it('没有明细不预估', () => {
    expect(estimateFreight({ items: [], channel, tiers, region: 'US-West', on: '2026-06-01' }).state).toBe('BLOCKED')
  })
})

describe('预估与实际的差异', () => {
  it('差异与比例；任何一边没有就没有差异', () => {
    expect(estimateGap(1000, 1250)).toEqual({ diff: 250, pct: 25 })
    expect(estimateGap(1000, 900)).toEqual({ diff: -100, pct: -10 })
    expect(estimateGap(null, 900)).toEqual({ diff: null, pct: null })
    expect(estimateGap(1000, null)).toEqual({ diff: null, pct: null })
    expect(estimateGap(0, 50)).toEqual({ diff: 50, pct: null })
  })

  it('异常单：比例绝对值达到阈值（含）', () => {
    expect(isDeviationAbnormal(20, 20)).toBe(true)
    expect(isDeviationAbnormal(-20.1, 20)).toBe(true)
    expect(isDeviationAbnormal(19.9, 20)).toBe(false)
    expect(isDeviationAbnormal(null, 20)).toBe(false)
  })
})

describe('货件三种数量差异', () => {
  it('两两相减；签收相关的差异只在货件关闭后判定', () => {
    expect(shipmentGapsOf({ declared: 100, shipped: 95, received: 90, closed: true })).toEqual({ declaredVsShipped: 5, shippedVsReceived: 5, declaredVsReceived: 10 })
    expect(shipmentGapsOf({ declared: 100, shipped: 95, received: 90, closed: false })).toEqual({ declaredVsShipped: 5, shippedVsReceived: null, declaredVsReceived: null })
  })

  it('没有数据的一边不拿 0 顶替', () => {
    expect(shipmentGapsOf({ declared: null, shipped: 95, received: null, closed: true })).toEqual({ declaredVsShipped: null, shippedVsReceived: null, declaredVsReceived: null })
  })

  it('快捷筛选：申报大于签收、已发大于签收', () => {
    const short = shipmentGapsOf({ declared: 100, shipped: 100, received: 90, closed: true })
    expect(matchesGapFilter(short, 'DECLARED_GT_RECEIVED')).toBe(true)
    expect(matchesGapFilter(short, 'SHIPPED_GT_RECEIVED')).toBe(true)
    expect(matchesGapFilter(short, 'DECLARED_GT_SHIPPED')).toBe(false)
    const over = shipmentGapsOf({ declared: 100, shipped: 100, received: 110, closed: true })
    expect(matchesGapFilter(over, 'DECLARED_GT_RECEIVED')).toBe(false)
  })
})

describe('请求校验', () => {
  it('物流商与渠道代码转大写；分抛系数在 0 到 1 之间', () => {
    expect(CarrierCreateBodySchema.parse({ name: '甲', code: 'abc-1' }).code).toBe('ABC-1')
    expect(CarrierCreateBodySchema.safeParse({ name: '甲', code: '中文' }).success).toBe(false)
    expect(ChannelCreateBodySchema.safeParse({ name: '空运', code: 'AIR', volumetricDivisor: 6000, splitFactor: 0 }).success).toBe(false)
    expect(ChannelCreateBodySchema.safeParse({ name: '空运', code: 'AIR', volumetricDivisor: 6000, splitFactor: 1.2 }).success).toBe(false)
    expect(ChannelCreateBodySchema.safeParse({ name: '空运', code: 'AIR', volumetricDivisor: 0, splitFactor: 1 }).success).toBe(false)
    expect(ChannelCreateBodySchema.safeParse({ name: '空运', code: 'AIR', volumetricDivisor: 6000, splitFactor: 0.5 }).success).toBe(true)
  })

  it('报价：上限大于下限、截止日不早于起始日、币种大写', () => {
    const ok = { region: 'US-West', weightFrom: 0, weightTo: 45, unitPrice: 5, currency: 'usd', billingMode: 'PER_KG', effectiveFrom: '2026-01-01', effectiveTo: null }
    expect(RateCreateBodySchema.parse(ok).currency).toBe('USD')
    expect(RateCreateBodySchema.safeParse({ ...ok, weightTo: 0 }).success).toBe(false)
    expect(RateCreateBodySchema.safeParse({ ...ok, effectiveTo: '2025-12-31' }).success).toBe(false)
    expect(RateCreateBodySchema.safeParse({ ...ok, unitPrice: -1 }).success).toBe(false)
    expect(RateCreateBodySchema.safeParse({ ...ok, billingMode: 'BAD' }).success).toBe(false)
    expect(RateUpdateBodySchema.safeParse({ version: 1, unitPrice: 6 }).success).toBe(true)
  })

  it('批量补录至少一行', () => {
    expect(FillItemsBodySchema.safeParse({ version: 1, rows: [] }).success).toBe(false)
    expect(FillItemsBodySchema.safeParse({ version: 1, rows: [{ sku: 'A', weightKg: 3 }] }).success).toBe(true)
  })
})
