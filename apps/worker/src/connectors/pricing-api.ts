import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 定价接口（Product Pricing API v2022-05-01，importers.md I-13）。路径与请求体依据亚马逊官方文档整理，尚未用真实店铺核对（CR-086 未验证清单）：
//   getFeaturedOfferExpectedPriceBatch  POST /batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice
//     { requests: [{ uri: '/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice', method: 'POST', marketplaceId, sku }] }   每批最多 40 个 SKU
//   getCompetitiveSummary               POST /batches/products/pricing/2022-05-01/items/competitiveSummary
//     { requests: [{ uri: '/products/pricing/2022-05-01/items/competitiveSummary', method: 'GET', asin, marketplaceId, includedData: [...], lowestPricedOffersInputs: [...] }] }   每批最多 20 个 ASIN
// 响应是 { responses: [{ status: { statusCode }, request, body }] }：批内个别项失败（statusCode 不是 200）时，失败项单独记录，成功项照常入库（PRC_BATCH_PARTIAL）。
// 限速（官方公布值）：两个批量操作都是每秒 0.033 次（约 30 秒一次）、突发 1：同步器每次只处理有限的批数，用确定性的轮转保证每个商品在若干次运行内都被轮到。固定美国站。

export const PRICING_PATH = '/products/pricing/2022-05-01'
export const FEATURED_BATCH_PATH = `/batches${PRICING_PATH}/offer/featuredOfferExpectedPrice`
export const SUMMARY_BATCH_PATH = `/batches${PRICING_PATH}/items/competitiveSummary`

/** 403（缺“定价”角色）。 */
export const isPricingForbidden = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403

export class PricingApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 每批最多 40 个 SKU：返回获得推荐报价的预期价格。 */
  featuredExpectedPrices(skus: readonly string[]) {
    return this.client.request({
      method: 'POST',
      path: FEATURED_BATCH_PATH,
      body: { requests: skus.map(sku => ({ uri: `${PRICING_PATH}/offer/featuredOfferExpectedPrice`, method: 'POST', marketplaceId: US_MARKETPLACE, sku })) },
    })
  }

  /** 每批最多 20 个 ASIN：推荐购买选项（含会员与非会员分段的浏览权重）、最低价报价、参考价。 */
  competitiveSummaries(asins: readonly string[]) {
    return this.client.request({
      method: 'POST',
      path: SUMMARY_BATCH_PATH,
      body: {
        requests: asins.map(asin => ({
          uri: `${PRICING_PATH}/items/competitiveSummary`,
          method: 'GET',
          asin,
          marketplaceId: US_MARKETPLACE,
          includedData: ['featuredBuyingOptions', 'lowestPricedOffers', 'referencePrices'],
          lowestPricedOffersInputs: [{ itemCondition: 'New', offerType: 'CONSUMER' }],
        })),
      },
    })
  }
}
