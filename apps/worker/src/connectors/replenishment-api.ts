import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 补货接口（Replenishment API v2022-11-07，importers.md I-19，订阅省）。路径、请求体、枚举于 2026 年 10 月对照亚马逊官方模型文件复核
// （selling-partner-api-models/models/replenishment-api-model/replenishment-2022-11-07.json）：
//   getSellingPartnerMetrics  POST /replenishment/2022-11-07/sellingPartners/metrics/search   卖家整体指标
//   listOffers                POST /replenishment/2022-11-07/offers/search                    报价列表（含官方预测出货：forecastDeliveries）
//   listOfferMetrics          POST /replenishment/2022-11-07/offers/metrics/search            报价指标（按 SKU 的出货件数等）
// 三个操作都是 POST（请求体里放过滤条件）。约束：programTypes 目前只有 SUBSCRIBE_AND_SAVE；listOffers 每页最多 100 条、listOfferMetrics 最多 500 条，offset 最大 9000；
// getSellingPartnerMetrics 按天聚合时区间不超过 31 天，只支持近两年；listOfferMetrics 的区间只能覆盖一个聚合单位（例如按月就是一个自然月）。
// 固定美国站。限速约每秒 1 次（官方未公布更细的突发值，沿用默认令牌桶并按响应头校准）。

export const REPLENISHMENT_PATH = '/replenishment/2022-11-07'
export const PROGRAM_TYPES = ['SUBSCRIBE_AND_SAVE'] as const
export const OFFERS_PAGE_SIZE = 100
export const OFFER_METRICS_PAGE_SIZE = 500
/** 官方 offset 上限 9000：超过后无法继续翻页，调用方据此收尾并标注“可能不完整”。 */
export const MAX_OFFSET = 9000
export type Frequency = 'DAY' | 'WEEK' | 'MONTH'
export type TimeWindow = { startDate: string; endDate: string }

/** 卖家整体指标请求的指标名（官方 Metric 枚举的子集）。 */
export const SELLER_METRICS = ['SHIPPED_SUBSCRIPTION_UNITS', 'TOTAL_SUBSCRIPTIONS_REVENUE', 'ACTIVE_SUBSCRIPTIONS'] as const

/** 没有开通订阅省或没有可订阅的报价：官方对此没有专门错误码，按状态码与错误文字判断；其余错误（尤其是 403 缺角色）原样抛出。 */
export function isNotEnrolled(error: unknown): boolean {
  if (!(error instanceof UpstreamHttpError) || error.source !== 'api') return false
  if (error.status === 404) return true
  return error.status === 400 && /enrol|subscribe|not\s+eligible|not\s+participat|no\s+(active\s+)?program/i.test(error.message)
}

export class ReplenishmentApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  sellerMetrics(window: TimeWindow, frequency: Frequency) {
    return this.client.request({
      method: 'POST',
      path: `${REPLENISHMENT_PATH}/sellingPartners/metrics/search`,
      body: { aggregationFrequency: frequency, timeInterval: window, metrics: [...SELLER_METRICS], timePeriodType: 'PERFORMANCE', marketplaceId: US_MARKETPLACE, programTypes: [...PROGRAM_TYPES] },
    })
  }

  listOffers(offset: number, limit: number = OFFERS_PAGE_SIZE) {
    return this.client.request({
      method: 'POST',
      path: `${REPLENISHMENT_PATH}/offers/search`,
      body: { pagination: { limit, offset }, filters: { marketplaceId: US_MARKETPLACE, programTypes: [...PROGRAM_TYPES] } },
    })
  }

  listOfferMetrics(window: TimeWindow, frequency: Frequency, offset: number, limit: number = OFFER_METRICS_PAGE_SIZE) {
    return this.client.request({
      method: 'POST',
      path: `${REPLENISHMENT_PATH}/offers/metrics/search`,
      body: {
        pagination: { limit, offset },
        filters: { aggregationFrequency: frequency, timeInterval: window, timePeriodType: 'PERFORMANCE', marketplaceId: US_MARKETPLACE, programTypes: [...PROGRAM_TYPES] },
      },
    })
  }
}
