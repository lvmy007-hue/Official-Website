import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomBytes } from 'node:crypto'
import { AppError, RequestWithContext } from '../../platform/http'
import { bindTenantContext } from '@nova/tenancy'
import { PrismaService, SystemPrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { SecretBoxService } from '../../platform/security/secret-box.service'
import { ConnectionHealthService } from './connection-health.service'
import { sha256 } from './state-hash'

const STATE_TTL_MS = 600000
const ADS_SCOPE = 'advertising::campaign_management'

@Injectable()
export class AdsOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    // 授权回调无登录态，只能凭 state 反查租户，这一步用系统连接；之后立即绑定租户，其余访问全部走租户连接
    private readonly system: SystemPrismaService,
    private readonly config: ConfigService,
    private readonly context: ContextService,
    private readonly secrets: SecretBoxService,
    private readonly health: ConnectionHealthService,
  ) {}

  async start(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'connection.manage')
    return this.issue(context)
  }

  /** 重新授权（P5-04）：沿用原连接，不新建；授权回来后换发令牌。 */
  async reauthorize(who: { tenantId: string; userId: string }, connection: { id: string; state: string }) {
    return this.issue(who, connection)
  }

  private async issue(context: { tenantId: string; userId: string }, existing?: { id: string; state: string }) {
    const redirectUri = this.config.get<string>('AMAZON_ADS_REDIRECT_URI')
    const clientId = this.config.get<string>('AMAZON_ADS_CLIENT_ID')
    if (!redirectUri) throw new AppError(503, 'ADS_REDIRECT_URI_MISSING', 'Amazon Ads 公有应用回调地址尚未配置')
    if (!clientId) throw new AppError(503, 'ADS_CLIENT_ID_MISSING', 'Amazon Ads Client ID 尚未配置')
    if (this.config.get('AMAZON_ADS_API_APPROVED') !== 'true') {
      throw new AppError(409, 'ADS_APPROVAL_PENDING', 'Amazon Ads API 公有应用尚未完成审批')
    }
    if (!this.config.get<string>('AMAZON_ADS_CLIENT_SECRET')) {
      throw new AppError(503, 'ADS_LWA_CONFIG_MISSING', 'Amazon Ads Client ID/Secret 尚未配置')
    }

    const connection = existing ?? (await this.prisma.platformConnection.create({ data: { tenantId: context.tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZING', grantedScopes: [] } }))
    const state = randomBytes(32).toString('base64url')
    await this.prisma.oAuthState.create({
      data: {
        tenantId: context.tenantId,
        connectionId: connection.id,
        initiatedById: context.userId,
        stateHash: sha256(state),
        redirectUri,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    })
    const url = new URL('https://www.amazon.com/ap/oa')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('scope', ADS_SCOPE)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return { connectionId: connection.id, state: connection.state, provider: 'AMAZON_ADS_API', authorizationUrl: url.toString() }
  }

  async complete(raw: Record<string, string>) {
    if (raw.error) throw new AppError(400, 'ADS_OAUTH_DENIED', raw.error_description ?? raw.error)
    const stateValue = raw.state
    const code = raw.code
    if (!stateValue || !code) throw new AppError(400, 'ADS_OAUTH_CALLBACK_INVALID', 'Amazon Ads 回调缺少 state 或 code')
    const oauthState = await this.system.oAuthState.findFirst({
      where: { stateHash: sha256(stateValue), consumedAt: null, expiresAt: { gt: new Date() } },
      include: { connection: true },
    })
    if (oauthState) bindTenantContext(oauthState.tenantId)
    if (!oauthState || oauthState.connection.provider !== 'AMAZON_ADS_API') {
      throw new AppError(400, 'ADS_OAUTH_STATE_INVALID', 'Amazon Ads 授权状态不存在、已使用或已过期')
    }
    const clientId = this.config.get<string>('AMAZON_ADS_CLIENT_ID')
    const clientSecret = this.config.get<string>('AMAZON_ADS_CLIENT_SECRET')
    if (!clientId || !clientSecret) throw new AppError(503, 'ADS_LWA_CONFIG_MISSING', 'Amazon Ads Client ID/Secret 尚未配置')

    const response = await fetch(this.config.get<string>('AMAZON_ADS_LWA_TOKEN_URL') ?? 'https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: oauthState.redirectUri,
      }).toString(),
    })
    const payload = (await response.json().catch(() => ({}))) as { refresh_token?: string; error_description?: string }
    if (!response.ok || !payload.refresh_token) {
      throw new AppError(502, 'ADS_LWA_TOKEN_EXCHANGE_FAILED', payload.error_description ?? 'Amazon Ads LWA token exchange failed', true)
    }
    const connection = await this.prisma.platformConnection.update({
      where: { id: oauthState.connectionId },
      data: {
        state: 'AUTHORIZED',
        encryptedRefreshToken: await this.secrets.sealAmazonToken(payload.refresh_token),
        refreshTokenUpdatedAt: new Date(),
        lastHealthCheckedAt: new Date(),
        lastErrorCode: null,
        grantedScopes: [ADS_SCOPE],
      },
    })
    await this.prisma.oAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } })
    // 授权完成后补一次真实的健康检查；排不上队不影响授权结果
    await this.health.request(oauthState.tenantId, connection.id, `oauth:${connection.id}`).catch(() => undefined)
    return {
      connectionId: connection.id,
      provider: 'AMAZON_ADS_API',
      state: connection.state,
      message: 'Amazon Ads API 授权完成，Refresh Token 已加密保存；下一步同步 Ads Profile',
    }
  }
}
