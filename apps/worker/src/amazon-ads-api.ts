import { createDecipheriv } from 'node:crypto'

type AdsConnection = { encryptedRefreshToken: string | null }
type JsonObject = Record<string, unknown>

const endpoint = process.env.AMAZON_ADS_API_ENDPOINT ?? 'https://advertising-api.amazon.com'

function adsReportShape(reportType: string) {
  if (reportType === 'spSearchTerm') return { groupBy: ['searchTerm'], columns: ['searchTerm', 'campaignId', 'campaignName', 'adGroupId', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] }
  if (reportType === 'spAdvertisedProduct') return { groupBy: ['advertiser'], columns: ['campaignId', 'campaignName', 'advertisedAsin', 'advertisedSku', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] }
  return { groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] }
}

function decodeRefreshToken(value: string) {
  const key = process.env.TOKEN_ENCRYPTION_KEY ?? ''
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('TOKEN_VAULT_NOT_CONFIGURED')
  const [ivValue, tagValue, encryptedValue] = value.split('.')
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('TOKEN_CIPHERTEXT_INVALID')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}

export class AmazonAdsApiClient {
  private accessToken?: { value: string; expiresAt: number }

  constructor(private readonly connection: AdsConnection) {}

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
        refresh_token: decodeRefreshToken(this.connection.encryptedRefreshToken),
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string }
    if (!response.ok || !payload.access_token) throw new Error(`ADS_LWA_TOKEN_FAILED_${response.status}_${payload.error_description ?? ''}`)
    this.accessToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 }
    return payload.access_token
  }

  async request(options: { method?: string; path: string; profileId?: string; body?: unknown; contentType?: string }) {
    const clientId = process.env.AMAZON_ADS_CLIENT_ID
    if (!clientId) throw new Error('ADS_CLIENT_ID_MISSING')
    const url = new URL(options.path, endpoint)
    const body = options.body === undefined ? '' : JSON.stringify(options.body)
    const headers: Record<string, string> = {
      'Amazon-Advertising-API-ClientId': clientId,
      Authorization: `Bearer ${await this.lwaToken()}`,
      Accept: options.contentType ?? 'application/json',
      'User-Agent': 'NOVA-ERP/1.0 (Amazon-Ads-API)',
    }
    if (options.profileId) headers['Amazon-Advertising-API-Scope'] = options.profileId
    if (body) {
      headers['Content-Type'] = options.contentType ?? 'application/json'
    }
    const response = await fetch(url, { method: options.method ?? 'GET', headers, body: body || undefined })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`ADS_API_${response.status}_${JSON.stringify(payload).slice(0, 500)}`)
    return payload as JsonObject
  }

  async getProfiles() {
    const payload = await this.request({ path: '/v2/profiles' })
    return Array.isArray(payload) ? payload as JsonObject[] : []
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
      if (Array.isArray(payload.campaigns)) campaigns.push(...payload.campaigns as JsonObject[])
      nextToken = typeof payload.nextToken === 'string' && payload.nextToken.length > 0 ? payload.nextToken : undefined
    } while (nextToken)
    return campaigns
  }

  async downloadReport(url: string) {
    const response = await fetch(url)
    if (!response.ok) throw new Error('ADS_REPORT_DOWNLOAD_' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    let text = bytes.toString('utf8')
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const { gunzipSync } = await import('node:zlib')
      text = gunzipSync(bytes).toString('utf8')
    }
    return text
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
