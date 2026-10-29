import { describe, expect, it } from 'vitest'
import { priceBodyOf, isPriceKind } from '../../runtime/price-write'
import { amountOf, parseExpectedPrices, parseOwnPrices, parseSummaries, sellerKeyOf } from './parse'
import { rotate } from './sync'

// 定价同步的解析与轮转（P4-11）。字段依据官方文档整理，没有拿真实响应核对（CR-086 披露）；这里验证解析的容错规则。

const MARKET = 'ATVPDKIKX0DER'

describe('金额与卖家键', () => {
  it('金额要求是正数；文字数字可接受；零、负数、非数字都是 null', () => {
    expect(amountOf(19.99)).toBe(19.99)
    expect(amountOf('19.5')).toBe(19.5)
    for (const bad of [0, -1, '', 'abc', null, undefined, Number.NaN]) expect(amountOf(bad), String(bad)).toBeNull()
  })
  it('别家卖家编号只存 16 位哈希，不存原文，且稳定', () => {
    expect(sellerKeyOf('A1B2C3')).toMatch(/^[0-9a-f]{16}$/)
    expect(sellerKeyOf('A1B2C3')).toBe(sellerKeyOf('A1B2C3'))
    expect(sellerKeyOf('A1B2C3')).not.toBe(sellerKeyOf('A1B2C4'))
  })
})

describe('我方报价（刊登接口）', () => {
  it('取美国站、B2C 的报价；没有报价的刊登计入 withoutPrice；SKU 为空的忽略；返回翻页令牌', () => {
    const parsed = parseOwnPrices({
      items: [
        { sku: 'A', summaries: [{ marketplaceId: MARKET, asin: 'b000000001' }], offers: [{ marketplaceId: MARKET, offerType: 'B2C', price: { currencyCode: 'USD', amount: '19.99' } }] },
        { sku: 'B', summaries: [{ marketplaceId: MARKET, asin: 'B000000002' }], offers: [{ marketplaceId: MARKET, offerType: 'B2B', price: { currencyCode: 'USD', amount: '9' } }] },
        { sku: 'C', summaries: [], offers: [] },
        { sku: '  ', offers: [] },
        { offers: [] },
      ],
      pagination: { nextToken: ' tok ' },
    })
    expect(parsed.items).toEqual([{ sku: 'A', asin: 'B000000001', price: 19.99, currency: 'USD' }])
    expect(parsed.withoutPrice).toBe(2)
    expect(parsed.nextToken).toBe('tok')
  })
  it('响应不是对象时抛错，由任务重试', () => {
    expect(() => parseOwnPrices(null)).toThrow('LISTINGS_RESPONSE_INVALID')
  })
})

describe('推荐报价预期价格', () => {
  it('成功项取预期价与当前推荐报价；批内失败项只计数；缺预期价为 null，不是 0', () => {
    const parsed = parseExpectedPrices({
      responses: [
        {
          status: { statusCode: 200 },
          body: {
            offerIdentifier: { sku: 'A', asin: 'b000000001' },
            featuredOfferExpectedPriceResults: [
              {
                resultStatus: 'VALID_FOEP',
                featuredOfferExpectedPrice: { listingPrice: { amount: 18.5, currencyCode: 'USD' } },
                currentFeaturedOffer: { price: { listingPrice: { amount: 20, currencyCode: 'USD' } } },
              },
            ],
          },
        },
        { status: { statusCode: 200 }, body: { offerIdentifier: { sku: 'B' }, featuredOfferExpectedPriceResults: [{ resultStatus: 'NO_COMPETING_OFFERS' }] } },
        { status: { statusCode: 429 }, body: {}, request: { sku: 'C' } },
        { status: { statusCode: 200 }, body: { featuredOfferExpectedPriceResults: [] } },
      ],
    })
    expect(parsed.failed).toBe(2)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toMatchObject({ sku: 'A', asin: 'B000000001', expectedPrice: 18.5, currentFeaturedPrice: 20, resultStatus: 'VALID_FOEP' })
    expect(parsed.rows[1]).toMatchObject({ sku: 'B', expectedPrice: null, currentFeaturedPrice: null, resultStatus: 'NO_COMPETING_OFFERS' })
  })
})

