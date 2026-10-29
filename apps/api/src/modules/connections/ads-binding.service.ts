import { Injectable } from '@nestjs/common'
import {
  ADS_ACCOUNT_BIND,
  ADS_BINDING_CHANGE_LABEL,
  ADS_BINDING_LIST_LIMIT,
  ADS_BINDING_READ,
  ADS_BINDING_STATUSES,
  ADS_BINDING_STATUS_LABEL,
  ADS_BINDING_STORE_LIMIT,
  ADS_UNBOUND_REASON_TEXT,
  AdsAccountBindBodySchema,
  bindingChangeOf,
  bindingReasonRequired,
  marketplaceWarning,
  unboundReasonOf,
  type AdsAccountBindResult,
  type AdsAccountBindingList,
  type AdsAccountBindingRow,
  type AdsBindingStatus,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, adsProfileWhere, assertUnrestricted } from '../auth'

const statusOf = (value: string): AdsBindingStatus => ((ADS_BINDING_STATUSES as readonly string[]).includes(value) ? (value as AdsBindingStatus) : 'UNBOUND')

const BLOCKED_NO_PERMISSION = '没有“广告账户与店铺人工绑定”权限（企业所有者与管理员有）'
const BLOCKED_NOT_UNRESTRICTED = '绑定会改变谁能看到这个广告账户的数据，需要“全部店铺”数据范围'

