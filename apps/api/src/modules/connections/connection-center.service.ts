import { Injectable } from '@nestjs/common'
import { CONNECTION_ALERT_RULE_CODE, CONNECTION_LIST_LIMIT, CONNECTION_MANAGE, CONNECTION_READ, ROLE_MODULES, tokenAgeParamsOf, type ConnectionCenterResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, adsProfileWhere, connectionWhere, storeWhere } from '../auth'
import { buildConnectionCenter, type ConnectionInput } from './connection-center.build'

const STORE_LIMIT = 200
const PROFILE_LIMIT = 500
const EVIDENCE_LIMIT = 20000
const ALL_SOURCES: readonly string[] = [...new Set(ROLE_MODULES.flatMap(item => item.sourceKeys))]

// 连接中心（P5-04，09 章 9.6）：四类连接的总览与角色对照。只读；动作（健康检查、重新授权、断开）在 ConnectionActionsService。
// 刷新令牌密文永远不读进来：只用“有令牌的连接编号”这一个布尔信息。
@Injectable()
export class ConnectionCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async overview(req: RequestWithContext): Promise<ConnectionCenterResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, CONNECTION_READ, {})
    const tenantId = context.tenantId
    const canManage = hasPermission(context.permissions, CONNECTION_MANAGE)
    const [rows, stores, profiles, entities, rule] = await Promise.all([
      this.prisma.platformConnection.findMany({
        where: { tenantId, ...connectionWhere(scope) },
        select: {
          id: true,
          provider: true,
          state: true,
          externalAccountId: true,
          refreshTokenUpdatedAt: true,
          grantedScopes: true,
          lastSuccessfulSyncAt: true,
          lastErrorCode: true,
          sellerAccountId: true,
          sellerAccount: { select: { id: true, displayName: true, sellerId: true, legalEntity: { select: { name: true } } } },
          adsProfile: { select: { displayName: true, profileId: true, sellerAccountId: true } },
          healthChecks: { orderBy: { checkedAt: 'desc' }, take: 1, select: { status: true, checks: true, checkedAt: true } },
        },
        orderBy: [{ provider: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
        take: CONNECTION_LIST_LIMIT + 1,
      }),
      this.prisma.sellerAccount.findMany({
        where: { tenantId, ...storeWhere(scope, 'id') },
        select: { id: true, displayName: true, sellerId: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: STORE_LIMIT,
      }),
      this.prisma.adsProfile.findMany({
        where: { tenantId, ...adsProfileWhere(scope) },
        select: { bindingStatus: true, sellerAccount: { select: { legalEntity: { select: { name: true } } } } },
        orderBy: { id: 'asc' },
        take: PROFILE_LIMIT,
      }),
      canManage
        ? this.prisma.legalEntity.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 100 })
        : Promise.resolve([]),
      this.prisma.alertRule.findFirst({ where: { tenantId, code: CONNECTION_ALERT_RULE_CODE }, select: { conditionJson: true } }),
    ])
    const shown = rows.slice(0, CONNECTION_LIST_LIMIT)
    const ids = shown.map(row => row.id)
    const liveStoreIds = [...new Set(shown.flatMap(row => (row.provider === 'AMAZON_SP_API' && row.state === 'AUTHORIZED' && row.sellerAccountId ? [row.sellerAccountId] : [])))]
    const [withToken, states, evidence] = await Promise.all([
      ids.length > 0
        ? this.prisma.platformConnection.findMany({ where: { tenantId, id: { in: ids }, encryptedRefreshToken: { not: null } }, select: { id: true }, take: CONNECTION_LIST_LIMIT })
        : Promise.resolve([]),
      ids.length > 0
        ? this.prisma.oAuthState.findMany({
            where: { tenantId, connectionId: { in: ids } },
            select: { connectionId: true, initiatedById: true, consumedAt: true, legalEntity: { select: { name: true } } },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: CONNECTION_LIST_LIMIT * 5,
          })
        : Promise.resolve([]),
      liveStoreIds.length > 0
        ? this.prisma.dataFreshness.findMany({
            where: { tenantId, sellerAccountId: { in: liveStoreIds }, sourceKey: { in: [...ALL_SOURCES] } },
            select: { sellerAccountId: true, sourceKey: true, status: true, lastSuccessAt: true, lastErrorCode: true },
            take: EVIDENCE_LIMIT,
          })
        : Promise.resolve([]),
    ])
    const tokenSet = new Set(withToken.map(row => row.id))
    const names = await memberNames(
      this.prisma,
      tenantId,
      states.map(item => (item.consumedAt ? item.initiatedById : null)),
    )
    const authorizers = new Map<string, { authorizedBy: string | null; legalEntityName: string | null }>()
    for (const item of states) {
      // 按“最近的在前”遍历：最近一次发起授权的法律主体、最近一次完成授权的成员，各取第一条
      const current = authorizers.get(item.connectionId) ?? { authorizedBy: null, legalEntityName: null }
      authorizers.set(item.connectionId, {
        authorizedBy: current.authorizedBy ?? (item.consumedAt ? nameOrFormer(names, item.initiatedById) : null),
        legalEntityName: current.legalEntityName ?? item.legalEntity?.name ?? null,
      })
    }
    const connections: ConnectionInput[] = shown.map(row => ({
      id: row.id,
      provider: row.provider,
      state: row.state,
      externalAccountId: row.externalAccountId,
      refreshTokenUpdatedAt: row.refreshTokenUpdatedAt,
      grantedScopes: row.grantedScopes,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      lastErrorCode: row.lastErrorCode,
      sellerAccountId: row.sellerAccountId,
      sellerAccount: row.sellerAccount
        ? { id: row.sellerAccount.id, displayName: row.sellerAccount.displayName, sellerId: row.sellerAccount.sellerId, legalEntityName: row.sellerAccount.legalEntity.name }
        : null,
      adsProfile: row.adsProfile,
      health: row.healthChecks[0] ?? null,
      hasToken: tokenSet.has(row.id),
    }))
    return buildConnectionCenter({
      now: new Date(),
      connections,
      truncated: rows.length > CONNECTION_LIST_LIMIT,
      stores,
      adsProfiles: profiles.map(profile => ({ bindingStatus: profile.bindingStatus, legalEntityName: profile.sellerAccount?.legalEntity.name ?? null })),
      authorizers,
      evidence,
      tokenAge: tokenAgeParamsOf(rule?.conditionJson),
      scope,
      canManage,
      legalEntities: entities,
    })
  }
}
