import type { AmazonAdsApiClient } from './amazon-ads-api'
import { ADS_V1_PREFIX } from './amazon-ads-api'
import type { JsonObject } from '../types'

// 广告统一接口（Amazon Ads API v1，importers.md A-01）：活动、广告组、广告、投放对象、广告关联、广告扩展、品牌旗舰店、活动预测、推荐。
// 所有资源共用一套模型，账户上下文请求头由 AmazonAdsApiClient 按路径自动选（统一接口只带 Amazon-Ads-AccountId）。
//
// 【未对真实账户验证】路径取统一接口的约定形式 POST /adsApi/v1/query/<资源>（列出）；响应按 { <资源名>: [...], nextToken } 解析，
// 同时兼容 items / data 两种常见包装；分页大小与预测、推荐的具体字段也没有对照真实响应。这些假设都集中在本文件与 ads-v1-parse.ts，
// 第一次接真实广告账户时只需要核对这两个文件。统一接口里仍是测试版的资源（规则、标签、事件）不在这里，不进生产（verification-log 第 4 节）。

export const ADS_V1_RESOURCES = ['campaigns', 'adGroups', 'ads', 'targets', 'adAssociations', 'adExtensions', 'brandStores'] as const
export type AdsV1Resource = (typeof ADS_V1_RESOURCES)[number]

export const ADS_V1_PAGE_SIZE = 100
/** 单个资源最多翻的页数：防止分页令牌异常时无限翻页；超过按“不完整”处理。 */
export const ADS_V1_MAX_PAGES = 200

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined)
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter((item): item is JsonObject => item !== null && typeof item === 'object' && !Array.isArray(item)) : [])

/** 从一页响应里取出条目：优先按资源名取，其次 items、data。 */
export function pageItems(body: JsonObject, resource: string): JsonObject[] {
  for (const key of [resource, 'items', 'data']) {
    const found = records(body[key])
    if (found.length > 0 || Array.isArray(body[key])) return found
  }
  return []
}

export type AdsV1Page = { items: JsonObject[]; nextToken?: string }

export class AdsV1Api {
  constructor(
    private readonly client: Pick<AmazonAdsApiClient, 'request'>,
    readonly adsAccountId: string,
  ) {
    if (!adsAccountId) throw new Error('ADS_ACCOUNT_ID_REQUIRED')
  }

  private async post(path: string, body: unknown, family?: string): Promise<JsonObject> {
    return this.client.request({ method: 'POST', path: `${ADS_V1_PREFIX}${path}`, adsAccountId: this.adsAccountId, body, family })
  }

  /** 列出一页某类资源；翻页只带 nextToken 之外相同的筛选条件。 */
  async queryPage(resource: AdsV1Resource | 'recommendations', options: { nextToken?: string; filters?: JsonObject } = {}): Promise<AdsV1Page> {
    const body = await this.post(`/query/${resource}`, { maxResults: ADS_V1_PAGE_SIZE, ...(options.filters ?? {}), ...(options.nextToken ? { nextToken: options.nextToken } : {}) })
    return { items: pageItems(body, resource), nextToken: text(body.nextToken) }
  }

  /**
   * 翻完某类资源的所有页，逐条交出（流式，不把整类资源读进内存）。
   * 页数超过上限时停止并在返回的状态里标记不完整（生成器的返回值），调用方据此决定要不要把“没出现的条目”当作已删除。
   */
  async *queryAll(resource: AdsV1Resource | 'recommendations', filters?: JsonObject): AsyncGenerator<JsonObject, { complete: boolean; pages: number }> {
    let nextToken: string | undefined
    let pages = 0
    do {
      const page = await this.queryPage(resource, { nextToken, filters })
      pages += 1
      for (const item of page.items) yield item
      nextToken = page.nextToken
      if (nextToken && pages >= ADS_V1_MAX_PAGES) return { complete: false, pages }
    } while (nextToken)
    return { complete: true, pages }
  }

  /** 写入（P3-17）：创建或更新一类资源的一个对象；请求体形状见 ads-v1-write.ts。限速桶与读取分开，避免写入被读取的限额拖慢。 */
  mutate(operation: 'create' | 'update', resource: 'campaigns' | 'adGroups' | 'targets', item: JsonObject): Promise<JsonObject> {
    return this.post(`/${operation}/${resource}`, { [resource]: [item] }, 'ads-v1-write')
  }

  /** 活动预测：给定预算，返回曝光、点击、花费等区间（修改预算前的影响预览）。 */
  forecastCampaign(campaignId: string, requestedBudget: number): Promise<JsonObject> {
    return this.post('/query/campaignForecasts', { campaignId, budget: requestedBudget })
  }
}
