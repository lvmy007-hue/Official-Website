import { createDecipheriv, createHash, createHmac } from 'node:crypto'

type SpApiConnection = { encryptedRefreshToken: string | null; sellerAccountId: string | null }
type RequestOptions = { method?: string; path: string; body?: unknown; query?: Record<string, string> }

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

function signRequest(method: string, url: URL, headers: Record<string, string>, body: string, accessKey: string, secretKey: string, sessionToken?: string) {
  const date = new Date(); const dateStamp = date.toISOString().slice(0, 10).replace(/-/g, ''); const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const allHeaders: Record<string, string> = { host: url.host, 'x-amz-access-token': headers['x-amz-access-token'], 'x-amz-date': timestamp, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}) }
  const signedHeaders = Object.keys(allHeaders).sort().join(';')
  const canonicalHeaders = Object.keys(allHeaders).sort().map(key => `${key}:${allHeaders[key].trim()}\n`).join('')
  const canonicalQuery = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
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
    const body = options.body === undefined ? '' : JSON.stringify(options.body); const accessToken = await this.lwaToken()
    const signed = signRequest(options.method ?? 'GET', url, { 'content-type': 'application/json', 'x-amz-access-token': accessToken, 'user-agent': 'NOVA-ERP/1.0 (Amazon-SP-API)' }, body, accessKey, secretKey, process.env.AWS_SESSION_TOKEN)
    const response = await fetch(url, { method: options.method ?? 'GET', headers: signed, body: body || undefined })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`SP_API_${response.status}_${JSON.stringify(payload).slice(0, 400)}`)
    return payload as Record<string, unknown>
  }

  async getInventory(marketplaceId: string) { return this.request({ path: '/fba/inventory/v1/summaries', query: { granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId, details: 'true' } }) }
  async getOrders(marketplaceId: string) { const after = new Date(Date.now() - 30 * 86400000).toISOString(); return this.request({ path: '/orders/v0/orders', query: { MarketplaceIds: marketplaceId, CreatedAfter: after } }) }
  async createReport(reportType: string, marketplaceId: string) { return this.request({ method: 'POST', path: '/reports/2021-06-30/reports', body: { reportType, marketplaceIds: [marketplaceId] } }) }
}
