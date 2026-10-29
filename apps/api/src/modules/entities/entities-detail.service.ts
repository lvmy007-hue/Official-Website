import { Injectable } from '@nestjs/common'
import {
  ENTITY_ADS_ACCOUNT_LIMIT,
  ENTITY_CHANGE_LIMIT,
  ENTITY_MEMBERS_PERMISSION,
  ENTITY_MEMBER_LIMIT,
  ENTITY_READ,
  ENTITY_STORE_LIMIT,
  LEGAL_ENTITY_ACTION_LABEL,
  entityAccessOf,
  entityChangesOf,
  entityDeactivateBlockReason,
  type EntityAdsAccountView,
  type EntityChangeView,
  type EntityMemberView,
  type EntityStoreView,
  type LegalEntityDetail,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { entityRowOf, entityScopeWhere, entityWriteBlock } from './entities-common'

const GRANT_LIMIT = 5000

// 法律主体详情（P5-07，09 章 9.9）：基本资料、名下店铺与广告账户、被授权访问该主体的成员、变更记录。
// 受限成员只看到自己数据范围内的店铺与广告账户；成员一节需要“成员查看”权限，没有时明确标“无权查看”，不拿空列表冒充。
@Injectable()
export class EntitiesDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<LegalEntityDetail> {
    const { context, scope } = await this.context.authorizeScoped(req, ENTITY_READ, {})
    const tenantId = context.tenantId
    // 范围外的主体与不存在的一样返回 404，不泄露它的存在
    const entity = await this.prisma.legalEntity.findFirst({ where: { id, tenantId, ...entityScopeWhere(scope) } })
    if (!entity) throw appError('RESOURCE_NOT_FOUND', '法律主体不存在')

    const storeRows = await this.prisma.sellerAccount.findMany({
      where: { tenantId, legalEntityId: id, ...storeWhere(scope, 'id') },
      select: { id: true, displayName: true, sellerId: true, logicalRegion: true, connections: { select: { provider: true, state: true } } },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: ENTITY_STORE_LIMIT + 1,
    })
    const shownStores = storeRows.slice(0, ENTITY_STORE_LIMIT)
    const storeIds = shownStores.map(store => store.id)
    const canSeeMembers = hasPermission(context.permissions, ENTITY_MEMBERS_PERMISSION)
    const [profiles, grants, audits, totalStores] = await Promise.all([
      storeIds.length
        ? this.prisma.adsProfile.findMany({
            where: { tenantId, sellerAccountId: { in: storeIds } },
            select: { id: true, displayName: true, profileId: true, countryCode: true, status: true, bindingStatus: true, sellerAccountId: true },
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
            take: ENTITY_ADS_ACCOUNT_LIMIT + 1,
          })
        : Promise.resolve([]),
      canSeeMembers
        ? this.prisma.membershipScope.findMany({
            where: {
              tenantId,
              OR: [{ legalEntityId: null, sellerAccountId: null }, { legalEntityId: id, sellerAccountId: null }, ...(storeIds.length ? [{ sellerAccountId: { in: storeIds } }] : [])],
            },
            select: {
              membershipId: true,
              legalEntityId: true,
              sellerAccountId: true,
              membership: { select: { status: true, user: { select: { displayName: true, email: true } }, role: { select: { name: true } } } },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: GRANT_LIMIT,
          })
        : Promise.resolve([]),
      this.prisma.auditEvent.findMany({
        where: { tenantId, resourceType: 'LegalEntity', resourceId: id, result: 'SUCCEEDED' },
        select: { id: true, actorId: true, action: true, reason: true, beforeJson: true, afterJson: true, occurredAt: true },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: ENTITY_CHANGE_LIMIT,
      }),
      // 停用前置条件看名下全部店铺，不受数据范围收窄（改主体要求“全部店铺”范围，这里给的是同一个口径）
      this.prisma.sellerAccount.count({ where: { tenantId, legalEntityId: id } }),
    ])
    const names = await memberNames(
      this.prisma,
      tenantId,
      audits.map(item => item.actorId),
    )

    const stores: EntityStoreView[] = shownStores.map(store => {
      const sp = store.connections.filter(connection => connection.provider === 'AMAZON_SP_API')
      const live = sp.find(connection => connection.state === 'AUTHORIZED') ?? sp[0]
      return { id: store.id, displayName: store.displayName, sellerId: store.sellerId, logicalRegion: store.logicalRegion, connectionState: live?.state ?? null }
    })
    const storeName = new Map(shownStores.map(store => [store.id, store.displayName]))
    const adsAccounts: EntityAdsAccountView[] = profiles.slice(0, ENTITY_ADS_ACCOUNT_LIMIT).map(profile => ({
      id: profile.id,
      displayName: profile.displayName ?? profile.profileId,
      profileId: profile.profileId,
      countryCode: profile.countryCode,
      status: profile.status,
      bindingStatus: profile.bindingStatus,
      storeName: profile.sellerAccountId ? (storeName.get(profile.sellerAccountId) ?? null) : null,
    }))

    const byMember = new Map<string, typeof grants>()
    for (const grant of grants) byMember.set(grant.membershipId, [...(byMember.get(grant.membershipId) ?? []), grant])
    const entityStores = new Set(storeIds)
    const members: EntityMemberView[] = []
    for (const [membershipId, rows] of byMember) {
      const access = entityAccessOf(rows, id, entityStores)
      if (!access) continue
      const { membership } = rows[0]
      members.push({
        membershipId,
        name: membership.user.displayName || membership.user.email,
        email: membership.user.email,
        roleName: membership.role.name,
        status: membership.status,
        access: access.kind,
        storeNames: access.storeIds.map(storeId => storeName.get(storeId) ?? storeId),
      })
    }
    members.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.membershipId.localeCompare(b.membershipId))

    const changes: EntityChangeView[] = audits.map(item => ({
      id: item.id,
      occurredAt: item.occurredAt.toISOString(),
      actor: nameOrFormer(names, item.actorId),
      action: item.action,
      actionLabel: LEGAL_ENTITY_ACTION_LABEL[item.action] ?? item.action,
      reason: item.reason,
      changes: entityChangesOf(item.beforeJson, item.afterJson),
    }))

    const adsCount = Math.min(profiles.length, ENTITY_ADS_ACCOUNT_LIMIT)
    const writeBlocked = entityWriteBlock(context.permissions, scope)
    const deactivateBlock = entityDeactivateBlockReason(totalStores)
    return {
      entity: { ...entityRowOf(entity, stores.length, adsCount), updatedAt: entity.updatedAt.toISOString() },
      stores,
      storesTruncated: storeRows.length > ENTITY_STORE_LIMIT,
      adsAccounts,
      adsAccountsTruncated: profiles.length > ENTITY_ADS_ACCOUNT_LIMIT,
      members: { state: canSeeMembers ? 'OK' : 'RESTRICTED', items: canSeeMembers ? members.slice(0, ENTITY_MEMBER_LIMIT) : [], truncated: canSeeMembers && members.length > ENTITY_MEMBER_LIMIT },
      changes,
      canWrite: writeBlocked === null,
      writeBlockedReason: writeBlocked,
      canDeactivate: writeBlocked === null && entity.status === 'ACTIVE' && deactivateBlock === null,
      deactivateBlockedReason: entity.status !== 'ACTIVE' ? '主体已停用' : deactivateBlock,
    }
  }
}