// 广告账户与店铺绑定（P3-03，09 章 9.6）：自动匹配由 worker 在同步广告档案时完成（规则见 api-contracts 的 ads-binding.ts），
// 这里提供绑定清单与人工绑定。人工绑定的结果永不被自动匹配覆盖；改绑与解除绑定要写原因；每次都写审计。
// 绑定决定谁能看到这个广告账户下的全部数据（范围过滤通过 adsProfile.sellerAccountId），所以只有“全部店铺”范围的人能改。
@Injectable()
export class AdsBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async list(req: RequestWithContext): Promise<AdsAccountBindingList> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_BINDING_READ, {})
    const tenantId = context.tenantId
    const hasPermissionToBind = hasPermission(context.permissions, ADS_ACCOUNT_BIND)
    const canBind = hasPermissionToBind && scope.unrestricted
    const rows = await this.prisma.adsProfile.findMany({
      where: { tenantId, ...adsProfileWhere(scope) },
      select: {
        id: true,
        profileId: true,
        displayName: true,
        countryCode: true,
        marketplaceId: true,
        currencyCode: true,
        status: true,
        accountId: true,
        adsAccountId: true,
        bindingStatus: true,
        boundBy: true,
        sellerAccountId: true,
        updatedAt: true,
        sellerAccount: { select: { id: true, displayName: true, sellerId: true } },
      },
      // 先列未绑定的（要处理的），再列人工绑定，最后是自动匹配
      orderBy: [{ bindingStatus: 'desc' }, { displayName: 'asc' }, { id: 'asc' }],
      take: ADS_BINDING_LIST_LIMIT + 1,
    })
    const shown = rows.slice(0, ADS_BINDING_LIST_LIMIT)
    const accountIds = [...new Set(shown.flatMap(row => (row.accountId ? [row.accountId] : [])))]
    const [groups, names, stores] = await Promise.all([
      accountIds.length > 0
        ? this.prisma.sellerAccount.groupBy({ by: ['sellerId'], where: { tenantId, sellerId: { in: accountIds } }, _count: { _all: true }, orderBy: { sellerId: 'asc' }, take: ADS_BINDING_LIST_LIMIT })
        : Promise.resolve([]),
      memberNames(
        this.prisma,
        tenantId,
        shown.map(row => row.boundBy),
      ),
      canBind
        ? this.prisma.sellerAccount.findMany({
            where: { tenantId },
            select: { id: true, displayName: true, sellerId: true, logicalRegion: true },
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
            take: ADS_BINDING_STORE_LIMIT,
          })
        : Promise.resolve([]),
    ])
    const candidates = new Map(groups.map(group => [group.sellerId, group._count._all]))
    const items = shown.map((row): AdsAccountBindingRow => {
      const bindingStatus = statusOf(row.bindingStatus)
      const candidateCount = row.accountId ? (candidates.get(row.accountId) ?? 0) : 0
      const reason = unboundReasonOf({ sellerAccountId: row.sellerAccountId, bindingStatus, accountId: row.accountId, candidateCount })
      return {
        id: row.id,
        profileId: row.profileId,
        displayName: row.displayName ?? row.profileId,
        countryCode: row.countryCode,
        marketplaceId: row.marketplaceId,
        currency: row.currencyCode,
        status: row.status,
        accountId: row.accountId,
        adsAccountId: row.adsAccountId,
        bindingStatus,
        bindingStatusLabel: ADS_BINDING_STATUS_LABEL[bindingStatus],
        store: row.sellerAccount ? { id: row.sellerAccount.id, displayName: row.sellerAccount.displayName, sellerId: row.sellerAccount.sellerId } : null,
        boundBy: bindingStatus === 'MANUAL' && row.boundBy ? nameOrFormer(names, row.boundBy) : null,
        unboundReason: reason,
        unboundReasonText: reason ? ADS_UNBOUND_REASON_TEXT[reason] : null,
        candidateCount,
        updatedAt: row.updatedAt.toISOString(),
      }
    })
    const count = (status: AdsBindingStatus) => items.filter(item => item.bindingStatus === status).length
    return {
      items,
      summary: { total: items.length, autoMatched: count('AUTO_MATCHED'), manual: count('MANUAL'), unbound: count('UNBOUND') },
      stores: stores.map(store => ({ id: store.id, displayName: store.displayName, sellerId: store.sellerId, logicalRegion: store.logicalRegion })),
      canBind,
      bindBlockedReason: canBind ? null : !hasPermissionToBind ? BLOCKED_NO_PERMISSION : BLOCKED_NOT_UNRESTRICTED,
      truncated: rows.length > ADS_BINDING_LIST_LIMIT,
    }
  }

  async bind(req: RequestWithContext, id: string, rawBody: unknown): Promise<AdsAccountBindResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_ACCOUNT_BIND, {})
    assertUnrestricted(scope)
    const body = AdsAccountBindBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const profile = await this.prisma.adsProfile.findFirst({
      where: { id, tenantId },
      select: { id: true, profileId: true, displayName: true, marketplaceId: true, sellerAccountId: true, bindingStatus: true },
    })
    if (!profile) throw appError('RESOURCE_NOT_FOUND', '找不到这个广告账户')
    const store = body.sellerAccountId
      ? await this.prisma.sellerAccount.findFirst({ where: { id: body.sellerAccountId, tenantId }, select: { id: true, displayName: true, sellerId: true, marketplaceIds: true } })
      : null
    if (body.sellerAccountId && !store) {
      throw appError('VALIDATION_FAILED', '找不到这个店铺（或不属于当前企业）', { fieldErrors: { sellerAccountId: ['请选择本企业的店铺'] } })
    }
    const change = bindingChangeOf(profile, body.sellerAccountId)
    const warnings = store ? [marketplaceWarning(profile.marketplaceId, store.marketplaceIds, store.displayName)].filter((text): text is string => text !== null) : []
    if (change === 'NONE') {
      return { id, change, changeLabel: ADS_BINDING_CHANGE_LABEL[change], changed: false, bindingStatus: statusOf(profile.bindingStatus), sellerAccountId: profile.sellerAccountId, warnings }
    }
    if (bindingReasonRequired(change) && !body.reason) {
      throw appError('VALIDATION_FAILED', '改绑或解除绑定会改变谁能看到这个广告账户的数据，请写明原因', { fieldErrors: { reason: ['请写明改绑或解除绑定的原因'] } })
    }
    const nextStatus: AdsBindingStatus = store ? 'MANUAL' : 'UNBOUND'
    const before = { sellerAccountId: profile.sellerAccountId, bindingStatus: profile.bindingStatus }
    const after = { sellerAccountId: store?.id ?? null, bindingStatus: nextStatus }
    await this.prisma.$transaction(async tx => {
      // 带着读到的旧值去改：期间被他人或同步器的自动匹配改动过，就不覆盖，让人刷新后再决定
      const updated = await tx.adsProfile.updateMany({
        where: { id, tenantId, sellerAccountId: profile.sellerAccountId, bindingStatus: profile.bindingStatus },
        data: { sellerAccountId: after.sellerAccountId, bindingStatus: nextStatus, boundBy: store ? context.userId : null },
      })
      if (updated.count !== 1) throw appError('CONFLICT', '这个广告账户刚刚被他人或自动匹配改动过，请刷新后再试')
      await this.audit.record(
        req,
        {
          action: change === 'UNBIND' ? 'ADS_ACCOUNT_UNBOUND' : 'ADS_ACCOUNT_BOUND',
          resourceType: 'AdsProfile',
          resourceId: id,
          before,
          after,
          reason: body.reason,
          detail: { change, profileId: profile.profileId, displayName: profile.displayName, ...(store ? { storeName: store.displayName, sellerId: store.sellerId } : {}) },
        },
        { client: tx },
      )
    })
    return { id, change, changeLabel: ADS_BINDING_CHANGE_LABEL[change], changed: true, bindingStatus: nextStatus, sellerAccountId: after.sellerAccountId, warnings }
  }
}
