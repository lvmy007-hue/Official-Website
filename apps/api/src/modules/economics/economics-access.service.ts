import { Injectable } from '@nestjs/common'
import { ECONOMICS_COMPARE_MAX_DAYS, ECONOMICS_FIELD_COST, ECONOMICS_FIELD_PROFIT, ECONOMICS_READ, ScopeSearchSchema, type EconomicsRange } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, type ResolvedScope } from '../auth'
import { resolvePeriods, todayIn, validZone } from '../overview'

// 官方经济数据对账各接口共用的准入（P2b-11）：先权限（finance.read），再字段权限，最后才校验参数；日期范围按企业口径时区，没选范围默认最近 30 天。
// 双源核对同时展示利润与成本（官方净收入 = 销售 − 费用 − 广告 − 成本，有销售与费用就能反推成本），所以必须同时有 field.profit 与 field.cost，缺任何一个返回 403，而不是返回残缺的核对。
// 费用预览只是官方对未来费用的估算，不含利润与成本，只需要 finance.read。

export interface EconomicsAccess {
  tenantId: string
  userId: string
  scope: ResolvedScope
  permissions: readonly string[]
  canProfit: boolean
  range: EconomicsRange
  zone: string
  today: string
}

@Injectable()
export class EconomicsAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** `fields` 为 true 时要求利润与成本字段权限（双源核对）；范围超过 90 天返回 422。 */
  async resolve(req: RequestWithContext, rawQuery: Record<string, string>, options: { fields: boolean; now?: Date }): Promise<EconomicsAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, ECONOMICS_READ, rawQuery)
    const canProfit = canSeeField(context.permissions, 'profit')
    if (options.fields && !(canProfit && canSeeField(context.permissions, 'cost'))) {
      throw new AppError(403, 'TENANT_ACCESS_DENIED', `官方经济数据核对包含利润与成本，需要利润字段权限（${ECONOMICS_FIELD_PROFIT}）和成本字段权限（${ECONOMICS_FIELD_COST}）`)
    }
    const scopeQuery = ScopeSearchSchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const today = todayIn(zone, options.now)
    const periods = resolvePeriods(scopeQuery, today)
    const { period } = periods
    if (options.fields && period.days > ECONOMICS_COMPARE_MAX_DAYS) {
      throw new AppError(422, 'VALIDATION_FAILED', `双源核对一次最多看 ${ECONOMICS_COMPARE_MAX_DAYS} 天，请缩小日期范围`)
    }
    return {
      tenantId: context.tenantId,
      userId: context.userId,
      scope,
      permissions: context.permissions,
      canProfit,
      range: { from: period.from, to: period.to, days: period.days, defaulted: periods.defaulted },
      zone,
      today,
    }
  }
}
