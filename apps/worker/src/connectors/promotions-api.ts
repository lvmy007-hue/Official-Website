import type { AmazonSpApiClient } from './amazon-sp-api'
import { US_MARKETPLACE } from './sp-api-v2'

// 促销接口（Promotions API v2025-12-01，importers.md I-17）。路径、参数、枚举于 2026 年 10 月对照亚马逊官方模型文件复核
// （selling-partner-api-models/models/promotions-api-model/promotions_2025-12-01.json）：
//   searchPromotions  GET /promotions/2025-12-01/promotions                                       必填 marketplaceIds；limit 1 至 100；翻页参数 paginationToken；
//                                                                                                 includedData=ISSUES 带上促销级问题；revision=ANY 同时匹配已发布与最新修订
//   getSelection      GET /promotions/2025-12-01/promotions/{promotionId}/selections/{selectionId}  必填 revisionId（取自搜索结果的 selection.revisionId）；一次最多 100 个商品；
//                                                                                                 只支持 ITEMS 类型，CATALOG（全店商品）亚马逊不提供清单；includedData=ISSUES 带上商品级问题
// 官方只有这三个查询操作（另一个是 getPromotion，搜索结果已含全部促销字段，不再单独调用），没有创建、修改、取消，所以本系统只读（freeze/verification-log.md 第 11 条）。
// 限速：三个操作都是每秒 0.1 次（约 10 秒一次），突发 2 至 4：翻页与取商品清单都很慢，同步器据此限制每次的调用量。固定美国站。

export const PROMOTIONS_PATH = '/promotions/2025-12-01'
export const PROMOTIONS_PAGE_SIZE = 100
export const SELECTION_PAGE_SIZE = 100

export class PromotionsApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 开始时间晚于 startDateAfter 的促销，已发布与最新修订都匹配，带促销级问题。 */
  search(startDateAfter: Date, paginationToken?: string) {
    return this.client.request({
      path: `${PROMOTIONS_PATH}/promotions`,
      query: {
        marketplaceIds: US_MARKETPLACE,
        startDateAfter: startDateAfter.toISOString(),
        revision: 'ANY',
        includedData: 'ISSUES',
        limit: String(PROMOTIONS_PAGE_SIZE),
        ...(paginationToken ? { paginationToken } : {}),
      },
    })
  }

  /** 一个促销的商品清单（含商品级问题）；revisionId 必须是搜索结果里给的版本。 */
  selection(promotionId: string, selectionId: string, revisionId: number, paginationToken?: string) {
    return this.client.request({
      path: `${PROMOTIONS_PATH}/promotions/${encodeURIComponent(promotionId)}/selections/${encodeURIComponent(selectionId)}`,
      query: { revisionId: String(revisionId), includedData: 'ISSUES', limit: String(SELECTION_PAGE_SIZE), ...(paginationToken ? { paginationToken } : {}) },
    })
  }
}
