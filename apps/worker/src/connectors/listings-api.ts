import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 商品刊登接口（Listings Items API 2021-08-01，importers.md I-10）与刊登限制接口（Listings Restrictions API 2021-08-01，I-11）。
// 路径与参数依据亚马逊官方文档整理，尚未用真实店铺核对（CR-085 未验证清单）：
//   searchListingsItems  GET   /listings/2021-08-01/items/{sellerId}?marketplaceIds=…&includedData=summaries,issues&pageSize=20&pageToken=…&issuesLocale=en_US
//   patchListingsItem    PATCH /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=…&issueLocale=en_US[&mode=VALIDATION_PREVIEW]    请求体 { productType, patches: [{ op, path, value }] }
//   getListingsRestrictions GET /listings/2021-08-01/restrictions?asin=…&conditionType=…&sellerId=…&marketplaceIds=…&reasonLocale=en_US
// 校验预览（mode=VALIDATION_PREVIEW）只检查不改动；响应的 status 为 VALID 或 INVALID，issues 里是问题。固定美国站。
// 限速（官方公布值）：搜索与修改约每秒 5 次，刊登限制每秒 5 次；沿用按店铺的令牌桶并按响应头校准。

export const LISTINGS_PATH = '/listings/2021-08-01'
export const LISTINGS_PAGE_SIZE = 20
const LOCALE = 'en_US'

/** 403（缺“商品刊登”角色）。 */
export const isListingsForbidden = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403
/** 请求内容被拒（400、404、422）：不是暂时性错误，重试没有意义。 */
export const isListingsRejected = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && [400, 404, 422].includes(error.status)

export interface ListingsPatchBody {
  productType: string
  patches: Array<{ op: string; path: string; value?: unknown }>
}

export class ListingsApi {
  constructor(
    private readonly client: AmazonSpApiClient,
    private readonly sellerId: string,
  ) {}

  /** 取一页刊登（默认摘要与问题；定价同步改取 summaries,offers 读我方报价）；翻页用上一页返回的 nextToken。 */
  search(pageToken?: string, includedData = 'summaries,issues') {
    return this.client.request({
      path: `${LISTINGS_PATH}/items/${encodeURIComponent(this.sellerId)}`,
      query: {
        marketplaceIds: US_MARKETPLACE,
        includedData,
        pageSize: String(LISTINGS_PAGE_SIZE),
        issuesLocale: LOCALE,
        ...(pageToken ? { pageToken } : {}),
      },
    })
  }

  /** 局部修改一个刊登；preview = true 时只做校验预览，不改动亚马逊侧的数据。 */
  patch(sku: string, body: ListingsPatchBody, preview: boolean) {
    return this.client.request({
      method: 'PATCH',
      path: `${LISTINGS_PATH}/items/${encodeURIComponent(this.sellerId)}/${encodeURIComponent(sku)}`,
      query: { marketplaceIds: US_MARKETPLACE, issueLocale: LOCALE, ...(preview ? { mode: 'VALIDATION_PREVIEW' } : {}) },
      body,
    })
  }

  /** 一个 ASIN 的刊登限制（按销售条件，默认新品）。 */
  restrictions(asin: string, conditionType = 'new_new') {
    return this.client.request({
      path: `${LISTINGS_PATH}/restrictions`,
      query: { asin, conditionType, sellerId: this.sellerId, marketplaceIds: US_MARKETPLACE, reasonLocale: LOCALE },
    })
  }
}
