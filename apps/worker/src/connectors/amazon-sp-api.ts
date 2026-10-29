import { createHash, createHmac } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { TokenOpener } from '../crypto/secrets'
import { responseStream, type RawSink } from '../streaming/download'
import type { BrandReportRequest } from './brand-report-options'
import { UpstreamHttpError, apiFamilyOf, type RequestGuard } from './http-error'
import { assertRemoteUrl } from './remote-url'

type SpApiConnection = { encryptedRefreshToken: string | null; sellerAccountId: string | null }
type RequestOptions = { method?: string; path: string; body?: unknown; query?: Record<string, string>; accessToken?: string }

const endpoint = process.env.AMAZON_SP_API_ENDPOINT ?? 'https://sellingpartnerapi-na.amazon.com'
const region = process.env.AMAZON_SP_API_REGION ?? 'us-east-1'
const service = 'execute-api'

/** “当前状态”类报告：亚马逊按请求时刻生成，不接受起止时间。 */
const SNAPSHOT_REPORT_TYPES = new Set([
  'GET_MERCHANT_LISTINGS_ALL_DATA',
  'GET_MERCHANTS_LISTINGS_FYP_REPORT',
  'GET_FBA_MYI_ALL_INVENTORY_DATA',
  'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
  'GET_AFN_INVENTORY_DATA',
  'GET_RESERVED_INVENTORY_DATA',
  'GET_STRANDED_INVENTORY_UI_DATA',
  'GET_FBA_INVENTORY_PLANNING_DATA',
  'GET_FBA_RECOMMENDED_REMOVAL_DATA',
  'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
  'GET_FBA_OVERAGE_FEE_CHARGES_DATA',
  'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA',
  // 账户健康（P5-02）：卖家表现报告按请求时刻生成当前表现
  'GET_V2_SELLER_PERFORMANCE_REPORT',
])

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value).digest()
}
function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}
function signRequest(method: string, url: URL, headers: Record<string, string>, body: string, accessKey: string, secretKey: string, sessionToken?: string) {
  const date = new Date()
  const dateStamp = date.toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const allHeaders: Record<string, string> = {
    host: url.host,
    'x-amz-access-token': headers['x-amz-access-token'],
    'x-amz-date': timestamp,
    ...(headers['content-type'] ? { 'content-type': headers['content-type'] } : {}),
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  }
  const signedHeaders = Object.keys(allHeaders).sort().join(';')
  const canonicalHeaders = Object.keys(allHeaders)
    .sort()
    .map(key => `${key}:${allHeaders[key].trim()}\n`)
    .join('')
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const canonicalRequest = [method.toUpperCase(), url.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, hash(body)].join('\n')
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hash(canonicalRequest)}`
  const kDate = hmac(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  return {
    ...headers,
    host: url.host,
    'x-amz-date': timestamp,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', kSigning).update(stringToSign).digest('hex')}`,
  }
}

export class AmazonSpApiClient {
  private accessToken?: { value: string; expiresAt: number }
  constructor(
    private readonly connection: SpApiConnection,
    private readonly secrets: TokenOpener,
    private readonly guard?: RequestGuard,
  ) {}

