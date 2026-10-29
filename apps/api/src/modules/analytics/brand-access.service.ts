import { Injectable } from '@nestjs/common'
import {
  BA_BASIS,
  BA_NO_BRAND,
  BA_NO_BRAND_NOTE,
  BA_NO_DATA_NOTE,
  BA_PERIOD_OPTIONS_LIMIT,
  BR_STORE_STATE_LABEL,
  BRAND_ANALYTICS_READ,
  baReportOf,
  freshnessErrorMessage,
  periodEndOf,
  previousPeriodStart,
  type BaCommon,
  type BaPage,
  type BaPeriod,
  type BaPeriodInfo,
  type BrStoreState,
  type BrStoreStatus,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'

// 品牌分析各接口共用的准入、周期解析与响应头部（P4-04）：先权限（analytics.brand.read）、再数据范围、最后才校验参数。
// 品牌分析没有“日期范围”，只有“周期种类 + 周期起始日”：不传起始日就用这一种周期里最近一个有数据的周期。

export interface BrandAccess {
  tenantId: string
  scope: ResolvedScope
}

@Injectable()
export class BrandAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async resolve(req: RequestWithContext, rawQuery: Record<string, string>): Promise<BrandAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, BRAND_ANALYTICS_READ, rawQuery)
    return { tenantId: context.tenantId, scope }
  }

  /** 选中的周期：传了起始日就用它（可能没有数据），没传取最近一个有数据的周期。available 是已有数据的起始日（最近的在前）。 */
  periodOf(kind: BaPeriod, requested: string | undefined, available: readonly string[]): BaPeriodInfo {
    const start = requested ?? available[0] ?? null
    return {
      kind,
      start,
      end: start ? periodEndOf(kind, start) : null,
      previousStart: start ? previousPeriodStart(kind, start) : null,
      available: available.slice(0, BA_PERIOD_OPTIONS_LIMIT),
      defaulted: !requested,
    }
  }

  /** 各接口响应共有的头部：数据状态与说明、各店铺同步情况（按这一页对应的那份报告）、新鲜度、口径。 */
  async header(access: BrandAccess, page: BaPage, input: { period: BaPeriodInfo; hasData: boolean; truncated: boolean }, now = new Date()): Promise<BaCommon> {
    const key = baReportOf(page).freshnessKey
    const [stores, freshness] = await Promise.all([this.storeStatuses(access, key), sourceFreshness(this.prisma, access.tenantId, access.scope, [key], now)])
    return {
      state: input.hasData ? 'OK' : 'NO_DATA',
      note: input.hasData ? null : stores.length > 0 && stores.every(store => store.state === 'NO_BRAND') ? BA_NO_BRAND_NOTE : BA_NO_DATA_NOTE,
      period: input.period,
      stores,
      truncated: input.truncated,
      basis: BA_BASIS,
      freshness,
    }
  }

  /** 每家店这份报告最近一次的同步结果；缺品牌分析角色单独说明，没有记录就是“尚无记录”（不是“失败”）。 */
  private async storeStatuses(access: BrandAccess, key: string): Promise<BrStoreStatus[]> {
    const [stores, rows] = await Promise.all([
      this.prisma.sellerAccount.findMany({
        where: { tenantId: access.tenantId, ...(access.scope.unrestricted ? {} : { id: { in: access.scope.sellerAccountIds } }) },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
        take: 500,
      }),
      this.prisma.dataFreshness.findMany({
        where: { tenantId: access.tenantId, sourceKey: key, ...storeWhere(access.scope) },
        select: { sellerAccountId: true, status: true, lastErrorCode: true, lastSuccessAt: true },
        take: 1000,
      }),
    ])
    const byStore = new Map(rows.flatMap(row => (row.sellerAccountId ? [[row.sellerAccountId, row] as const] : [])))
    return stores.map<BrStoreStatus>(store => {
      const row = byStore.get(store.id)
      let state: BrStoreState = 'NO_RECORD'
      if (row) state = row.status === 'NORMAL' ? 'AVAILABLE' : row.lastErrorCode === BA_NO_BRAND ? 'NO_BRAND' : 'FAILED'
      const note =
        state === 'AVAILABLE'
          ? '品牌分析报告按周、月自动同步'
          : state === 'NO_BRAND'
            ? `未授权：${BA_NO_BRAND_NOTE}`
            : state === 'FAILED'
              ? (freshnessErrorMessage(row?.lastErrorCode) ?? '同步失败，请稍后重试或查看同步中心')
              : '这家店还没有同步过这份报告，授权并具备品牌分析角色后按周、月自动同步'
      return { sellerAccountId: store.id, storeName: store.displayName, state, stateLabel: BR_STORE_STATE_LABEL[state], note, lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null }
    })
  }
}
