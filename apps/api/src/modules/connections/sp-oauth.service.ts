import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomBytes } from 'node:crypto'
import { OAuthStartSchema } from '@nova/api-contracts'
import { AppError, RequestWithContext, appError } from '../../platform/http'
import { ConnectionHealthService } from './connection-health.service'
import { bindTenantContext } from '@nova/tenancy'
import { PrismaService, SystemPrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { SecretBoxService } from '../../platform/security/secret-box.service'
import { sha256 } from './state-hash'

const STATE_TTL_MS = 600000

function logicalRegionFromEndpoint(): 'NA' | 'EU' | 'FE' {
  const endpoint = process.env.AMAZON_SP_API_ENDPOINT ?? ''
  if (endpoint.includes('-eu.')) return 'EU'
  if (endpoint.includes('-fe.')) return 'FE'
  return 'NA'
}

@Injectable()
export class SpOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    // 授权回调是亚马逊发起的无登录态请求，只能凭 state 反查租户，这一步用系统连接；之后立即绑定租户，其余访问全部走租户连接
    private readonly system: SystemPrismaService,
    private readonly config: ConfigService,
    private readonly context: ContextService,
    private readonly secrets: SecretBoxService,
    private readonly health: ConnectionHealthService,
  ) {}

  async start(req: RequestWithContext, raw: unknown) {
    const context = await this.context.authorize(req, 'connection.manage')
    const input = OAuthStartSchema.parse(raw)
    const entity = await this.prisma.legalEntity.findFirst({ where: { id: input.legalEntityId, tenantId: context.tenantId } })
    if (!entity) throw new AppError(404, 'RESOURCE_NOT_FOUND', '法律主体不存在')
    // 已停用的主体不再接新店铺（P5-07）；先在“法律主体”页恢复使用
    if (entity.status === 'INACTIVE') throw new AppError(409, 'DATA_CONDITION_FAILED', '这个法律主体已停用，不能再授权新店铺；请先在“法律主体”页恢复使用')
    return this.issue(context, entity.id, { returnUrl: input.returnUrl })
  }

  /** 重新授权（P5-04）：沿用原连接，不新建；授权回来后换发令牌，必须是同一个卖家账户（complete 里核对）。 */
  async reauthorize(who: { tenantId: string; userId: string }, connection: { id: string; state: string; legalEntityId: string }) {
    return this.issue(who, connection.legalEntityId, { existing: { id: connection.id, state: connection.state } })
  }

  private async issue(context: { tenantId: string; userId: string }, legalEntityId: string, options: { returnUrl?: string; existing?: { id: string; state: string } }) {
    const redirectUri = this.config.get<string>('AMAZON_SP_REDIRECT_URI')
    if (!redirectUri) throw new AppError(503, 'SP_API_REDIRECT_URI_MISSING', 'Amazon 公有应用回调地址尚未配置', false)
    if (options.returnUrl && options.returnUrl !== redirectUri) {
      throw new AppError(400, 'OAUTH_REDIRECT_URI_NOT_ALLOWED', '回调地址必须使用服务端登记的固定地址')
    }
    if (this.config.get('AMAZON_SP_API_APPROVED') !== 'true') {
      throw new AppError(409, 'APPROVAL_PENDING', 'Amazon 公有 SP-API 应用尚未完成审批')
    }
    const applicationId = this.config.get<string>('AMAZON_SP_APPLICATION_ID')
    const clientId = this.config.get<string>('AMAZON_SP_LWA_CLIENT_ID')
    const clientSecret = this.config.get<string>('AMAZON_SP_LWA_CLIENT_SECRET')
    if (!applicationId) throw new AppError(503, 'SP_API_APPLICATION_ID_MISSING', 'Amazon 公有应用 Application ID 尚未配置')
    if (!clientId || !clientSecret) throw new AppError(503, 'LWA_CONFIG_MISSING', 'Amazon LWA Client ID/Secret 尚未配置', false)

    const connection = options.existing ?? (await this.prisma.platformConnection.create({ data: { tenantId: context.tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZING', grantedScopes: [] } }))
    const state = randomBytes(32).toString('base64url')
    await this.prisma.oAuthState.create({
      data: {
        tenantId: context.tenantId,
        connectionId: connection.id,
        initiatedById: context.userId,
        legalEntityId,
        stateHash: sha256(state),
        redirectUri,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    })
    const draft = this.config.get('AMAZON_SP_APP_DRAFT') !== 'false'
    const authorizationUrl = new URL(this.config.get('AMAZON_SP_AUTH_URL') ?? 'https://sellercentral.amazon.com/apps/authorize/consent')
    authorizationUrl.searchParams.set('application_id', applicationId)
    authorizationUrl.searchParams.set('state', state)
    if (draft) authorizationUrl.searchParams.set('version', 'beta')
    return { connectionId: connection.id, state: connection.state, provider: 'AMAZON_SP_API', authorizationUrl: authorizationUrl.toString() }
  }

  async complete(raw: Record<string, string>) {
    const stateValue = raw.state
    const code = raw.spapi_oauth_code
    const sellerId = raw.selling_partner_id
    if (raw.error) throw new AppError(400, 'OAUTH_CALLBACK_DENIED', raw.error_description ?? raw.error)
    if (!stateValue || !code || !sellerId) {
      throw new AppError(400, 'OAUTH_CALLBACK_INVALID', 'Amazon 回调缺少 state、spapi_oauth_code 或 selling_partner_id')
    }
    const oauthState = await this.system.oAuthState.findFirst({
      where: { stateHash: sha256(stateValue), consumedAt: null, expiresAt: { gt: new Date() } },
      include: { connection: true, legalEntity: true },
    })
    if (oauthState) bindTenantContext(oauthState.tenantId)
    if (!oauthState) throw new AppError(400, 'OAUTH_STATE_INVALID', '授权状态不存在、已使用或已过期')
    // 重新授权必须还是原来的卖家账户：换了账户会把原连接的历史数据挂到另一个账户下；换账户请新建连接
    const known = oauthState.connection.externalAccountId
    if (known && known !== sellerId) throw appError('OAUTH_SELLER_MISMATCH', '重新授权选择的卖家账户与原连接不一致，请用原来的卖家账户授权；换卖家账户请新建连接')

    const clientId = this.config.get<string>('AMAZON_SP_LWA_CLIENT_ID')
    const clientSecret = this.config.get<string>('AMAZON_SP_LWA_CLIENT_SECRET')
    if (!clientId || !clientSecret) throw new AppError(503, 'LWA_CONFIG_MISSING', 'Amazon LWA Client ID/Secret 尚未配置', true)

    const tokenResponse = await fetch(this.config.get<string>('AMAZON_SP_LWA_TOKEN_URL') ?? 'https://api.amazon.com/auth/o2/token', {
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
    const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { refresh_token?: string; error_description?: string }
    if (!tokenResponse.ok || !tokenBody.refresh_token) {
      throw new AppError(502, 'LWA_TOKEN_EXCHANGE_FAILED', tokenBody.error_description ?? 'Amazon LWA token exchange failed', true)
    }

    const legalEntity = oauthState.legalEntity ?? (await this.prisma.legalEntity.findFirst({ where: { tenantId: oauthState.tenantId } }))
    if (!legalEntity) throw new AppError(409, 'LEGAL_ENTITY_REQUIRED', '授权连接需要先绑定法律主体')

    const encryptedRefreshToken = await this.secrets.sealAmazonToken(tokenBody.refresh_token)
    const sellerAccount = await this.prisma.sellerAccount.upsert({
      where: {
        tenantId_provider_sellerId_logicalRegion: {
          tenantId: oauthState.tenantId,
          provider: 'AMAZON_SP_API',
          sellerId,
          logicalRegion: 'NA',
        },
      },
      create: {
        tenantId: oauthState.tenantId,
        legalEntityId: legalEntity.id,
        provider: 'AMAZON_SP_API',
        sellerId,
        logicalRegion: logicalRegionFromEndpoint(),
        displayName: `Amazon · ${sellerId}`,
        marketplaceIds: [],
      },
      // 重新授权同一个卖家账户时只确认归属，不覆盖用户改过的店铺名称
      update: { tenantId: oauthState.tenantId, legalEntityId: legalEntity.id },
    })
    const connection = await this.prisma.platformConnection.update({
      where: { id: oauthState.connectionId },
      data: {
        state: 'AUTHORIZED',
        sellerAccountId: sellerAccount.id,
        externalAccountId: sellerId,
        encryptedRefreshToken,
        refreshTokenUpdatedAt: new Date(),
        lastHealthCheckedAt: new Date(),
        lastErrorCode: null,
        grantedScopes: ['public-seller', 'seller', 'fba', 'reports'],
      },
    })
    await this.prisma.oAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } })
    // 授权完成后补一次真实的健康检查（上面的“最近检查时间”只表示授权完成，不代表接口已验证）；排不上队不影响授权结果
    await this.health.request(oauthState.tenantId, connection.id, `oauth:${connection.id}`).catch(() => undefined)
    return {
      connectionId: connection.id,
      sellerAccountId: sellerAccount.id,
      state: connection.state,
      sellingPartnerId: sellerId,
      message: 'Amazon SP-API 授权完成，Refresh Token 已加密保存',
    }
  }
}