  private async lwaToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value
    if (!this.connection.encryptedRefreshToken) throw new Error('REFRESH_TOKEN_NOT_CONFIGURED')
    const clientId = process.env.AMAZON_SP_LWA_CLIENT_ID
    const clientSecret = process.env.AMAZON_SP_LWA_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('LWA_CONFIG_MISSING')
    const response = await fetch(process.env.AMAZON_SP_LWA_TOKEN_URL ?? 'https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: await this.secrets.openAmazonToken(this.connection.encryptedRefreshToken),
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    const payload = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
    if (!response.ok || !payload.access_token) throw new UpstreamHttpError(`LWA_TOKEN_FAILED_${response.status}`, response.status, response.headers, 'lwa')
    this.accessToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 }
    return payload.access_token
  }

  async request(options: RequestOptions) {
    const accessKey = process.env.AWS_ACCESS_KEY_ID
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY
    if (!accessKey || !secretKey) throw new Error('AWS_SIGV4_CREDENTIALS_MISSING')
    const url = new URL(options.path, endpoint)
    Object.entries(options.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value))
    const body = options.body === undefined ? '' : JSON.stringify(options.body)
    const accessToken = options.accessToken ?? (await this.lwaToken())
    const requestHeaders: Record<string, string> = { 'x-amz-access-token': accessToken, 'user-agent': 'NOVA-ERP/1.0 (Language=TypeScript; Platform=Node)' }
    if (body) requestHeaders['content-type'] = 'application/json'
    const signed = signRequest(options.method ?? 'GET', url, requestHeaders, body, accessKey, secretKey, process.env.AWS_SESSION_TOKEN)
    const family = apiFamilyOf(options.path)
    await this.guard?.before(family)
    const response = await fetch(url, { method: options.method ?? 'GET', headers: signed, body: body || undefined })
    await this.guard?.after(family, response.status, response.headers)
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new UpstreamHttpError(`SP_API_${response.status}_${JSON.stringify(payload).slice(0, 400)}`, response.status, response.headers, 'api')
    return payload as Record<string, unknown>
  }

  async getInventory(marketplaceId: string, nextToken?: string) {
    return this.request({
      path: '/fba/inventory/v1/summaries',
      query: { granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId, details: 'true', ...(nextToken ? { nextToken } : {}) },
    })
  }
  async getMarketplaceParticipations() {
    return this.request({ path: '/sellers/v1/marketplaceParticipations' })
  }
  async getOrders(marketplaceId: string, nextToken?: string, range?: { createdAfter: string; createdBefore: string }) {
    const createdAfter = range?.createdAfter ?? new Date(Date.now() - 90 * 86400000).toISOString()
    const createdBefore = range?.createdBefore ?? new Date(Date.now() - 2 * 60 * 1000).toISOString()
    return this.request({
      path: '/orders/v0/orders',
      query: nextToken
        ? { NextToken: nextToken }
        : {
            MarketplaceIds: marketplaceId,
            CreatedAfter: createdAfter,
            CreatedBefore: createdBefore,
            OrderStatuses: 'Unshipped,PartiallyShipped,Shipped,Canceled,Unfulfillable,Pending,PendingAvailability',
          },
    })
  }
  async createReport(reportType: string, marketplaceId: string, range?: { from?: Date | null; to?: Date | null }, brand?: BrandReportRequest | null) {
    const body: Record<string, unknown> = { reportType, marketplaceIds: [marketplaceId] }
    // 台账汇总按日、按仓库位置汇总（P2a-05：导入器按日汇总口径写入）
    if (reportType === 'GET_LEDGER_SUMMARY_VIEW_DATA') body.reportOptions = { aggregateByLocation: 'FC', aggregatedByTimePeriod: 'DAILY' }
    // 销售与流量（P4-01，R-34）：按日汇总、ASIN 到子体；窗口只有一天时导入器才读 ASIN 部分
    if (reportType === 'GET_SALES_AND_TRAFFIC_REPORT') body.reportOptions = { dateGranularity: 'DAY', asinGranularity: 'CHILD' }
    const acceptsRange = !reportType.includes('SETTLEMENT') && !SNAPSHOT_REPORT_TYPES.has(reportType)
    const from = range?.from ?? (acceptsRange ? new Date(Date.now() - 30 * 86400000) : null)
    const to = range?.to ?? (acceptsRange ? new Date() : null)
    if (acceptsRange && from) body.dataStartTime = from.toISOString()
    if (acceptsRange && to) body.dataEndTime = to.toISOString()
    // 品牌分析（P4-04）：按周期申请，日期只带日期不带时间
    if (brand) Object.assign(body, { reportOptions: brand.reportOptions, dataStartTime: brand.dataStartTime, dataEndTime: brand.dataEndTime })
    return this.request({ method: 'POST', path: '/reports/2021-06-30/reports', body })
  }
  /** 按类型与创建时间列出已有报告：创建请求超时后用它对账，判断报告是否其实已经创建（避免重复创建）。 */
  async listReports(reportType: string, createdSince: Date, marketplaceId: string) {
    return this.request({ path: '/reports/2021-06-30/reports', query: { reportTypes: reportType, createdSince: createdSince.toISOString(), pageSize: '100', marketplaceIds: marketplaceId } })
  }
  /** 按最近更新时间倒序列出入库计划：创建请求超时后用它对账。 */
  async listInboundPlans() {
    return this.request({ path: '/inbound/fba/2024-03-20/inboundPlans', query: { pageSize: '30', sortBy: 'LAST_UPDATED_TIME', sortOrder: 'DESC' } })
  }
  async getReport(reportId: string) {
    return this.request({ path: `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}` })
  }
  async getReportDocument(documentId: string) {
    return this.request({ path: `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}` })
  }
  /**
   * 打开报告文档的解压后字节流（流式，不把文件读入内存）。原始文件（解压之前）同时写入 sink（对象存储）。
   * 压缩方式以文档元数据为准，没有声明时按文件头自动识别。
   */
  async openReportDocument(documentId: string, options: { sink?: RawSink } = {}): Promise<{ metadata: Record<string, unknown>; stream: Readable }> {
    const metadata = await this.getReportDocument(documentId)
    const url = typeof metadata.url === 'string' ? metadata.url : ''
    if (!url) throw new Error('REPORT_DOCUMENT_URL_MISSING')
    const response = await fetch(assertRemoteUrl(url, '报告文档下载地址'))
    if (!response.ok) throw new UpstreamHttpError('REPORT_DOCUMENT_DOWNLOAD_' + response.status, response.status, response.headers, 'download')
    const algorithm = String(metadata.compressionAlgorithm ?? '').toUpperCase()
    return { metadata, stream: responseStream(response, { compression: algorithm === 'GZIP' ? 'gzip' : algorithm ? 'none' : 'auto', sink: options.sink }) }
  }
  async getFinancialEvents(nextToken?: string, range?: { postedAfter: string; postedBefore: string }) {
    const postedAfter = range?.postedAfter ?? new Date(Date.now() - 180 * 86400000).toISOString()
    const postedBefore = range?.postedBefore ?? new Date(Date.now() - 2 * 60 * 1000).toISOString()
    return this.request({ path: '/finances/v0/financialEvents', query: nextToken ? { NextToken: nextToken } : { PostedAfter: postedAfter, PostedBefore: postedBefore, MaxResultsPerPage: '100' } })
  }
  async getInboundPlan(planId: string) {
    return this.request({ path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}` })
  }
  async createInboundPlan(input: { name: string; sourceAddress: string; items: Array<{ sellerSku: string; asin: string; quantity: number }> }) {
    let sourceAddress: Record<string, unknown>
    try {
      sourceAddress = JSON.parse(input.sourceAddress) as Record<string, unknown>
    } catch {
      throw new Error('FBA_SOURCE_ADDRESS_INVALID')
    }
    for (const key of ['name', 'addressLine1', 'city', 'stateOrProvinceCode', 'countryCode', 'postalCode', 'phoneNumber']) {
      if (typeof sourceAddress[key] !== 'string' || !String(sourceAddress[key]).trim()) throw new Error('FBA_SOURCE_ADDRESS_INCOMPLETE')
    }
    return this.request({
      method: 'POST',
      path: '/inbound/fba/2024-03-20/inboundPlans',
      body: {
        name: input.name,
        sourceAddress,
        // 美国站预处理方与贴标方固定为卖家（01 章 1.7 第 1 条、11.6 第 12 条）：不接受调用方传入，计划明细里即使带了也忽略
        items: input.items.map(item => ({ msku: item.sellerSku, asin: item.asin, quantity: item.quantity, prepOwner: 'SELLER', labelOwner: 'SELLER' })),
      },
    })
  }
}
