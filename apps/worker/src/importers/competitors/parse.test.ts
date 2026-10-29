import { describe, expect, it } from 'vitest'
import { parseSummaries } from '../pricing/parse'
import { competitorPriceOf, imageCountOf, parseCompetitorCatalog, snapshotFieldsOf } from './parse'

// 竞品监控的响应解析（P4-12）。字段依据官方文档整理，没有拿真实响应核对（CR-087 披露）；这里验证容错规则：缺字段给 null，不当 0。

const US = 'ATVPDKIKX0DER'

const catalogBody = {
  items: [
    {
      asin: 'B0COMPET01',
      summaries: [{ marketplaceId: US, brand: 'Acme', itemName: '  Acme 24 inch Luggage  ' }],
      images: [
        {
          marketplaceId: US,
          images: [
            { variant: 'MAIN', link: 'https://x/1.jpg' },
            { variant: 'MAIN', link: 'https://x/1-large.jpg' },
            { variant: 'PT01', link: 'https://x/2.jpg' },
            { variant: 'PT02', link: 'https://x/3.jpg' },
          ],
        },
      ],
      salesRanks: [
        {
          marketplaceId: US,
          classificationRanks: [{ classificationId: '3000', title: 'Suitcases', rank: 120 }],
          displayGroupRanks: [{ websiteDisplayGroup: 'luggage_display_on_website', title: 'Luggage', rank: 4500 }],
        },
      ],
    },
    { asin: 'B0COMPET02', summaries: [{ marketplaceId: US }] },
    { summaries: [] },
  ],
}

describe('商品目录（竞品）', () => {
  it('取标题、品牌、按变体去重的图片数量与主排名（展示组优先）；没有 ASIN 的项计入 skipped', () => {
    const { items, skipped } = parseCompetitorCatalog(catalogBody)
    expect(skipped).toBe(1)
    expect(items[0]).toEqual({
      asin: 'B0COMPET01',
      title: 'Acme 24 inch Luggage',
      brand: 'Acme',
      imageCount: 3,
      rank: { classificationId: 'display:luggage_display_on_website', name: 'Luggage', rank: 4500 },
    })
  })

  it('什么都没给的竞品：标题、品牌、图片数量、排名都是 null，不是空串或 0', () => {
    expect(parseCompetitorCatalog(catalogBody).items[1]).toEqual({ asin: 'B0COMPET02', title: null, brand: null, imageCount: null, rank: null })
    expect(parseCompetitorCatalog(null)).toEqual({ items: [], skipped: 0 })
    expect(parseCompetitorCatalog({ items: 'x' })).toEqual({ items: [], skipped: 0 })
  })

  it('图片数量：别的站点的图片不算；没有变体字段按地址去重；一张都没有是 null', () => {
    expect(
      imageCountOf([
        { marketplaceId: 'OTHER', images: [{ variant: 'MAIN', link: 'a' }] },
        { marketplaceId: US, images: [{ link: 'a' }, { link: 'a' }, { link: 'b' }] },
      ]),
    ).toBe(2)
    expect(
      imageCountOf([
        { marketplaceId: 'OTHER', images: [{ variant: 'MAIN', link: 'a' }] },
        { marketplaceId: 'OTHER2', images: [] },
      ]),
    ).toBeNull()
    expect(imageCountOf([{ marketplaceId: US, images: [] }])).toBeNull()
    expect(imageCountOf(undefined)).toBeNull()
  })
})

const summaryBody = (body: Record<string, unknown>) => parseSummaries({ responses: [{ status: { statusCode: 200 }, body: { asin: 'B0COMPET01', ...body } }] }, '').rows[0]!

describe('竞争摘要（竞品）', () => {
  it('有推荐报价：价格取推荐报价，状态为有推荐报价，配送方式来自推荐报价（统一成 FBA / FBM）', () => {
    const row = summaryBody({
      featuredBuyingOptions: [
        {
          segmentedFeaturedOffers: [
            {
              sellerId: 'X',
              listingPrice: { amount: 24.5, currencyCode: 'USD' },
              fulfillmentType: 'AFN',
              condition: 'New',
              featuredOfferSegments: [{ customerMembership: 'PRIME', segmentDetails: { glanceViewWeightPercentage: 80 } }],
            },
          ],
        },
      ],
      lowestPricedOffers: [{ offers: [{ sellerId: 'Y', listingPrice: { amount: 20, currencyCode: 'USD' }, fulfillmentType: 'MFN', condition: 'New' }] }],
    })
    expect(competitorPriceOf(row)).toMatchObject({ price: 24.5, currency: 'USD', featured: 'HAS_FEATURED', fulfillment: 'FBA' })
  })

  it('没有推荐报价：价格取最低报价，状态为没有推荐报价，会员资格没有结论（null）', () => {
    const row = summaryBody({ lowestPricedOffers: [{ offers: [{ sellerId: 'Y', listingPrice: { amount: 20, currencyCode: 'USD' }, fulfillmentType: 'MFN', condition: 'New' }] }] })
    expect(competitorPriceOf(row)).toEqual({ price: 20, currency: 'USD', featured: 'NONE', fulfillment: 'FBM', memberEligible: null })
  })

  it('一个报价都没有：价格为 null，仍然是“没有推荐报价”', () => {
    expect(competitorPriceOf(summaryBody({}))).toMatchObject({ price: null, featured: 'NONE', fulfillment: null })
  })
})

describe('快照字段拼接', () => {
  it('某个接口没返回这个 ASIN 时对应字段为 null（交给合并沿用上一条），不当 0', () => {
    const catalog = parseCompetitorCatalog(catalogBody).items[0]
    const summary = summaryBody({ lowestPricedOffers: [{ offers: [{ sellerId: 'Y', listingPrice: { amount: 20, currencyCode: 'USD' }, fulfillmentType: 'AFN', condition: 'New' }] }] })
    expect(snapshotFieldsOf(undefined, undefined)).toMatchObject({
      title: null,
      brand: null,
      imageCount: null,
      price: null,
      featured: null,
      fulfillment: null,
      memberEligible: null,
      rank: null,
      rankClassificationId: null,
    })
    expect(snapshotFieldsOf(catalog, undefined)).toMatchObject({ title: 'Acme 24 inch Luggage', price: null, featured: null, rank: 4500 })
    expect(snapshotFieldsOf(undefined, summary)).toMatchObject({ title: null, price: 20, featured: 'NONE', rank: null, currency: 'USD' })
  })
})
