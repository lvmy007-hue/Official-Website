import type { Readable } from 'node:stream'
import type { TokenOpener } from '../crypto/secrets'
import { responseStream, type RawSink } from '../streaming/download'
import { UpstreamHttpError, apiFamilyOf, type RequestGuard } from './http-error'
import { assertRemoteUrl } from './remote-url'

type AdsConnection = { encryptedRefreshToken: string | null }
type JsonObject = Record<string, unknown>

const endpoint = process.env.AMAZON_ADS_API_ENDPOINT ?? 'https://advertising-api.amazon.com'

function adsReportShape(reportType: string) {
  if (reportType === 'spSearchTerm') return { groupBy: ['searchTerm'], columns: ['searchTerm', 'campaignId', 'campaignName', 'adGroupId', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] }
  if (reportType === 'spAdvertisedProduct')
    return { groupBy: ['advertiser'], columns: ['campaignId', 'campaignName', 'advertisedAsin', 'advertisedSku', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] }
  return { groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] }
}

/** 统一接口的路径前缀（Amazon Ads API v1）。 */
export const ADS_V1_PREFIX = '/adsApi/v1'

/**
 * 按调用的接口体系选账户上下文请求头：统一接口必须带全球广告账户编号、不能带旧作用域；旧接口反过来。
 * 账户管理、档案列表这类不带账户上下文的路径两个都不传。传错体系直接抛错，不让请求发出去。
 */
export function adsScopeHeader(path: string, scope: { profileId?: string; adsAccountId?: string }): Record<string, string> {
  const unified = path === ADS_V1_PREFIX || path.startsWith(`${ADS_V1_PREFIX}/`)
  if (scope.profileId && scope.adsAccountId) throw new Error('ADS_SCOPE_HEADER_CONFLICT')
  if (unified) {
    if (scope.profileId) throw new Error('ADS_SCOPE_HEADER_CONFLICT')
    if (!scope.adsAccountId) throw new Error('ADS_ACCOUNT_ID_REQUIRED')
    return { 'Amazon-Ads-AccountId': scope.adsAccountId }
  }
  if (scope.adsAccountId) throw new Error('ADS_SCOPE_HEADER_CONFLICT')
  return scope.profileId ? { 'Amazon-Advertising-API-Scope': scope.profileId } : {}
}

export class AmazonAdsApiClient {
  private accessToken?: { value: string; expiresAt: number }

  constructor(
    private readonly connection: AdsConnection,
    private readonly secrets: TokenOpener,
    private readonly guard?: RequestGuard,
  ) {}

