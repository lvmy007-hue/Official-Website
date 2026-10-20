import { createDecipheriv, createHash, createHmac } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

type SpApiConnection = { encryptedRefreshToken: string | null; sellerAccountId: string | null }
type RequestOptions = { method?: string; path: string; body?: unknown; query?: Record<string, string>; accessToken?: string }

const endpoint = process.env.AMAZON_SP_API_ENDPOINT ?? 'https://sellingpartnerapi-na.amazon.com'
const region = process.env.AMAZON_SP_API_REGION ?? 'us-east-1'
const service = 'execute-api'

function hash(value: string) { return createHash('sha256').update(value).digest('hex') }
function hmac(key: Buffer | string, value: string) { return createHmac('sha256', key).update(value).digest() }
function amzDate(date: Date) { return date.toISOString().replace(/[:-] milliseconds/g, '').replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') }
function decodeRefreshToken(value: string) {
  const key = process.env.TOKEN_ENCRYPTION_KEY ?? ''
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('TOKEN_VAULT_NOT_CONFIGURED')
  const [ivValue, tagValue, encryptedValue] = value.split('.')
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('TOKEN_CIPHERTEXT_INVALID')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}

function awsEncode(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) }
function signRequest(method: string, url: URL, headers: Record<string, string>, body: string, accessKey: string, secretKey: string, sessionToken?: string) {
  const date = new Date(); const dateStamp = date.toISOString().slice(0, 10).replace(/-/g, ''); const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const allHeaders: Record<string, string> = { host: url.host, 'x-amz-access-token': headers['x-amz-access-token'], 'x-amz-date': timestamp, ...(headers['content-type'] ? { 'content-type': headers['content-type'] } : {}), ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}) }
  const signedHeaders = Object.keys(allHeaders).sort().join(';')
  const canonicalHeaders = Object.keys(allHeaders).sort().map(key => `${key}:${allHeaders[key].trim()}\n`).join('')
  const canonicalQuery = [...url.searchParams.entries()].map(([key, value]) => [awsEncode(key), awsEncode(value)] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&')
  const canonicalRequest = [method.toUpperCase(), url.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, hash(body)].join('\n')
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hash(canonicalRequest)}`
  const kDate = hmac(`AWS4${secretKey}`, dateStamp); const kRegion = hmac(kDate, region); const kService = hmac(kRegion, service); const kSigning = hmac(kService, 'aws4_request')
  return { ...headers, host: url.host, 'x-amz-date': timestamp, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}), Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', kSigning).update(stringToSign).digest('hex')}` }
}

export class AmazonSpApiClient {
  private accessToken?: { value: string; expiresAt: number }
  constructor(private readonly connection: SpApiConnection) {}

