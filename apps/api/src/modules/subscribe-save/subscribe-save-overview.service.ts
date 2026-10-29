import { Injectable } from '@nestjs/common'
import { SNS_BASIS, SNS_MONTHS_SHOWN, SNS_REPLENISH_NOTE, snsEmptyState, type SnsOverviewResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { loadLatestOffers, loadMetricRows } from './subscribe-save-load'
import { SubscribeSaveAccessService } from './subscribe-save-access.service'
import { buildCards, forecastTotals, latestActive, mainCurrency, monthsOf, trendOf, windowTotals } from './subscribe-save-math'

// 订阅省概览（04 章 4.9：指标卡与趋势）：卖家指标（日级与月度）与各店铺最近一次报价快照。
// 范围：日期范围内的日级指标（日级只同步最近 31 天，覆盖天数写在趋势里）；对比期只给累计类两张卡；预计订阅出货与报价数永远取“最近一次快照”，不随日期范围变。

@Injectable()
export class SubscribeSaveOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SubscribeSaveAccessService,
  ) {}

  async overview(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<SnsOverviewResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const { period, compare, defaulted } = access.periods
    const readFrom = compare && compare.from < period.from ? compare.from : period.from
    const [metrics, offers, sync] = await Promise.all([
      loadMetricRows(this.prisma, access.tenantId, access.scope, readFrom, period.to),
      loadLatestOffers(this.prisma, access.tenantId, access.scope),
      this.access.sync(access, now),
    ])
    const current = windowTotals(metrics.rows, period.from, period.to)
    const previous = compare ? windowTotals(metrics.rows, compare.from, compare.to) : null
    const forecast = forecastTotals(offers.offers, access.today)
    const monthRows = metrics.rows.filter(row => row.granularity === 'MONTH')
    // 趋势与月度图的币种：范围内金额最大的币种；范围内没有金额时取月度数据里金额最大的币种
    const trendCurrency = mainCurrency(current.revenue) ?? mainCurrency(monthRows.flatMap(row => (row.revenue !== null && row.currency ? [{ currency: row.currency, amount: row.revenue }] : [])))
    const hasData = metrics.rows.length > 0 || offers.offers.length > 0
    const empty = hasData ? null : snsEmptyState(sync.sync)
    return {
      state: empty ? empty.state : 'OK',
      note: empty ? empty.note : null,
      range: { from: period.from, to: period.to, days: period.days, defaulted },
      compare: compare ? { from: compare.from, to: compare.to, days: compare.days } : null,
      sync: sync.sync,
      cards: buildCards({ current, previous: previous && previous.dataDays > 0 ? previous : null, rangeDays: period.days, active: latestActive(metrics.rows, period.to), forecast }),
      trend: {
        currency: trendCurrency,
        points: trendOf(metrics.rows, period.from, period.to, trendCurrency),
        months: monthsOf(monthRows, trendCurrency, SNS_MONTHS_SHOWN),
        coverage: { dataDays: current.dataDays, rangeDays: period.days },
      },
      forecast: {
        snapshotDate: forecast.snapshotDate,
        offers: forecast.offers,
        offersWithForecast: forecast.offersWithForecast,
        staleStores: forecast.staleStores,
        usedInReplenishment: forecast.usedInReplenishment,
      },
      truncated: metrics.truncated || offers.truncated,
      freshness: sync.freshness,
      basis: SNS_BASIS,
      replenishNote: SNS_REPLENISH_NOTE,
    }
  }
}
