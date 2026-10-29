import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 客户反馈接口（Customer Feedback API v2024-06-01，importers.md I-15）。路径与参数依据亚马逊官方文档整理，尚未用真实店铺核对（CR-088 未验证清单）：
//   getItemBrowseNode          GET /customerFeedback/2024-06-01/items/{asin}/browseNode?marketplaceId=
//   getItemReviewTopics        GET /customerFeedback/2024-06-01/items/{asin}/reviews/topics?marketplaceId=&sortBy=MENTIONS
//   getBrowseNodeReviewTrends  GET /customerFeedback/2024-06-01/browseNodes/{browseNodeId}/reviews/trends?marketplaceId=
//   getBrowseNodeReturnTrends  GET /customerFeedback/2024-06-01/browseNodes/{browseNodeId}/returns/trends?marketplaceId=
// 官方一共 7 个操作，我们只用上面 4 个（商品级退货主题没有交付，退货只到类目级）。需要品牌备案与“品牌分析”角色：没有时返回 403。
// 官方限速较慢（每个操作约每秒 0.5 次、突发 1，以官方公布值为准），同步器对 ASIN 与浏览节点串行请求，client 自带的限速守卫与 429 重试照常生效。固定美国站。

export const FEEDBACK_PATH = '/customerFeedback/2024-06-01'

/** 403：店铺没有品牌分析权限（没有品牌备案或没有授予“品牌分析”角色）。 */
export const isFeedbackForbidden = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403

/** 400 / 404：这个 ASIN 或浏览节点没有数据、不被支持；同步器只跳过并计数。 */
export const isFeedbackNoData = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && (error.status === 400 || error.status === 404)

export class FeedbackApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 商品所在的浏览节点（类目）。 */
  getItemBrowseNode(asin: string) {
    return this.client.request({ path: `${FEEDBACK_PATH}/items/${encodeURIComponent(asin)}/browseNode`, query: { marketplaceId: US_MARKETPLACE } })
  }

  /** 商品评论主题（正面与负面），按提及量排序。 */
  getItemReviewTopics(asin: string) {
    return this.client.request({ path: `${FEEDBACK_PATH}/items/${encodeURIComponent(asin)}/reviews/topics`, query: { marketplaceId: US_MARKETPLACE, sortBy: 'MENTIONS' } })
  }

  /** 类目的评论主题月度趋势（全部商品与前 25% 商品）。 */
  getBrowseNodeReviewTrends(browseNodeId: string) {
    return this.client.request({ path: `${FEEDBACK_PATH}/browseNodes/${encodeURIComponent(browseNodeId)}/reviews/trends`, query: { marketplaceId: US_MARKETPLACE } })
  }

  /** 类目的退货主题月度趋势（全部商品与前 25% 商品）。 */
  getBrowseNodeReturnTrends(browseNodeId: string) {
    return this.client.request({ path: `${FEEDBACK_PATH}/browseNodes/${encodeURIComponent(browseNodeId)}/returns/trends`, query: { marketplaceId: US_MARKETPLACE } })
  }
}
