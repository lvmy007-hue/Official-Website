import { Injectable } from '@nestjs/common'
import {
  PROFIT_BASIS_LABEL,
  PROFIT_BASIS_NOTE,
  PROFIT_CURRENCY,
  PROFIT_FRESHNESS_KEYS,
  PROFIT_READ,
  ScopeSearchSchema,
  type InventoryFreshness,
  type ProfitBasis,
  type ProfitRange,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, type ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'
import { resolvePeriods, todayIn, validZone, type ResolvedPeriods } from '../overview'
import { profitWhere } from './profit-load'

// 利润分析各接口共用的准入与范围解析（P2b-10）：先权限（profit.read），再字段权限，最后才校验参数；日期范围按企业口径时区，没选范围默认最近 30 天。
// 利润类接口需要 field.profit；成本覆盖接口全部是成本数据，需要 field.cost。没有字段权限返回 403，而不是返回一份去掉利润的“销售额与费用”。

export interface ProfitAccess {
  tenantId: string
  scope: ResolvedScope
  permissions: readonly string[]
  canCost: boolean
  periods: ResolvedPeriods
  zone: string
  today: string
}

export const rangeOf = (period: { from: string; to: string; days: number }, defaulted: boolean): ProfitRange => ({ from: period.from, to: period.to, days: period.days, defaulted })

@Injectable()
export class ProfitAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 先权限、再字段权限、最后参数；`need` 是这个接口必须有的字段权限。 */
  async resolve(req: RequestWithContext, rawQuery: Record<string, string>, need: 'profit' | 'cost', now = new Date()): Promise<ProfitAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, PROFIT_READ, rawQuery)
    if (!canSeeField(context.permissions, need)) {
      throw new AppError(403, 'TENANT_ACCESS_DENIED', need === 'profit' ? '利润分析需要利润字段权限（field.profit）' : '成本覆盖需要成本字段权限（field.cost）')
    }
    const scopeQuery = ScopeSearchSchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const today = todayIn(zone, now)
    return {
      tenantId: context.tenantId,
      scope,
      permissions: context.permissions,
      canCost: canSeeField(context.permissions, 'cost'),
      periods: resolvePeriods(scopeQuery, today),
      zone,
      today,
    }
  }

  async freshness(access: ProfitAccess, now = new Date()): Promise<InventoryFreshness> {
    return sourceFreshness(this.prisma, access.tenantId, access.scope, PROFIT_FRESHNESS_KEYS, now)
  }

  /** 当前期的数据条件。 */
  where(access: ProfitAccess, basis: ProfitBasis, period = access.periods.period) {
    return profitWhere(access.tenantId, access.scope, basis, period.from, period.to)
  }

  /** 各接口响应共有的头部。 */
  common(access: ProfitAccess, basis: ProfitBasis, freshness: InventoryFreshness) {
    return {
      recognition: basis,
      basisLabel: PROFIT_BASIS_LABEL[basis],
      basisNote: PROFIT_BASIS_NOTE[basis],
      currency: PROFIT_CURRENCY,
      range: rangeOf(access.periods.period, access.periods.defaulted),
      freshness,
    }
  }
}

export const NO_DATA_NOTE = '所选范围内尚无利润数据：店铺授权后，订单、财务交易、广告同步完成会自动派生利润日表（每 6 小时重算近 45 天）；没有生效的成本版本时利润会是空的，不会当 0'
