import { Injectable } from '@nestjs/common'
import { ScopeSearchSchema, type Asin360DailyPoint, type Asin360OverviewResponse } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { asDate, dateText, eachDay, resolvePeriods, todayIn, validZone } from '../overview'
import { ProductAccessService, type ResolvedProduct } from './product-access.service'
import { buildAttribution, buildCards, buildProfit, buildSplit, buildTable, NOTE_REFUNDS, sumProductDays, type ProductDay } from './product-overview-math'

const MAX_ROWS = 1200
const num = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))

export interface ProductWindow {
  byDate: Map<string, ProductDay>
  total: ProductDay
  has: boolean
  currency: string | null
  metricVersion: string | null
  refreshedAt: Date | null
}

@Injectable()
export class ProductOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  /** 一个时间窗内这个商品的日汇总（店铺 × ASIN × 日，所有 SKU 共用一行）。 */
  async loadWindow(product: ResolvedProduct, from: string, to: string): Promise<ProductWindow> {
    const rows = await this.prisma.asinDailySummary.findMany({
      where: { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, asin: product.asin, summaryDate: { gte: asDate(from), lte: asDate(to) } },
      select: { summaryDate: true, units: true, salesAmount: true, sessions: true, adsSpend: true, adsSales: true, profit: true, currency: true, metricVersion: true, refreshedAt: true },
      orderBy: { summaryDate: 'asc' },
      take: MAX_ROWS,
    })
    const byDate = new Map<string, ProductDay>()
    for (const row of rows) {
      byDate.set(dateText(row.summaryDate), {
        units: row.units,
        sales: Number(row.salesAmount.toString()),
        sessions: row.sessions,
        adsSpend: num(row.adsSpend),
        adsSales: num(row.adsSales),
        profit: num(row.profit),
      })
    }
    const last = rows.at(-1)
    return {
      byDate,
      total: sumProductDays([...byDate.values()]),
      has: rows.length > 0,
      currency: last?.currency ?? null,
      metricVersion: last?.metricVersion ?? null,
      refreshedAt: rows.reduce<Date | null>((max, row) => (!max || row.refreshedAt > max ? row.refreshedAt : max), null),
    }
  }

  async overview(req: RequestWithContext, id: string, query: Record<string, string>): Promise<Asin360OverviewResponse> {
    const { context, product } = await this.access.resolve(req, id)
    const dates = ScopeSearchSchema.parse(query)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const periods = resolvePeriods(dates, todayIn(validZone(tenant?.timezone)))
    const canSeeProfit = canSeeField(context.permissions, 'profit')

    const { period, compare, previous, yoy } = periods
    const [current, before, lastYear, custom] = await Promise.all([
      this.loadWindow(product, period.from, period.to),
      this.loadWindow(product, previous.from, previous.to),
      this.loadWindow(product, yoy.from, yoy.to),
      compare?.mode === 'custom' ? this.loadWindow(product, compare.from, compare.to) : Promise.resolve(null),
    ])
    const compareWindow = !compare ? null : compare.mode === 'previous' ? before : compare.mode === 'yoy' ? lastYear : custom

    const days = eachDay(period.from, period.to)
    const daily: Asin360DailyPoint[] = days.map(date => {
      const day = current.byDate.get(date)
      return { date, units: day?.units ?? 0, sales: day?.sales ?? 0, profit: canSeeProfit ? (day?.profit ?? null) : null, adsSales: day?.adsSales ?? null, sessions: day?.sessions ?? null }
    })
    const compareSales =
      compareWindow && compare
        ? eachDay(compare.from, compare.to)
            .slice(0, days.length)
            .map(date => compareWindow.byDate.get(date)?.sales ?? null)
        : []

    return {
      period,
      compare,
      previous,
      yoy,
      defaulted: periods.defaulted,
      currency: current.currency ?? product.currency,
      metricVersion: current.metricVersion,
      refreshedAt: current.refreshedAt?.toISOString() ?? null,
      hasRows: current.has,
      cards: buildCards({ current: current.total, hasCurrent: current.has, compare: compareWindow?.total ?? null, hasCompare: compareWindow?.has ?? false, canSeeProfit }),
      daily,
      compareSales,
      table: buildTable({ value: current.total, has: current.has }, { value: before.total, has: before.has }, { value: lastYear.total, has: lastYear.has }),
      attribution: buildAttribution(current.total, compareWindow?.total ?? null, current.has && (compareWindow?.has ?? false)),
      split: buildSplit(current.total, current.has),
      profit: buildProfit(daily, canSeeProfit),
      refunds: { state: 'NOT_CONNECTED', note: NOTE_REFUNDS },
    }
  }
}
