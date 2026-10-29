import { Injectable } from '@nestjs/common'
import { ScopeSearchSchema } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import type { ApiContext } from '../../platform/http'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, type ResolvedScope } from '../auth'
import { resolvePeriods, todayIn, validZone, type ResolvedPeriods } from './period'
import type { SummaryContext } from './summary-queries'

export interface OverviewRequest {
  context: ApiContext
  scope: ResolvedScope
  ctx: SummaryContext
  periods: ResolvedPeriods
  /** 企业数据口径时区（汇总日期按它落日） */
  timeZone: string
  /** 是否有“利润”字段权限：没有时利润相关的数一律不返回 */
  canSeeProfit: boolean
  /** 经营控制台页面自己的参数（粒度、指标等）从原始查询里取，范围参数已被解析 */
  query: Record<string, string>
}

// 经营控制台各接口的共同入口：校验 overview.read、解析数据范围与日期范围（默认近 30 天对比上一期）、判断字段权限。
// 日期按企业数据口径时区（与日汇总一致）落日。
@Injectable()
export class OverviewContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async prepare(req: RequestWithContext, query: Record<string, string>): Promise<OverviewRequest> {
    const { context, scope } = await this.context.authorizeScoped(req, 'overview.read', query)
    const dates = ScopeSearchSchema.parse(query)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const timeZone = validZone(tenant?.timezone)
    const periods = resolvePeriods(dates, todayIn(timeZone))
    return { context, scope, ctx: { tenantId: context.tenantId, scope }, periods, timeZone, canSeeProfit: canSeeField(context.permissions, 'profit'), query }
  }

  /** 范围内的店铺（编号与名称），最多 500 个。 */
  async stores(request: OverviewRequest) {
    return this.prisma.sellerAccount.findMany({
      where: { tenantId: request.ctx.tenantId, ...(request.scope.unrestricted ? {} : { id: { in: request.scope.sellerAccountIds } }) },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
      take: 500,
    })
  }
}
