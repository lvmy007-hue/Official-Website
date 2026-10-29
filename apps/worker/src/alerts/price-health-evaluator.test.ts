import { describe, expect, it, vi } from 'vitest'
import { healthHits, priceHealthEvaluator, type HealthTarget } from './price-health-evaluator'

// 价格健康异常预警（P4-15）：与定价页同一个判断函数；高于预期要达到比例阈值、预期价格没给不判断、币种不一致不判断、因价格失去资格单独成立、已获得推荐报价不报。

const target = (over: Partial<HealthTarget> = {}): HealthTarget => ({
  sellerAccountId: 's1',
  sku: 'SKU-A',
  asin: 'B0A',
  ownPrice: 20,
  expectedPrice: 18,
  expectedCurrency: 'USD',
  currency: 'USD',
  resultStatus: 'VALID',
  featuredIsOwn: false,
  featuredPrice: 17.5,
  hasObservation: true,
  eligibilityLost: false,
  ...over,
})
const states = ['ABOVE_EXPECTED', 'LOST_ELIGIBILITY']

describe('healthHits', () => {
  it('价格高于预期且高出比例不小于阈值才算；刚好等于阈值算；差距大的排前面', () => {
    const out = healthHits(
      [
        target({ sku: 'SMALL', ownPrice: 18.4 }), // 2.2%，不到 3%
        target({ sku: 'EQ', ownPrice: 18.54 }), // 3%
        target({ sku: 'BIG', ownPrice: 27 }), // 50%
      ],
      states,
      0.03,
    )
    expect(out.map(item => item.target.sku)).toEqual(['BIG', 'EQ'])
    expect(out[0]).toMatchObject({ state: 'ABOVE_EXPECTED', gap: 9, gapRatio: 0.5 })
  })

  it('已获得推荐报价、不符合资格、没有竞争、价格不高于预期、没有观察：都不报', () => {
    expect(healthHits([target({ featuredIsOwn: true })], states, 0.03)).toEqual([])
    expect(healthHits([target({ resultStatus: 'VALID_NOT_ELIGIBLE' })], states, 0.03)).toEqual([])
    expect(healthHits([target({ resultStatus: 'NO_COMPETING_OFFERS' })], states, 0.03)).toEqual([])
    expect(healthHits([target({ ownPrice: 18 })], states, 0.03)).toEqual([])
    expect(healthHits([target({ expectedPrice: null, expectedCurrency: null, featuredIsOwn: null, hasObservation: false })], states, 0.03)).toEqual([])
  })

  it('预期价格没给（空）不判断，不当 0；预期价格为 0 算不出比例也不报；币种不一致不判断', () => {
    expect(healthHits([target({ expectedPrice: null, expectedCurrency: null })], states, 0.03)).toEqual([])
    expect(healthHits([target({ expectedPrice: 0 })], states, 0.03)).toEqual([])
    expect(healthHits([target({ expectedCurrency: 'CAD' })], states, 0.03)).toEqual([])
  })

  it('因价格失去资格：不看价差，即使已获得推荐报价的旧摘要也以通知为准；阈值里去掉该状态就不报', () => {
    const lost = target({ eligibilityLost: true, expectedPrice: null, expectedCurrency: null, featuredIsOwn: true })
    const out = healthHits([lost], states, 0.03)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ state: 'LOST_ELIGIBILITY', gap: null, gapRatio: null })
    expect(healthHits([lost], ['ABOVE_EXPECTED'], 0.03)).toEqual([])
    expect(healthHits([target()], ['LOST_ELIGIBILITY'], 0.03)).toEqual([])
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'PRD_PRICE_HEALTH',
    domain: 'PRODUCT',
    name: '价格健康异常',
    severity: 'WARNING',
    cooldownMinutes: 4320,
    currentVersion: 1,
    condition: { type: 'pricing.price-health', params },
    scope,
  })
  const now = new Date('2026-10-25T08:00:00Z')
  const when = (hours: number) => new Date(now.getTime() - hours * 3_600_000)
  const price = (sku: string, value: number, hours = 1, over: Record<string, unknown> = {}) => ({
    id: `p-${sku}-${hours}`,
    sellerAccountId: 's1',
    sellerSku: sku,
    asin: '',
    price: value,
    currency: 'USD',
    observedAt: when(hours),
    ...over,
  })
  const expected = (sku: string, value: number | null, status = 'VALID') => ({
    id: `e-${sku}`,
    sellerAccountId: 's1',
    sellerSku: sku,
    expectedPrice: value,
    currency: 'USD',
    resultStatus: status,
    observedAt: when(1),
  })
  const makeDb = (over: Record<string, unknown> = {}) => ({
    priceSnapshot: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [price('SKU-A', 20), price('SKU-A', 15, 30), price('SKU-B', 18.2), price('SKU-C', 30)]) },
    featuredOfferExpectedPrice: {
      findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [expected('SKU-A', 18), expected('SKU-B', 18), expected('SKU-C', 25)]),
    },
    competitiveSummarySnapshot: {
      findMany: vi.fn(async () => [
        { id: 'c1', sellerAccountId: 's1', asin: 'B0A', featuredIsOwn: false, featuredPrice: 17.5, observedAt: when(1) },
        { id: 'c3', sellerAccountId: 's1', asin: 'B0C', featuredIsOwn: true, featuredPrice: 30, observedAt: when(1) },
      ]),
    },
    buyBoxSnapshot: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => []) },
    fbaProduct: {
      findMany: vi.fn(async () => [
        { id: 'prod-A', sellerAccountId: 's1', sellerSku: 'SKU-A', asin: 'B0A', title: '示例商品' },
        { id: 'prod-C', sellerAccountId: 's1', sellerSku: 'SKU-C', asin: 'B0C', title: '商品 C' },
      ]),
    },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
    ...over,
  })

  it('命中：SKU-A 价格 20 高于预期 18（11.1%）；SKU-B 只高 1.1% 不报；SKU-C 已获得推荐报价不报；每个 SKU 取最近一条价格；链到定价详情', async () => {
    const db = makeDb()
    const hits = await priceHealthEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'SKU', entityId: 'prod-A', sellerAccountId: 's1', entityLabel: 'SKU-A（一店）' })
    expect(hits[0].title).toBe('SKU SKU-A 价格高于推荐报价预期价格 11.1%（USD 20 对 18）')
    expect(hits[0].evidence).toMatchObject({
      asin: 'B0A',
      title: '示例商品',
      state: 'ABOVE_EXPECTED',
      stateLabel: '价格高于预期获胜价',
      ownPrice: 20,
      expectedPrice: 18,
      gap: 2,
      gapRatio: 0.1111,
      threshold: 0.03,
      featuredPrice: 17.5,
    })
    const priceWhere = db.priceSnapshot.findMany.mock.calls[0][0].where as { observedAt: { gte: Date } }
    expect(priceWhere.observedAt.gte.toISOString()).toBe('2026-10-22T08:00:00.000Z')
  })

  it('阈值可改：比例调低后 SKU-B 也报；比例夹在允许范围内', async () => {
    const db = makeDb()
    const hits = await priceHealthEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ minGapRatio: 0.01 }), now })
    expect(hits.map(hit => hit.entityLabel)).toEqual(['SKU-A（一店）', 'SKU-B（一店）'])
    const none = await priceHealthEvaluator.evaluate({ db: makeDb() as never, tenantId: 't1', rule: rule({ minGapRatio: 99 }), now })
    expect(none).toEqual([])
  })

  it('因价格失去资格：窗口内有价格标记且之后没有重新获得才算；没有商品记录按店铺|SKU 登记', async () => {
    const lostDb = makeDb({
      priceSnapshot: { findMany: vi.fn(async () => [price('SKU-Z', 10, 1, { asin: 'B0Z' })]) },
      featuredOfferExpectedPrice: { findMany: vi.fn(async () => []) },
      competitiveSummarySnapshot: { findMany: vi.fn(async () => []) },
      fbaProduct: { findMany: vi.fn(async () => []) },
      buyBoxSnapshot: { findMany: vi.fn(async () => [{ sellerAccountId: 's1', asin: 'B0Z', ownIsFeatured: false, lostReason: 'PRICE', observedAt: when(5) }]) },
    })
    const hits = await priceHealthEvaluator.evaluate({ db: lostDb as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'PRICING_SKU', entityId: 's1|SKU-Z' })
    expect(hits[0].title).toBe('SKU SKU-Z 因价格失去推荐报价资格')
    expect(hits[0].evidence).toMatchObject({ state: 'LOST_ELIGIBILITY', stateLabel: '因价格失去推荐报价资格', expectedPrice: null, gap: null })

    const regained = makeDb({
      priceSnapshot: { findMany: vi.fn(async () => [price('SKU-Z', 10, 1, { asin: 'B0Z' })]) },
      featuredOfferExpectedPrice: { findMany: vi.fn(async () => []) },
      competitiveSummarySnapshot: { findMany: vi.fn(async () => []) },
      fbaProduct: { findMany: vi.fn(async () => []) },
      buyBoxSnapshot: {
        findMany: vi.fn(async () => [
          { sellerAccountId: 's1', asin: 'B0Z', ownIsFeatured: true, lostReason: null, observedAt: when(2) },
          { sellerAccountId: 's1', asin: 'B0Z', ownIsFeatured: false, lostReason: 'PRICE', observedAt: when(5) },
        ]),
      },
    })
    expect(await priceHealthEvaluator.evaluate({ db: regained as never, tenantId: 't1', rule: rule(), now })).toEqual([])
  })

  it('没有近 3 天的价格不查别的表；SKU 与店铺范围写进价格查询', async () => {
    const empty = makeDb({ priceSnapshot: { findMany: vi.fn(async () => []) } })
    expect(await priceHealthEvaluator.evaluate({ db: empty as never, tenantId: 't1', rule: rule({}, { sellerAccountIds: ['s1'], skus: ['SKU-A'] }), now })).toEqual([])
    expect(empty.priceSnapshot.findMany.mock.calls[0][0].where).toMatchObject({ sellerAccountId: { in: ['s1'] }, sellerSku: { in: ['SKU-A'] } })
    expect(empty.featuredOfferExpectedPrice.findMany).not.toHaveBeenCalled()
    expect(empty.buyBoxSnapshot.findMany).not.toHaveBeenCalled()
  })
})
