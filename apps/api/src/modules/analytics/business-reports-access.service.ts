import { Injectable } from '@nestjs/common'
import {
  BR_FRESHNESS_KEYS,
  BR_NO_BRAND_NOTE,
  BR_NO_DATA_NOTE,
  BUSINESS_REPORTS_READ,
  ScopeSearchSchema,
  type BrCommon,
  type BrGranularity,
  type BrRange,
  type BrStoreStatus,
  type InventoryFreshness,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, type ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'
import { resolvePeriods, todayIn, validZone, type ResolvedPeriods } from '../overview'
import { loadStoreStatuses } from './business-reports-load'
import { defaultRangeFor } from './business-reports-math'

// 业务报告各接口共用的准入与范围解析（P4-02）：先权限（analytics.read）、再数据范围、最后才校验参数；日期按企业口径时区取“今天”。
// 销售与流量的日期本身是亚马逊美国站（太平洋时区）的日历日，不按企业时区换算，页面口径说明里写明。

export const BR_BASIS =
  '销售额与件数是官方订购口径（下单时计）；数据中心为主、报告补充为辅，同一店铺同一天两边都有时只用数据中心；日期是亚马逊美国站（太平洋时区）的日历日，不按企业时区换算；只统计美元。'

export interface BrAccess {
  tenantId: string
  /** 当前成员的权限（P4-03：父体各页签按各自的权限决定显示还是隐藏）。 */
  permissions: string[]
  scope: ResolvedScope
  scopeQuery: ReturnType<typeof ScopeSearchSchema.parse>
  periods: ResolvedPeriods
  today: string
}

const DAY_MS = 86_400_000
export const spanOf = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1

@Injectable()
export class BusinessReportsAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async resolve(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BrAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, BUSINESS_REPORTS_READ, rawQuery)
    return this.finish(context, scope, rawQuery, now)
  }

  private async finish(context: { tenantId: string; permissions: string[] }, scope: ResolvedScope, rawQuery: Record<string, string>, now: Date): Promise<BrAccess> {
    const scopeQuery = ScopeSearchSchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    return { tenantId: context.tenantId, permissions: context.permissions, scope, scopeQuery, periods: resolvePeriods(scopeQuery, today), today }
  }

  /** 本次请求的日期范围：选了就用所选；没选按粒度取默认（日 30 天、周 12 周、月 12 个月）。 */
  rangeOf(access: BrAccess, granularity: BrGranularity): BrRange {
    const chosen = Boolean(access.scopeQuery.from && access.scopeQuery.to)
    const { from, to } = chosen ? { from: access.scopeQuery.from!, to: access.scopeQuery.to! } : defaultRangeFor(granularity, access.today)
    return { from, to, days: spanOf(from, to), defaulted: !chosen }
  }

  /** 各接口响应共有的头部：数据状态与说明、各店铺同步情况、新鲜度、口径。 */
  async header(access: BrAccess, input: { range: BrRange; hasData: boolean; truncated: boolean; latestDate: string | null }, now = new Date()): Promise<BrCommon> {
    const [stores, freshness] = await Promise.all([loadStoreStatuses(this.prisma, access.tenantId, access.scope), this.freshness(access, now)])
    return {
      state: input.hasData ? 'OK' : 'NO_DATA',
      note: input.hasData ? null : noDataNote(stores),
      range: input.range,
      currency: 'USD',
      stores,
      latestDate: input.latestDate,
      truncated: input.truncated,
      basis: BR_BASIS,
      freshness,
    }
  }

  private freshness(access: BrAccess, now: Date): Promise<InventoryFreshness> {
    return sourceFreshness(this.prisma, access.tenantId, access.scope, BR_FRESHNESS_KEYS, now)
  }
}

/** 没有数据时的说明：所有店铺都缺品牌分析角色就写前提，否则写通用说明。 */
export function noDataNote(stores: readonly BrStoreStatus[]): string {
  if (stores.length > 0 && stores.every(store => store.state === 'NO_BRAND')) return BR_NO_BRAND_NOTE
  return BR_NO_DATA_NOTE
}
