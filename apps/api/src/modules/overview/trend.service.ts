import { Injectable } from '@nestjs/common'
import { TrendQuerySchema, type DashState, type TrendEvent, type TrendMetric, type TrendPoint, type TrendResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { PrismaService } from '../../platform/prisma.service'
import { bucketize, type DayValues } from './aggregate'
import { NOTE_ADS, NOTE_FORBIDDEN, NOTE_NO_SALES, NOTE_PROFIT } from './kpi-cards'
import { OverviewContextService, type OverviewRequest } from './overview-context.service'
import { addDays, asDate, eachDay, localDate } from './period'
import { dailyValues } from './summary-queries'

const PICK: Record<TrendMetric, (day: DayValues) => number | null> = {
  sales: day => day.sales,
  orders: day => day.orders,
  units: day => day.units,
  profit: day => day.profit,
  adsSpend: day => day.adsSpend,
}
/** 已接入的业务指标：没有记录的日子按 0 计；其余（利润、广告）没有就是没有。 */
const CONNECTED: ReadonlySet<TrendMetric> = new Set(['sales', 'orders', 'units'])
const EVENT_LIMIT = 200

const seriesOf = (days: readonly string[], byDate: ReadonlyMap<string, DayValues>, metric: TrendMetric): Array<number | null> =>
  days.map(date => {
    const row = byDate.get(date)
    return row ? PICK[metric](row) : CONNECTED.has(metric) ? 0 : null
  })

const dataState = (metric: TrendMetric, values: ReadonlyArray<number | null>, hasRows: boolean, canSeeProfit: boolean): { state: DashState; note: string | null } => {
  if (metric === 'profit' && !canSeeProfit) return { state: 'RESTRICTED', note: NOTE_FORBIDDEN }
  if (CONNECTED.has(metric)) return hasRows ? { state: 'OK', note: null } : { state: 'NO_DATA', note: NOTE_NO_SALES }
  if (values.every(value => value === null)) return { state: 'NOT_CONNECTED', note: metric === 'profit' ? NOTE_PROFIT : NOTE_ADS }
  return { state: 'OK', note: null }
}

// 经营控制台：销售与利润双轴趋势（04 章 4.1 第 3 项）。日、周、月三种粒度；环比、同比按位置对齐到本期的桶；事件标注来自事件时间线。
@Injectable()
export class TrendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly base: OverviewContextService,
  ) {}

  private async events(request: OverviewRequest): Promise<TrendEvent[]> {
    const { period } = request.periods
    const { scope, ctx } = request
    // 事件时间是 UTC 时刻，企业时区的日期可能与 UTC 日相差一天，查询范围两端各放宽一天后再按企业时区落日
    const rows = await this.prisma.entityEvent.findMany({
      where: {
        tenantId: ctx.tenantId,
        entityType: { not: 'WORK_ITEM' },
        occurredAt: { gte: asDate(addDays(period.from, -1)), lt: asDate(addDays(period.to, 2)) },
        ...(scope.unrestricted ? {} : { OR: [{ sellerAccountId: null }, { sellerAccountId: { in: scope.sellerAccountIds } }] }),
      },
      select: { occurredAt: true, title: true, kind: true },
      orderBy: { occurredAt: 'asc' },
      take: EVENT_LIMIT,
    })
    return rows.map(row => ({ date: localDate(row.occurredAt, request.timeZone), label: row.title, kind: row.kind })).filter(event => event.date >= period.from && event.date <= period.to)
  }

  async trend(req: RequestWithContext, query: Record<string, string>): Promise<TrendResponse> {
    const request = await this.base.prepare(req, query)
    const parsed = TrendQuerySchema.parse(query)
    const { period, compare, previous, yoy } = request.periods
    const days = eachDay(period.from, period.to)
    // 一周从哪天开始由企业的业务口径决定（P6-31）
    const weekDay = (await loadActiveMetrics(this.prisma, request.ctx.tenantId)).rules.config.weekStart.day
    const [current, before, last, events] = await Promise.all([
      dailyValues(this.prisma, request.ctx, period.from, period.to),
      dailyValues(this.prisma, request.ctx, previous.from, previous.to),
      dailyValues(this.prisma, request.ctx, yoy.from, yoy.to),
      this.events(request),
    ])
    const values = seriesOf(days, current, parsed.metric)
    const status = dataState(parsed.metric, values, current.size > 0, request.canSeeProfit)
    const line = (range: { from: string; to: string }, byDate: ReadonlyMap<string, DayValues>): TrendPoint[] | null => {
      // 另一个期按位置对齐：第 i 天对第 i 天；该期没有任何汇总行时不画线（不是一条 0 线）
      if (byDate.size === 0) return null
      const other = eachDay(range.from, range.to)
      return bucketize(
        days,
        days.map((_, index) => (index < other.length ? seriesOf([other[index]!], byDate, parsed.metric)[0]! : null)),
        parsed.granularity,
        weekDay,
      )
    }

    // 双轴：主指标是销售额时叠加净利润
    const wantProfit = parsed.metric === 'sales'
    const profitValues = seriesOf(days, current, 'profit')
    const profitStatus = dataState('profit', profitValues, current.size > 0, request.canSeeProfit)
    return {
      period,
      compare,
      granularity: parsed.granularity,
      metric: parsed.metric,
      state: status.state,
      note: status.note,
      unit: parsed.metric === 'orders' || parsed.metric === 'units' ? 'number' : 'money',
      points: status.state === 'OK' ? bucketize(days, values, parsed.granularity, weekDay) : [],
      previous: status.state === 'OK' ? line(previous, before) : null,
      yoy: status.state === 'OK' ? line(yoy, last) : null,
      profit:
        wantProfit && profitStatus.state === 'OK'
          ? { state: 'OK', note: null, points: bucketize(days, profitValues, parsed.granularity, weekDay) }
          : wantProfit
            ? { state: profitStatus.state, note: profitStatus.note, points: null }
            : { state: 'NO_DATA', note: null, points: null },
      events,
    }
  }
}