  private async lwaToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value
    if (!this.connection.encryptedRefreshToken) throw new Error('ADS_REFRESH_TOKEN_NOT_CONFIGURED')
    const clientId = process.env.AMAZON_ADS_CLIENT_ID
    const clientSecret = process.env.AMAZON_ADS_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('ADS_LWA_CONFIG_MISSING')
    const response = await fetch(process.env.AMAZON_ADS_LWA_TOKEN_URL ?? 'https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: await this.secrets.openAmazonToken(this.connection.encryptedRefreshToken),
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    const payload = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string }
    if (!response.ok || !payload.access_token) throw new UpstreamHttpError(`ADS_LWA_TOKEN_FAILED_${response.status}_${payload.error_description ?? ''}`, response.status, response.headers, 'lwa')
    this.accessToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 }
    return payload.access_token
  }

  /**
   * 调用广告接口。账户上下文请求头由路径决定（verification-log 第 5 节）：统一接口（/adsApi/v1）只带 Amazon-Ads-AccountId，
   * 旧版逐产品接口只带 Amazon-Advertising-API-Scope，二者同时带会被拒；业务代码只传 adsAccountId 或 profileId，不手填请求头。
   * family：限速桶名，默认取路径前两段；统一接口的报告用单独的桶（报告接口的限额远低于其他资源）。
   */
  async request(options: { method?: string; path: string; profileId?: string; adsAccountId?: string; body?: unknown; contentType?: string; accept?: string; family?: string }) {
    const clientId = process.env.AMAZON_ADS_CLIENT_ID
    if (!clientId) throw new Error('ADS_CLIENT_ID_MISSING')
    const scope = adsScopeHeader(options.path, { profileId: options.profileId, adsAccountId: options.adsAccountId })
    const url = new URL(options.path, endpoint)
    const body = options.body === undefined ? '' : JSON.stringify(options.body)
    const headers: Record<string, string> = {
      'Amazon-Advertising-API-ClientId': clientId,
      Authorization: `Bearer ${await this.lwaToken()}`,
      Accept: options.accept ?? options.contentType ?? 'application/json',
      'User-Agent': 'NOVA-ERP/1.0 (Amazon-Ads-API)',
      ...scope,
    }
    if (body) {
      headers['Content-Type'] = options.contentType ?? 'application/json'
    }
    const family = options.family ?? apiFamilyOf(options.path)
    await this.guard?.before(family)
    const response = await fetch(url, { method: options.method ?? 'GET', headers, body: body || undefined })
    await this.guard?.after(family, response.status, response.headers)
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new UpstreamHttpError(`ADS_API_${response.status}_${JSON.stringify(payload).slice(0, 500)}`, response.status, response.headers, 'api')
    return payload as JsonObject
  }

  async getProfiles() {
    const payload = await this.request({ path: '/v2/profiles' })
    return Array.isArray(payload) ? (payload as JsonObject[]) : []
  }

  async listCampaigns(profileId: string) {
    const campaigns: JsonObject[] = []
    let nextToken: string | undefined
    do {
      const payload = await this.request({
        method: 'POST',
        path: process.env.AMAZON_ADS_CAMPAIGNS_PATH ?? '/sp/campaigns/list',
        profileId,
        contentType: 'application/vnd.spCampaign.v3+json',
        body: { maxResults: 100, ...(nextToken ? { nextToken } : {}), stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] } },
      })
      if (Array.isArray(payload.campaigns)) campaigns.push(...(payload.campaigns as JsonObject[]))
      nextToken = typeof payload.nextToken === 'string' && payload.nextToken.length > 0 ? payload.nextToken : undefined
    } while (nextToken)
    return campaigns
  }

  /**
   * 统一接口的广告账户列表（账户管理接口，不带账户上下文请求头）：用来发现每个旧档案对应的全球广告账户编号。
   * 【未对真实账户验证】路径取 POST /adsAccounts/list，响应按 { adsAccounts: [{ adsAccountId, accountName, status, alternateIds: [{ profileId, entityId, countryCode }] }], nextToken } 解析
   * （路径可用 AMAZON_ADS_ACCOUNTS_PATH 覆盖）；翻页上限 50 页，超过抛错而不是返回不完整的列表。
   */
  async listAdsAccounts() {
    const accounts: JsonObject[] = []
    let nextToken: string | undefined
    for (let page = 0; page < 50; page += 1) {
      const payload = await this.request({
        method: 'POST',
        path: process.env.AMAZON_ADS_ACCOUNTS_PATH ?? '/adsAccounts/list',
        accept: 'application/vnd.listaccountsresponse.v1+json',
        body: { maxResults: 100, ...(nextToken ? { nextToken } : {}) },
      })
      if (Array.isArray(payload.adsAccounts)) accounts.push(...(payload.adsAccounts as JsonObject[]))
      nextToken = typeof payload.nextToken === 'string' && payload.nextToken.length > 0 ? payload.nextToken : undefined
      if (!nextToken) return accounts
    }
    throw new Error('ADS_ACCOUNTS_PAGING_EXCEEDED')
  }

  /**
   * 广告组合（旧接口 GET /portfolios/extended，按档案范围）：一次返回全部，不分页。
   * 【未对真实账户验证】响应按 [{ portfolioId, name, state, budget: { amount, currencyCode, policy, startDate, endDate }, inBudget }] 解析；接口不返回已花费金额。
   */
  async listPortfolios(profileId: string) {
    const payload = await this.request({ path: process.env.AMAZON_ADS_PORTFOLIOS_PATH ?? '/v2/portfolios/extended', profileId })
    return Array.isArray(payload) ? (payload as JsonObject[]) : []
  }

  /** 打开广告报告的解压后字节流（按文件头自动识别 gzip；流式，不把文件读入内存）。原始文件同时写入 sink（对象存储）。 */
  async openReport(url: string, options: { sink?: RawSink } = {}): Promise<Readable> {
    const response = await fetch(assertRemoteUrl(url, '广告报告下载地址'))
    if (!response.ok) throw new UpstreamHttpError('ADS_REPORT_DOWNLOAD_' + response.status, response.status, response.headers, 'download')
    return responseStream(response, { compression: 'auto', sink: options.sink })
  }

  async requestReport(profileId: string, input: { reportType: string; fromDate: string; toDate: string; adProduct: string }) {
    return this.request({
      method: 'POST',
      path: process.env.AMAZON_ADS_REPORTS_PATH ?? '/reporting/reports',
      profileId,
      contentType: 'application/vnd.createasyncreportrequest.v3+json',
      body: {
        name: input.reportType,
        startDate: input.fromDate,
        endDate: input.toDate,
        configuration: {
          adProduct: input.adProduct === 'SPONSORED_PRODUCTS' ? 'SPONSORED_PRODUCTS' : input.adProduct,
          ...adsReportShape(input.reportType),
          reportTypeId: input.reportType,
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        },
      },
    })
  }

  async getReport(profileId: string, reportId: string) {
    return this.request({ method: 'GET', path: `/reporting/reports/${encodeURIComponent(reportId)}`, profileId })
  }
}