describe('竞争摘要', () => {
  const offer = (sellerId: string, amount: number, extra: Record<string, unknown> = {}) => ({
    sellerId,
    listingPrice: { amount, currencyCode: 'USD' },
    condition: 'New',
    fulfillmentType: 'AFN',
    ...extra,
  })
  const response = {
    responses: [
      {
        status: { statusCode: 200 },
        body: {
          asin: 'b000000001',
          featuredBuyingOptions: [
            {
              segmentedFeaturedOffers: [
                offer('ME', 20, {
                  featuredOfferSegments: [
                    { customerMembership: 'PRIME', segmentDetails: { glanceViewWeightPercentage: 62.5 } },
                    { customerMembership: 'NON_MEMBER', segmentDetails: { glanceViewWeightPercentage: 30 } },
                  ],
                }),
              ],
            },
          ],
          lowestPricedOffers: [{ offers: [offer('OTHER1', 17.5, { shippingOptions: [{ price: { amount: 3 } }] }), offer('OTHER2', 19, { fulfillmentType: 'MFN' }), offer('OTHER3', 0)] }],
          referencePrices: [{ name: 'CompetitivePriceThreshold', price: { amount: 21, currencyCode: 'USD' } }],
        },
      },
      { status: { statusCode: 404 }, body: {}, request: { asin: 'B000000002' } },
      { status: { statusCode: 200 }, body: {} },
    ],
  }

  it('识别我方、浏览权重按百分数转成小数、最低价与参考价、报价按价格升序且不存卖家原文', () => {
    const parsed = parseSummaries(response, 'ME')
    expect(parsed.failed).toBe(2)
    const row = parsed.rows[0]!
    expect(row).toMatchObject({
      asin: 'B000000001',
      hasFeatured: true,
      featuredPrice: 20,
      featuredIsOwn: true,
      viewWeightMember: 0.625,
      viewWeightNonMember: 0.3,
      referencePrice: 21,
      referencePriceType: 'CompetitivePriceThreshold',
      lowestPrice: 17.5,
    })
    expect(row.offers.map(item => item.price)).toEqual([17.5, 19, 20])
    expect(row.offers.find(item => item.price === 17.5)).toMatchObject({ isOwn: false, shipping: 3, fulfillment: 'FBA' })
    expect(row.offers.find(item => item.price === 19)?.fulfillment).toBe('FBM')
    expect(JSON.stringify(parsed)).not.toContain('OTHER1')
    expect(row.offers.find(item => item.isOwn)?.offerKey).toBe(sellerKeyOf('ME'))
  })

  it('不知道我方卖家编号时不标记“我方”；没有推荐报价时是 null 而不是 false', () => {
    const noFeatured = parseSummaries({ responses: [{ status: { statusCode: 200 }, body: { asin: 'B000000009', lowestPricedOffers: [{ offers: [offer('X', 10)] }] } }] }, '')
    expect(noFeatured.rows[0]).toMatchObject({ hasFeatured: false, featuredIsOwn: null, featuredPrice: null, lowestPrice: 10 })
    expect(parseSummaries(response, '').rows[0]?.offers.every(item => !item.isOwn)).toBe(true)
  })

  it('权重超出 0 到 100 当作没有', () => {
    const parsed = parseSummaries(
      {
        responses: [
          {
            status: { statusCode: 200 },
            body: {
              asin: 'B000000008',
              featuredBuyingOptions: [{ segmentedFeaturedOffers: [offer('X', 10, { featuredOfferSegments: [{ customerMembership: 'PRIME', segmentDetails: { glanceViewWeightPercentage: 140 } }] })] }],
            },
          },
        ],
      },
      '',
    )
    expect(parsed.rows[0]?.viewWeightMember).toBeNull()
  })
})

describe('同步范围轮转', () => {
  const items = Array.from({ length: 10 }, (_, index) => index)
  it('容量够用时每次全量', () => {
    expect(rotate(items, 10, new Date())).toEqual(items)
  })
  it('容量不够时同一时间槽选同一段，相邻时间槽接着往后，若干次后每个都会被轮到', () => {
    const slot = 2 * 3_600_000
    const base = Math.floor(Date.UTC(2026, 9, 1) / slot) * slot
    expect(rotate(items, 4, new Date(base + 1000))).toEqual(rotate(items, 4, new Date(base + slot - 1000)))
    const seen = new Set<number>()
    for (let step = 0; step < 5; step += 1) for (const item of rotate(items, 4, new Date(base + step * slot))) seen.add(item)
    expect(seen.size).toBe(10)
  })
})

describe('改价写入记录的请求内容', () => {
  it('价格必须是正数；币种默认美元；来源默认手工；规则执行记录编号可为空', () => {
    expect(priceBodyOf({ price: 19.99, currency: 'USD', asin: 'B1', source: 'RULE_AUTO', ruleRunId: 'r1' })).toEqual({
      price: 19.99,
      currency: 'USD',
      asin: 'B1',
      source: 'RULE_AUTO',
      ruleRunId: 'r1',
    })
    expect(priceBodyOf({ price: 5 })).toEqual({ price: 5, currency: 'USD', asin: '', source: 'MANUAL', ruleRunId: null })
    for (const bad of [null, {}, { price: 0 }, { price: -1 }, { price: '5' }, []]) expect(priceBodyOf(bad)).toBeNull()
  })
  it('只有两种改价记录类型算价格写入', () => {
    expect(isPriceKind('PRICE_PATCH')).toBe(true)
    expect(isPriceKind('PRICE_VALIDATE')).toBe(true)
    expect(isPriceKind('PATCH')).toBe(false)
  })
})
