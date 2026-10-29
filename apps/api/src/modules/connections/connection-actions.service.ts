import { Injectable } from '@nestjs/common'
import {
  CONNECTION_ACTIONS,
  CONNECTION_MANAGE,
  CONNECTION_KIND_LABEL,
  ReasonBodySchema,
  connectionActionStates,
  type ConnectionDisconnectResult,
  type ConnectionHealthRequested,
  type ConnectionReauthorizeResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, ResolvedScope, assertStoreInScope, assertUnrestricted, connectionWhere } from '../auth'
import { AdsOAuthService } from './ads-oauth.service'
import { ConnectionHealthService } from './connection-health.service'
import { SpOAuthService } from './sp-oauth.service'

// 连接中心的动作（P5-04，09 章 9.6）：健康检查、重新授权、断开。每个动作都写审计；
// 找不到或不在数据范围内的连接一律按“找不到”处理；没有归属店铺的连接（广告授权、未完成的授权）只有“全部店铺”范围的成员能操作。
@Injectable()
export class ConnectionActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly health: ConnectionHealthService,
    private readonly spOAuth: SpOAuthService,
    private readonly adsOAuth: AdsOAuthService,
  ) {}

  private async load(tenantId: string, scope: ResolvedScope, id: string) {
    const connection = await this.prisma.platformConnection.findFirst({
      where: { id, tenantId, ...connectionWhere(scope) },
      select: {
        id: true,
        provider: true,
        state: true,
        sellerAccountId: true,
        sellerAccount: { select: { displayName: true, sellerId: true, legalEntityId: true } },
        adsProfile: { select: { sellerAccountId: true } },
      },
    })
    if (!connection) throw appError('RESOURCE_NOT_FOUND', '找不到这个连接')
    const storeId = connection.provider === 'AMAZON_ADS_API' ? (connection.adsProfile?.sellerAccountId ?? null) : connection.sellerAccountId
    if (storeId) assertStoreInScope(scope, storeId)
    else assertUnrestricted(scope)
    const hasToken = (await this.prisma.platformConnection.count({ where: { id, tenantId, encryptedRefreshToken: { not: null } } })) > 0
    return { ...connection, hasToken }
  }

  /** 健康检查：令牌只有后台任务能解密，所以这里只排一个检查任务并立即返回；结果在连接中心刷新后看到。 */
  async requestHealthCheck(req: RequestWithContext, id: string): Promise<ConnectionHealthRequested> {
    const { context, scope } = await this.context.authorizeScoped(req, CONNECTION_MANAGE, {})
    const connection = await this.load(context.tenantId, scope, id)
    const allowed = connectionActionStates(connection, null).healthCheck
    if (!allowed.allowed) throw appError('CONNECTION_UNAVAILABLE', allowed.reason ?? '这个连接现在不能做健康检查')
    const requested = await this.health.request(context.tenantId, id, req.requestId)
    await this.audit.record(req, {
      action: CONNECTION_ACTIONS.healthCheckRequested,
      resourceType: 'PlatformConnection',
      resourceId: id,
      detail: { provider: connection.provider, syncJobId: requested.syncJobId, alreadyRunning: requested.alreadyRunning },
    })
    return requested
  }

  /** 重新授权：沿用原连接发起一次新的授权跳转（授权回来后换发令牌，卖家账户必须与原连接一致）。 */
  async reauthorize(req: RequestWithContext, id: string): Promise<ConnectionReauthorizeResult> {
    const { context, scope } = await this.context.authorizeScoped(req, CONNECTION_MANAGE, {})
    const connection = await this.load(context.tenantId, scope, id)
    const who = { tenantId: context.tenantId, userId: context.userId }
    let issued: { connectionId: string; provider: string; authorizationUrl: string }
    if (connection.provider === 'AMAZON_ADS_API') {
      issued = await this.adsOAuth.reauthorize(who, connection)
    } else {
      // 授权没完成过的连接没有卖家账户，法律主体取当初发起授权时选的那个
      const pending = connection.sellerAccount
        ? null
        : await this.prisma.oAuthState.findFirst({
            where: { connectionId: id, tenantId: context.tenantId, legalEntityId: { not: null } },
            orderBy: { createdAt: 'desc' },
            select: { legalEntityId: true },
          })
      const legalEntityId = connection.sellerAccount?.legalEntityId ?? pending?.legalEntityId
      if (!legalEntityId) throw appError('CONNECTION_UNAVAILABLE', '这个连接没有记录法律主体，请直接新发起一次授权')
      issued = await this.spOAuth.reauthorize(who, { id, state: connection.state, legalEntityId })
    }
    await this.audit.record(req, {
      action: CONNECTION_ACTIONS.reauthorizeStarted,
      resourceType: 'PlatformConnection',
      resourceId: id,
      detail: { provider: connection.provider, state: connection.state },
    })
    return { connectionId: id, provider: issued.provider, authorizationUrl: issued.authorizationUrl }
  }

  /** 断开：清除令牌、状态改为已断开、排队中的同步任务作废；历史数据保留。要原因，由接口层先做二次验证。 */
  async disconnect(req: RequestWithContext, id: string, rawBody: unknown): Promise<ConnectionDisconnectResult> {
    const { context, scope } = await this.context.authorizeScoped(req, CONNECTION_MANAGE, {})
    const body = ReasonBodySchema.parse(rawBody)
    const connection = await this.load(context.tenantId, scope, id)
    if (connection.state === 'REVOKED') throw appError('CONNECTION_ALREADY_DISCONNECTED', '这个连接已经断开')
    const kind = connection.provider === 'AMAZON_ADS_API' ? 'ADS' : 'SELLER'
    const cancelledJobs = await this.prisma.$transaction(async tx => {
      // 带着状态条件去改：两个人同时点断开时，后到的拿到“已经断开”
      const updated = await tx.platformConnection.updateMany({
        where: { id, tenantId: context.tenantId, state: { not: 'REVOKED' } },
        data: { state: 'REVOKED', encryptedRefreshToken: null, lastErrorCode: null },
      })
      if (updated.count !== 1) throw appError('CONNECTION_ALREADY_DISCONNECTED', '这个连接已经断开')
      const cancelled = await tx.syncJob.updateMany({
        where: { connectionId: id, tenantId: context.tenantId, status: 'PENDING' },
        data: { status: 'FAILED_PERMANENT', failureCode: 'CONNECTION_DISCONNECTED', finishedAt: new Date() },
      })
      await this.audit.record(
        req,
        {
          action: CONNECTION_ACTIONS.disconnected,
          resourceType: 'PlatformConnection',
          resourceId: id,
          before: { state: connection.state },
          after: { state: 'REVOKED' },
          reason: body.reason,
          detail: {
            provider: connection.provider,
            kind: CONNECTION_KIND_LABEL[kind],
            ...(connection.sellerAccount ? { storeName: connection.sellerAccount.displayName, sellerId: connection.sellerAccount.sellerId } : {}),
            cancelledJobs: cancelled.count,
          },
        },
        { client: tx },
      )
      return cancelled.count
    })
    return { connectionId: id, state: 'REVOKED', cancelledJobs }
  }
}