  private async lwaToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value
    if (!this.connection.encryptedRefreshToken) throw new Error('REFRESH_TOKEN_NOT_CONFIGURED')
    const clientId = process.env.AMAZON_SP_LWA_CLIENT_ID; const clientSecret = process.env.AMAZON_SP_LWA_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('LWA_CONFIG_MISSING')
    const response = await fetch(process.env.AMAZON_SP_LWA_TOKEN_URL ?? 'https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decodeRefreshToken(this.connection.encryptedRefreshToken), client_id: clientId, client_secret: clientSecret }).toString() })
    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number }
    if (!response.ok || !payload.access_token) throw new Error(`LWA_TOKEN_FAILED_${response.status}`)
    this.accessToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 }
    return payload.access_token
  }

  async request(options: RequestOptions) {
    const accessKey = process.env.AWS_ACCESS_KEY_ID; const secretKey = process.env.AWS_SECRET_ACCESS_KEY
    if (!accessKey || !secretKey) throw new Error('AWS_SIGV4_CREDENTIALS_MISSING')
    const url = new URL(options.path, endpoint); Object.entries(options.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value))
    const body = options.body === undefined ? '' : JSON.stringify(options.body); const accessToken = options.accessToken ?? await this.lwaToken()
    const requestHeaders: Record<string, string> = { 'x-amz-access-token': accessToken, 'user-agent': 'NOVA-ERP/1.0 (Language=TypeScript; Platform=Node)' }
    if (body) requestHeaders['content-type'] = 'application/json'
    const signed = signRequest(options.method ?? 'GET', url, requestHeaders, body, accessKey, secretKey, process.env.AWS_SESSION_TOKEN)
    const response = await fetch(url, { method: options.method ?? 'GET', headers: signed, body: body || undefined })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`SP_API_${response.status}_${JSON.stringify(payload).slice(0, 400)}`)
    return payload as Record<string, unknown>
  }

  async getInventory(marketplaceId: string, nextToken?: string) {
    return this.request({ path: '/fba/inventory/v1/summaries', query: { granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId, details: 'true', ...(nextToken ? { nextToken } : {}) } })
  }
  async getMarketplaceParticipations() {
    return this.request({ path: '/sellers/v1/marketplaceParticipations' })
  }
  async getOrders(marketplaceId: string, nextToken?: string, range?: { createdAfter: string; createdBefore: string }) {
    const createdAfter = range?.createdAfter ?? new Date(Date.now() - 90 * 86400000).toISOString()
    const createdBefore = range?.createdBefore ?? new Date(Date.now() - 2 * 60 * 1000).toISOString()
    return this.request({ path: '/orders/v0/orders', query: nextToken ? { NextToken: nextToken } : { MarketplaceIds: marketplaceId, CreatedAfter: createdAfter, CreatedBefore: createdBefore, OrderStatuses: 'Unshipped,PartiallyShipped,Shipped,Canceled,Unfulfillable,Pending,PendingAvailability' } })
  }
  async createRestrictedDataToken(orderIds: string[]) {
    return this.request({ method: 'POST', path: '/tokens/2021-03-01/restrictedDataToken', body: { restrictedResources: orderIds.map(orderId => ({ method: 'GET', path: `/orders/v0/orders/${orderId}`, dataElements: ['buyerInfo', 'shippingAddress'] })) } })
  }
  async getOrder(orderId: string, restrictedDataToken: string) {
    return this.request({ path: `/orders/v0/orders/${encodeURIComponent(orderId)}`, accessToken: restrictedDataToken })
  }
  async getOrderItems(orderId: string, nextToken?: string) {
    return this.request({ path: `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`, query: nextToken ? { NextToken: nextToken } : {} })
  }
  async createReport(reportType: string, marketplaceId: string, range?: { from?: Date | null; to?: Date | null }) {
    const body: Record<string, unknown> = { reportType, marketplaceIds: [marketplaceId] }
    const acceptsRange = !reportType.includes('SETTLEMENT') && reportType !== 'GET_MERCHANT_LISTINGS_ALL_DATA'
    const from = range?.from ?? (acceptsRange ? new Date(Date.now() - 30 * 86400000) : null)
    const to = range?.to ?? (acceptsRange ? new Date() : null)
    if (acceptsRange && from) body.dataStartTime = from.toISOString()
    if (acceptsRange && to) body.dataEndTime = to.toISOString()
    return this.request({ method: 'POST', path: '/reports/2021-06-30/reports', body })
  }
  async getReport(reportId: string) { return this.request({ path: `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}` }) }
  async getReportDocument(documentId: string) { return this.request({ path: `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}` }) }
  async downloadReportDocument(documentId: string) {
    const metadata = await this.getReportDocument(documentId)
    const url = typeof metadata.url === 'string' ? metadata.url : ''
    if (!url) throw new Error('REPORT_DOCUMENT_URL_MISSING')
    const response = await fetch(url)
    if (!response.ok) throw new Error('REPORT_DOCUMENT_DOWNLOAD_' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    const body = String(metadata.compressionAlgorithm ?? '').toUpperCase() === 'GZIP' ? gunzipSync(bytes) : bytes
    return { metadata, text: body.toString('utf8') }
  }
  async getFinancialEvents(nextToken?: string, range?: { postedAfter: string; postedBefore: string }) {
    const postedAfter = range?.postedAfter ?? new Date(Date.now() - 180 * 86400000).toISOString()
    const postedBefore = range?.postedBefore ?? new Date(Date.now() - 2 * 60 * 1000).toISOString()
    return this.request({ path: '/finances/v0/financialEvents', query: nextToken ? { NextToken: nextToken } : { PostedAfter: postedAfter, PostedBefore: postedBefore, MaxResultsPerPage: '100' } })
  }
  async getInboundPlan(planId: string) { return this.request({ path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}` }) }
  async listInboundPlanItems(planId: string, paginationToken?: string) { return this.request({ path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/items`, query: paginationToken ? { paginationToken } : {} }) }
  async listInboundPlanShipments(planId: string, paginationToken?: string) { return this.request({ path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/shipments`, query: paginationToken ? { paginationToken } : {} }) }
  async getInboundPlanShipment(planId: string, shipmentId: string) { return this.request({ path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/shipments/${encodeURIComponent(shipmentId)}` }) }
  async listInboundShipmentItems(planId: string, shipmentId: string, paginationToken?: string) { return this.request({ path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/shipments/${encodeURIComponent(shipmentId)}/items`, query: paginationToken ? { paginationToken } : {} }) }
  async createInboundPlan(input: { name: string; sourceAddress: string; items: Array<{ sellerSku: string; asin: string; quantity: number; prepOwner?: string; labelOwner?: string }> }) {
    let sourceAddress: Record<string, unknown>
    try { sourceAddress = JSON.parse(input.sourceAddress) as Record<string, unknown> } catch { throw new Error('FBA_SOURCE_ADDRESS_INVALID') }
    for (const key of ['name', 'addressLine1', 'city', 'stateOrProvinceCode', 'countryCode', 'postalCode', 'phoneNumber']) {
      if (typeof sourceAddress[key] !== 'string' || !String(sourceAddress[key]).trim()) throw new Error('FBA_SOURCE_ADDRESS_INCOMPLETE')
    }
    return this.request({ method: 'POST', path: '/inbound/fba/2024-03-20/inboundPlans', body: { name: input.name, sourceAddress, items: input.items.map(item => ({ msku: item.sellerSku, asin: item.asin, quantity: item.quantity, prepOwner: item.prepOwner ?? 'NONE', labelOwner: item.labelOwner ?? 'SELLER' })) } })
  }
}