import { Injectable } from '@nestjs/common'
import {
  RETURN_ANALYSIS_BASIS,
  RETURN_ANALYSIS_ROW_CAP,
  RETURN_MATRIX_MONTHS,
  cohortWindowOpen,
  latestMonths,
  monthFirstDay,
  monthLastDay,
  monthOf,
  returnRate,
  type ReturnCohortResponse,
  type ReturnCohortRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { addDays, asDate, dateText, localDate, zonedDayStart } from '../overview'
import { ReturnsAnalysisContextService } from './returns-analysis-context'

// 队列退货率（P6-13，M-703）：按下单月看一批订单最终的退货水平，与按退货日统计的退货率（M-310）并排。
// 月份取日期范围覆盖的整月（最多 RETURN_MATRIX_MONTHS 个，取最近的）；分子分母口径一致：同一批订单的退货件数 ÷ 同一批订单月的销售件数。
// 队列退货率天然按“下单月”统计，不受时间口径切换影响，响应里的 timeBasis 固定为 order。
@Injectable()
export class ReturnsCohortService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ReturnsAnalysisContextService,
  ) {}

  async cohort(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnCohortResponse> {
    const a = await this.ctx.open(req, rawQuery, 'basis')
    const months = latestMonths(monthsBetween(a.from, a.to), RETURN_MATRIX_MONTHS)
    const first = monthFirstDay(months[0]!)
    const last = monthLastDay(months[months.length - 1]!)
    const start = zonedDayStart(first, a.zone)
    const end = zonedDayStart(addDays(last, 1), a.zone)
    const store = storeWhere(a.scope)
    const orderWhere: Prisma.FbaReturnCaseWhereInput = { ...a.base, orderPurchasedAt: { gte: start, lt: end } }
    const returnWhere: Prisma.FbaReturnCaseWhereInput = { ...a.base, returnDate: { gte: start, lt: end } }
    const [cohortRows, monthRows, soldDaily, unknown, freshness] = await Promise.all([
      this.prisma.fbaReturnCase.findMany({ where: orderWhere, select: { orderPurchasedAt: true, quantity: true }, orderBy: { orderPurchasedAt: 'desc' }, take: RETURN_ANALYSIS_ROW_CAP }),
      this.prisma.fbaReturnCase.findMany({ where: returnWhere, select: { returnDate: true, quantity: true }, orderBy: { returnDate: 'desc' }, take: RETURN_ANALYSIS_ROW_CAP }),
      this.prisma.asinDailySummary.groupBy({ by: ['summaryDate'], where: { tenantId: a.tenantId, ...store, summaryDate: { gte: asDate(first), lte: asDate(last) } }, _sum: { units: true } }),
      this.ctx.unknown({ ...returnWhere, orderPurchasedAt: null }),
      this.ctx.freshness(a.tenantId, a.scope),
    ])

    const cohort = new Map<string, number>()
    for (const row of cohortRows) {
      const month = monthOf(localDate(row.orderPurchasedAt!, a.zone))
      cohort.set(month, (cohort.get(month) ?? 0) + row.quantity)
    }
    const inMonth = new Map<string, number>()
    for (const row of monthRows) {
      const month = monthOf(localDate(row.returnDate, a.zone))
      inMonth.set(month, (inMonth.get(month) ?? 0) + row.quantity)
    }
    const sold = new Map<string, number>()
    for (const row of soldDaily) {
      const month = monthOf(dateText(row.summaryDate))
      sold.set(month, (sold.get(month) ?? 0) + (row._sum.units ?? 0))
    }
    const rows = months.map((month): ReturnCohortRow => {
      const soldUnits = sold.has(month) ? sold.get(month)! : null
      const cohortReturnedUnits = cohort.get(month) ?? 0
      const returnedInMonthUnits = inMonth.get(month) ?? 0
      return {
        month,
        soldUnits,
        cohortReturnedUnits,
        cohortRate: returnRate(cohortReturnedUnits, soldUnits),
        returnedInMonthUnits,
        returnDateRate: returnRate(returnedInMonthUnits, soldUnits),
        windowOpen: cohortWindowOpen(month, a.today),
      }
    })
    const empty = cohortRows.length === 0 && monthRows.length === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? '所选日期范围内尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）' : null,
      range: { from: a.from, to: a.to, defaulted: a.defaulted },
      timeBasis: 'order',
      unknownOrderUnits: unknown.units,
      unknownOrderRows: unknown.rows,
      basis: RETURN_ANALYSIS_BASIS.cohort,
      freshness,
      months: rows,
      truncated: cohortRows.length >= RETURN_ANALYSIS_ROW_CAP || monthRows.length >= RETURN_ANALYSIS_ROW_CAP,
    }
  }
}

/** [from, to] 覆盖的全部月份（YYYY-MM）。 */
function monthsBetween(from: string, to: string): string[] {
  const result: string[] = []
  let year = Number(from.slice(0, 4))
  let month = Number(from.slice(5, 7))
  const endKey = to.slice(0, 7)
  for (let guard = 0; guard < 600; guard += 1) {
    const key = `${year}-${String(month).padStart(2, '0')}`
    result.push(key)
    if (key >= endKey) break
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return result
}
