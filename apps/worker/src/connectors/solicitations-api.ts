import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 请求评价接口（Solicitations API v1，importers.md I-16）。路径与参数依据亚马逊官方文档整理，尚未用真实店铺核对（CR-088 未验证清单）：
//   getSolicitationActionsForOrder                       GET  /solicitations/v1/orders/{amazonOrderId}?marketplaceIds=
//   createProductReviewAndSellerFeedbackSolicitation     POST /solicitations/v1/orders/{amazonOrderId}/solicitations/productReviewAndSellerFeedback?marketplaceIds=   成功 201（无响应体）
// 官方限速：两个操作都约每秒 1 次、突发 5；批内逐单串行，client 自带的限速守卫与 429 重试照常生效。固定美国站。
// 查询动作的响应是超媒体格式：可用动作列在 _links.actions（每项 { href, name }）或 _embedded.actions（每项带 _links.self.name），动作名 productReviewAndSellerFeedback 在列表里才允许发起请求。

export const SOLICITATIONS_PATH = '/solicitations/v1/orders'
export const REVIEW_ACTION_NAME = 'productReviewAndSellerFeedback'

type Loose = Record<string, unknown>
const record = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** 查询动作的响应里有没有“请求产品评价与卖家反馈”这个动作。 */
export function hasReviewAction(body: unknown): boolean {
  const root = record(body)
  const base = record(root?.payload) ?? root
  const links = [...list(record(base?._links)?.actions), ...list(record(base?._embedded)?.actions).map(item => record(record(item)?._links)?.self)]
  return links.some(link => record(link)?.name === REVIEW_ACTION_NAME)
}

/** 是 4xx 且不是限速：这一单的请求被亚马逊明确拒绝，不重试（429 与 5xx、网络错误要向上抛让流程重试）。 */
export const isSolicitationRejected = (error: unknown): error is UpstreamHttpError =>
  error instanceof UpstreamHttpError && error.source === 'api' && error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408

/** 亚马逊拒绝时说明“已经请求过”：只读错误信息里的关键词做分类，不记录也不展示原文。 */
export const isAlreadySolicited = (error: unknown): boolean => isSolicitationRejected(error) && /already|previously|duplicate/i.test(error.message)

export class SolicitationsApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 查询订单当前可用的动作。 */
  getActions(amazonOrderId: string) {
    return this.client.request({ path: `${SOLICITATIONS_PATH}/${encodeURIComponent(amazonOrderId)}`, query: { marketplaceIds: US_MARKETPLACE } })
  }

  /** 向买家发起一次“请求产品评价与卖家反馈”（每单亚马逊只允许一次）。 */
  requestReview(amazonOrderId: string) {
    return this.client.request({
      method: 'POST',
      path: `${SOLICITATIONS_PATH}/${encodeURIComponent(amazonOrderId)}/solicitations/${REVIEW_ACTION_NAME}`,
      query: { marketplaceIds: US_MARKETPLACE },
    })
  }
}
