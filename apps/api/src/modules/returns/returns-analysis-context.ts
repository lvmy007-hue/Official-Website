import { Injectable } from '@nestjs/common'
import {
  RETURN_ANALYSIS_PERMISSION,
  RETURN_DEFAULT_DAYS,
  ReturnBasisParamsSchema,
  ReturnCycleParamsSchema,
  ScopeQuerySchema,
  splitAnalysisQuery,
  type ReturnBasisParams,
  type ReturnCycleParams,
  type ReturnTimeBasis,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'
import { addDays, todayIn, validZone, zonedDayStart } from '../overview'
import { RETURN_FRESHNESS_KEYS } from './returns-list.service'

// 退货分析各接口的公共前置（P6-13）：先校验权限与数据范围，再解析范围参数与本页参数，算出时间范围与按时间口径的筛选条件。
// 默认范围与退货列表一致（最近 90 天）；时间口径 return 按退货日期落在范围内，order 按下单日期落在范围内（缺下单时间的退货另计）。

export interface AnalysisOpen<P> {
  tenantId: string
  scope: ResolvedScope
  zone: string
  today: string
  from: string
  to: string
  defaulted: boolean
  timeBasis: ReturnTimeBasis
  params: P
  /** 租户 + 数据范围。 */
  base: Prisma.FbaReturnCaseWhereInput
  /** 租户 + 数据范围 + 按时间口径落在范围内。 */
  where: Prisma.FbaReturnCaseWhereInput
  /** 按时间口径换成某个日期区间的筛选条件（三期对比、月份用）。 */
  inRange: (from: string, to: string) => Prisma.FbaReturnCaseWhereInput
  /** 缺下单时间、无法落入下单口径的退货（return 口径：退货日期在范围内；order 口径：退货日期不早于范围起点）。 */
  unknownWhere: Prisma.FbaReturnCaseWhereInput
  /** 时间口径对应的日期列。 */
  dateField: 'returnDate' | 'orderPurchasedAt'
}

@Injectable()
export class ReturnsAnalysisContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async open(req: RequestWithContext, rawQuery: Record<string, string>, kind: 'basis'): Promise<AnalysisOpen<ReturnBasisParams>>
  async open(req: RequestWithContext, rawQuery: Record<string, string>, kind: 'cycle'): Promise<AnalysisOpen<ReturnCycleParams>>
  async open(req: RequestWithContext, rawQuery: Record<string, string>, kind: 'basis' | 'cycle'): Promise<AnalysisOpen<ReturnBasisParams | ReturnCycleParams>> {
    const { scope: scopeRaw, params: paramsRaw } = splitAnalysisQuery(rawQuery)
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, RETURN_ANALYSIS_PERMISSION, scopeRaw)
    const query = ScopeQuerySchema.parse(scopeRaw)
    const params = kind === 'cycle' ? ReturnCycleParamsSchema.parse(paramsRaw) : ReturnBasisParamsSchema.parse(paramsRaw)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const today = todayIn(zone)
    const defaulted = !(query.from && query.to)
    const to = query.to ?? today
    const from = query.from ?? addDays(to, 1 - RETURN_DEFAULT_DAYS)
    const dateField = params.timeBasis === 'order' ? 'orderPurchasedAt' : 'returnDate'
    const onlyAsin = 'asin' in params ? params.asin : undefined
    const base: Prisma.FbaReturnCaseWhereInput = { tenantId: context.tenantId, ...storeWhere(scope), ...(onlyAsin ? { asin: onlyAsin } : {}) }
    const inRange = (start: string, end: string): Prisma.FbaReturnCaseWhereInput => ({ ...base, [dateField]: { gte: zonedDayStart(start, zone), lt: zonedDayStart(addDays(end, 1), zone) } })
    const unknownWhere: Prisma.FbaReturnCaseWhereInput =
      params.timeBasis === 'order' ? { ...base, orderPurchasedAt: null, returnDate: { gte: zonedDayStart(from, zone) } } : { ...inRange(from, to), orderPurchasedAt: null }
    return { tenantId: context.tenantId, scope, zone, today, from, to, defaulted, timeBasis: params.timeBasis, params, base, where: inRange(from, to), inRange, unknownWhere, dateField }
  }

  freshness(tenantId: string, scope: ResolvedScope) {
    return sourceFreshness(this.prisma, tenantId, scope, RETURN_FRESHNESS_KEYS)
  }

  /** 缺下单时间的退货：件数与条数（M-704）。 */
  async unknown(where: Prisma.FbaReturnCaseWhereInput): Promise<{ units: number; rows: number }> {
    const result = await this.prisma.fbaReturnCase.aggregate({ where, _sum: { quantity: true }, _count: { _all: true } })
    return { units: result._sum.quantity ?? 0, rows: result._count._all }
  }
}
