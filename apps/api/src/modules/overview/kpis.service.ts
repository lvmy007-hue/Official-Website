import { Injectable } from '@nestjs/common'
import { AttributionQuerySchema, type AttributionResponse, type KpisResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { PrismaService } from '../../platform/prisma.service'
import { attributionFactors } from './aggregate'
import { buildKpiCards } from './kpi-cards'
import { OverviewContextService, type OverviewRequest } from './overview-context.service'
import { bucketBounds, eachDay, previousBucket } from './period'
import { dailyValues, refreshInfo, totalValues } from './summary-queries'
import { targetBanner } from './target-banner'

const OPEN_ALERT = ['NEW', 'ACKED']
export const OFFICIAL_PROFIT_NOTE = '官方净收益来自数据中心的单品经济数据，对照功能随阶段 2b 接入，目前尚未接入'
const PROFIT_BRIDGE_NOTE = '利润桥需要利润日表里的成本、费用、广告等分项，随 P2b-09 交付；目前只能看销售额归因'

// 经营控制台：指标卡与指标树归因（04 章 4.1 第 2、3 项）。数据来自 P2a-01 的汇总表，没有的来源如实标注。
@Injectable()
export class KpisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly base: OverviewContextService,
  ) {}

  /** 待处理异常数（M-010）：状态为“新”“处理中”、在可见范围内（含不属于任何店铺的企业级预警）的预警实例，按严重度分组。 */
  private async anomalies(request: OverviewRequest) {
    const { scope, ctx } = request
    const groups = await this.prisma.alertInstance.groupBy({
      by: ['severity'],
      where: { tenantId: ctx.tenantId, status: { in: OPEN_ALERT }, ...(scope.unrestricted ? {} : { OR: [{ sellerAccountId: null }, { sellerAccountId: { in: scope.sellerAccountIds } }] }) },
      _count: { _all: true },
    })
    const count = (severity: string) => groups.find(group => group.severity === severity)?._count._all ?? 0
    const all = groups.reduce((total, group) => total + group._count._all, 0)
    // 未知严重度的并入“提示”，保证三项之和等于总数
    return { critical: count('CRITICAL'), warning: count('WARNING'), info: all - count('CRITICAL') - count('WARNING') }
  }

  async kpis(req: RequestWithContext, query: Record<string, string>): Promise<KpisResponse> {
    const request = await this.base.prepare(req, query)
    const { period, compare, defaulted } = request.periods
    const [daily, current, previous, info, anomalies, target] = await Promise.all([
      dailyValues(this.prisma, request.ctx, period.from, period.to),
      totalValues(this.prisma, request.ctx, period.from, period.to),
      compare ? totalValues(this.prisma, request.ctx, compare.from, compare.to) : Promise.resolve(null),
      refreshInfo(this.prisma, request.ctx, period.from, period.to),
      this.anomalies(request),
      targetBanner(this.prisma, request.context.tenantId, request.scope, period),
    ])
    return {
      period,
      compare,
      defaulted,
      currency: 'USD',
      metricVersion: info?.metricVersion ?? null,
      salesSource: info?.salesSource ?? null,
      refreshedAt: info?.refreshedAt ?? null,
      cards: buildKpiCards({
        current: current.values,
        currentHasRows: current.hasRows,
        previous: previous?.values ?? null,
        previousHasRows: previous?.hasRows ?? false,
        daily,
        days: eachDay(period.from, period.to),
        canSeeProfit: request.canSeeProfit,
        anomalies,
      }),
      officialProfit: { state: 'NOT_CONNECTED', note: OFFICIAL_PROFIT_NOTE },
      target,
      anomalyBreakdown: anomalies,
    }
  }

  /** 指标树归因：点击某一天（或周、月），本期相对上一个同类时段的销售额变化拆成各因子的贡献。 */
  async attribution(req: RequestWithContext, query: Record<string, string>): Promise<AttributionResponse> {
    const request = await this.base.prepare(req, query)
    const parsed = AttributionQuerySchema.parse(query)
    const weekDay = (await loadActiveMetrics(this.prisma, request.ctx.tenantId)).rules.config.weekStart.day
    const current = bucketBounds(parsed.date, parsed.granularity, weekDay)
    const previous = previousBucket(parsed.date, parsed.granularity, weekDay)
    const [after, before] = await Promise.all([totalValues(this.prisma, request.ctx, current.from, current.to), totalValues(this.prisma, request.ctx, previous.from, previous.to)])
    const { mode, factors, unavailable } = attributionFactors(after.values, before.values)
    const profitBridge = !request.canSeeProfit ? { state: 'RESTRICTED' as const, note: '需要“利润”字段权限才能查看利润桥' } : { state: 'NOT_CONNECTED' as const, note: PROFIT_BRIDGE_NOTE }
    return {
      granularity: parsed.granularity,
      current,
      previous,
      state: after.hasRows || before.hasRows ? 'OK' : 'NO_DATA',
      sales: { before: before.values.sales, after: after.values.sales },
      mode,
      factors,
      unavailable,
      profitBridge,
    }
  }
}
