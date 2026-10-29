import { Injectable } from '@nestjs/common'
import { ScopeSelectionSchema, US_MARKETPLACE_ID } from '@nova/api-contracts'
import { ApiContext, AppError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ResolvedScope } from './scope'

// 数据范围解析（P1-12，依据 06 章 6.3）。
// 规则：请求所选范围 与 成员被授予的范围 取交集；不在授权内的店铺被静默剔除；
// 交集为空返回 403，从不放开到“全部”。没有任何授权记录的成员没有数据访问权。
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(context: ApiContext, rawQuery: unknown): Promise<ResolvedScope> {
    // 站点只允许亚马逊美国站，其他站点由契约直接按 422 拒绝。
    const selection = ScopeSelectionSchema.parse(rawQuery ?? {})
    const grants = await this.prisma.membershipScope.findMany({
      where: { tenantId: context.tenantId, membershipId: context.membershipId },
      select: { legalEntityId: true, sellerAccountId: true },
    })
    if (grants.length === 0) throw new AppError(403, 'SCOPE_NOT_GRANTED', '当前账号尚未被授予任何店铺的数据访问范围，请联系管理员')

    const hasAll = grants.some(grant => !grant.legalEntityId && !grant.sellerAccountId)
    const requested = Boolean(selection.legalEntityIds?.length || selection.storeIds?.length)
    if (hasAll && !requested) return { unrestricted: true, sellerAccountIds: [], marketplaceId: selection.marketplaceId }

    const entityIds = grants.filter(grant => grant.legalEntityId && !grant.sellerAccountId).map(grant => grant.legalEntityId as string)
    const storeIds = grants.filter(grant => grant.sellerAccountId).map(grant => grant.sellerAccountId as string)
    const stores = await this.prisma.sellerAccount.findMany({
      where: {
        tenantId: context.tenantId,
        AND: [
          {
            ...(selection.storeIds?.length ? { id: { in: selection.storeIds } } : {}),
            ...(selection.legalEntityIds?.length ? { legalEntityId: { in: selection.legalEntityIds } } : {}),
          },
          hasAll ? {} : { OR: [{ legalEntityId: { in: entityIds } }, { id: { in: storeIds } }] },
        ],
      },
      select: { id: true },
    })
    if (stores.length === 0) throw new AppError(403, 'SCOPE_EMPTY', '所选范围内没有您有权访问的店铺')
    return { unrestricted: false, sellerAccountIds: stores.map(store => store.id), marketplaceId: selection.marketplaceId }
  }

  /**
   * 全局范围栏的可选项（P1-04）：只列出当前成员被授权的法律主体与店铺。
   * 没有任何授权记录时 granted 为 false，前端据此提示联系管理员，而不是显示空下拉。
   */
  async options(context: ApiContext) {
    const grants = await this.prisma.membershipScope.findMany({
      where: { tenantId: context.tenantId, membershipId: context.membershipId },
      select: { legalEntityId: true, sellerAccountId: true },
    })
    const unrestricted = grants.some(grant => !grant.legalEntityId && !grant.sellerAccountId)
    const entityGrantIds = grants.filter(grant => grant.legalEntityId && !grant.sellerAccountId).map(grant => grant.legalEntityId as string)
    const storeGrantIds = grants.filter(grant => grant.sellerAccountId).map(grant => grant.sellerAccountId as string)
    const stores =
      grants.length === 0
        ? []
        : await this.prisma.sellerAccount.findMany({
            where: {
              tenantId: context.tenantId,
              ...(unrestricted ? {} : { OR: [{ legalEntityId: { in: entityGrantIds } }, { id: { in: storeGrantIds } }] }),
            },
            select: { id: true, displayName: true, sellerId: true, legalEntityId: true },
            orderBy: { displayName: 'asc' },
          })
    const entityIds = unrestricted ? undefined : [...new Set([...entityGrantIds, ...stores.map(store => store.legalEntityId)])]
    const entities =
      grants.length === 0
        ? []
        : await this.prisma.legalEntity.findMany({
            where: { tenantId: context.tenantId, status: 'ACTIVE', ...(entityIds ? { id: { in: entityIds } } : {}) },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          })
    return {
      granted: grants.length > 0,
      unrestricted,
      entities,
      stores: stores.map(store => ({ id: store.id, name: store.displayName, sellerId: store.sellerId, legalEntityId: store.legalEntityId })),
      marketplace: { id: US_MARKETPLACE_ID, label: '美国站 Amazon.com' },
      compareModes: [
        { id: 'none', label: '不对比' },
        { id: 'previous', label: '上一期' },
        { id: 'yoy', label: '去年同期' },
        { id: 'custom', label: '自定义' },
      ],
      currencies: [
        { id: 'USD', label: '美元' },
        { id: 'ORIGINAL', label: '原币' },
      ],
    }
  }
}
