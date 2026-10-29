import { Injectable } from '@nestjs/common'
import { BR_DEVICE_SPLIT_NOTE, type BrSummaryResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { eachDay } from '../overview'
import { BusinessReportsAccessService } from './business-reports-access.service'
import { loadAdsSales, loadDailyRows } from './business-reports-load'
import { attributionOf, cardsOf, coverageOf, figuresOf, funnelOf, pointsOf, preferredRows, splitOf } from './business-reports-math'

// 销售仪表盘（P4-02，04 章 4.5 第 1 个页签）：指标卡（带对比期变化）、逐日趋势（叠加对比期）、转化漏斗、指标树归因、自然销售与广告销售拆分。
// 官方没给的值是空，不当 0；没有选对比期就不算变化与归因；没选日期范围默认最近 30 天并对比上一期。
@Injectable()
export class BusinessReportsSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
  ) {}

  async summary(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BrSummaryResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const { period, compare } = access.periods
    const range = { from: period.from, to: period.to, days: period.days, defaulted: access.periods.defaulted }
    const [current, previous, adsSales] = await Promise.all([
      loadDailyRows(this.prisma, access.tenantId, access.scope, 'DAY', period.from, period.to),
      compare ? loadDailyRows(this.prisma, access.tenantId, access.scope, 'DAY', compare.from, compare.to) : Promise.resolve(null),
      loadAdsSales(this.prisma, access.tenantId, access.scope, period.from, period.to),
    ])
    const rows = preferredRows(current.rows)
    const trend = pointsOf(rows, eachDay(period.from, period.to))
    const figures = figuresOf(rows)
    const compareRows = previous ? preferredRows(previous.rows) : null
    const compareFigures = compareRows ? figuresOf(compareRows) : null
    const withData = trend.filter(point => point.source !== null)
    const header = await this.access.header(
      access,
      { range, hasData: withData.length > 0, truncated: current.truncated || (previous?.truncated ?? false), latestDate: withData.length > 0 ? withData[withData.length - 1]!.date : null },
      now,
    )
    const { attribution, note } = attributionOf(figures, compareFigures)
    return {
      ...header,
      compare,
      coverage: coverageOf(trend),
      cards: cardsOf(figures, compareFigures),
      deviceSplit: { state: 'NOT_CONNECTED', note: BR_DEVICE_SPLIT_NOTE },
      trend,
      compareTrend: compare && compareRows ? pointsOf(compareRows, eachDay(compare.from, compare.to)) : null,
      funnel: funnelOf(figures),
      attribution,
      attributionNote: note,
      split: splitOf(figures.orderedSales, adsSales),
    }
  }
}
