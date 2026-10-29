import { Injectable } from '@nestjs/common'
import {
  SNS_FRESHNESS_KEY,
  SNS_JOB_TYPE,
  SNS_ROLE_MISSING,
  SUBSCRIBE_SAVE_READ,
  ScopeSearchSchema,
  aggregateFreshness,
  freshnessSourceOfJobType,
  type InventoryFreshness,
  type SnsSync,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { resolvePeriods, todayIn, validZone, type ResolvedPeriods } from '../overview'

// 订阅省各接口共用的准入与范围解析（P4-06）：先权限（analytics.read）、再数据范围、最后才校验参数；“今天”按企业时区取。
// 同步状态按范围内店铺聚合（最差的店铺为准）：没开通订阅省的店铺记为“不适用”，不算故障。

export interface SnsAccess {
  tenantId: string
  scope: ResolvedScope
  scopeQuery: ReturnType<typeof ScopeSearchSchema.parse>
  periods: ResolvedPeriods
  today: string
}

const iso = (value: Date | null) => (value ? value.toISOString() : null)

@Injectable()
export class SubscribeSaveAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async resolve(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<SnsAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, SUBSCRIBE_SAVE_READ, rawQuery)
    const scopeQuery = ScopeSearchSchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    return { tenantId: context.tenantId, scope, scopeQuery, periods: resolvePeriods(scopeQuery, today), today }
  }

  /** 范围内店铺的订阅省同步状态与新鲜度条所需摘要。 */
  async sync(access: SnsAccess, now = new Date()): Promise<{ sync: SnsSync; freshness: InventoryFreshness }> {
    const spec = freshnessSourceOfJobType(SNS_JOB_TYPE)
    const { tenantId, scope } = access
    const [stores, rows] = await Promise.all([
      this.prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true }, take: 500 }),
      this.prisma.dataFreshness.findMany({
        where: { tenantId, sourceKey: SNS_FRESHNESS_KEY, ...storeWhere(scope) },
        select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
        take: 5000,
      }),
    ])
    const view = spec
      ? aggregateFreshness(
          rows,
          stores.map(store => store.id),
          now,
          [spec],
        ).sources[0]
      : undefined
    if (!view) {
      const none: SnsSync = { status: 'NO_RECORD', statusLabel: '尚无记录', lastSuccessAt: null, errorCode: null, errorMessage: null, rolePending: false }
      return { sync: none, freshness: { lastSuccessAt: null, sources: [], qualityIssues: 0 } }
    }
    const sync: SnsSync = {
      status: view.status,
      statusLabel: view.statusLabel,
      lastSuccessAt: iso(view.lastSuccessAt),
      errorCode: view.errorCode,
      errorMessage: view.errorMessage,
      rolePending: view.errorCode === SNS_ROLE_MISSING,
    }
    const healthy = ['NORMAL', 'NOT_APPLICABLE', 'NOT_CONNECTED', 'NO_RECORD']
    return {
      sync,
      freshness: { lastSuccessAt: sync.lastSuccessAt, sources: view.lastSuccessAt ? [view.label] : [], qualityIssues: healthy.includes(view.status) ? 0 : 1 },
    }
  }
}
