import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 卖家支持接口（Support API v2025-02-01，importers.md I-20）。路径、参数、枚举于 2026 年 10 月对照亚马逊官方模型文件复核
// （selling-partner-api-models/models/support-api-model/support_2025-02-01.json）：
//   listCases     POST /support/2025-02-01/cases                    请求体 { marketplaceId, caseFilters?, sortField?, sortOrder?, maxResults(1 至 50), nextToken? }；翻页必须带与首次相同的参数
//   listContacts  GET  /support/2025-02-01/cases/{caseId}/contacts  maxResults 最大 50，sortOrder 按创建时间；可能返回空页（有 nextToken 就要继续翻）
// 案件响应（Case）已含状态、主题、创建与更新与解决时间、预约回电，所以不再调用 getCase。接口需要受限角色“Selling Partner Support”，没有时返回 403。
// 沟通附件的下载链接 15 分钟失效，不保存。固定美国站；限速沿用按店铺的令牌桶并按响应头校准。

export const SUPPORT_PATH = '/support/2025-02-01'
export const SUPPORT_PAGE_SIZE = 50

/** 受限角色未获批：官方只在 403 上说明缺少权限；其余错误（429、5xx）原样抛出由任务运行时重试。 */
export const isRoleMissing = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403

export class SupportApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 案件按创建时间从新到旧；翻页只带 nextToken 之外相同的参数。 */
  listCases(nextToken?: string) {
    return this.client.request({
      method: 'POST',
      path: `${SUPPORT_PATH}/cases`,
      body: { marketplaceId: US_MARKETPLACE, sortField: 'CREATION_DATE', sortOrder: 'DESC', maxResults: SUPPORT_PAGE_SIZE, ...(nextToken ? { nextToken } : {}) },
    })
  }

  /** 沟通记录按创建时间从旧到新。 */
  listContacts(caseId: string, nextToken?: string) {
    return this.client.request({
      path: `${SUPPORT_PATH}/cases/${encodeURIComponent(caseId)}/contacts`,
      query: { maxResults: String(SUPPORT_PAGE_SIZE), sortOrder: 'ASC', ...(nextToken ? { nextToken } : {}) },
    })
  }
}
