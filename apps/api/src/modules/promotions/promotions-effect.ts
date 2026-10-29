import {
  PROMOTION_BASELINE_DAYS,
  PROMOTION_BASELINE_MIN_DAYS,
  PROMOTION_NO_EFFECT_STATUSES,
  baselineExpectation,
  baselineRange,
  promoIncrementOf,
  promoOverlaps,
  type BaselineDay,
  type PromotionDay,
  type PromotionEffectSection,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { addDays, asDate, dateText, eachDay, localDate, zonedDayStart } from '../overview'
import { gateOf, PARTIAL_NOTE, type DetailContext } from './promotions-context'
import { num } from './promotions-common'

// 促销效果页签（D-06 基线法）：活动期间实际销量与销售额，对比“活动前 28 天里没被其他促销占用的日子、按星期对齐”的日均。
// 销量销售额取每日 ASIN 汇总（只含促销所选商品，美元）；一天“有数据”指这个店铺这一天有任意 ASIN 汇总行，没有就是没数据（不当 0）。
// 同期有其他促销（按目录选品的、商品清单没同步的、或商品有交集的）的日子一律不进基线，宁可有效日不足也不拿被污染的日子凑数。

export interface BaselinePlan {
  range: { from: string; to: string }
  windowDates: string[]
  /** 有数据的日期（基线期 + 活动期间）。 */
  covered: Set<string>
  /** 被同期其他促销占用的日期（基线期）。 */
  excluded: Set<string>
  units: Map<string, number>
  sales: Map<string, number>
}

const nullableSum = (values: ReadonlyArray<number | null>): number | null => {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : Math.round(present.reduce((sum, value) => sum + value, 0) * 100) / 100
}

export async function loadPlan(prisma: PrismaService, ctx: DetailContext, window: { from: string; to: string }): Promise<BaselinePlan> {
  const range = baselineRange(window.from, PROMOTION_BASELINE_DAYS)
  const { tenantId, row } = ctx
  const dates = { gte: asDate(range.from), lte: asDate(window.to) }
  const [summaries, coveredRows, others] = await Promise.all([
    prisma.asinDailySummary.groupBy({
      by: ['summaryDate'],
      where: { tenantId, sellerAccountId: row.sellerAccountId, asin: { in: ctx.asins }, currency: 'USD', summaryDate: dates },
      _sum: { units: true, salesAmount: true },
      orderBy: { summaryDate: 'asc' },
      take: 1000,
    }),
    prisma.asinDailySummary.groupBy({
      by: ['summaryDate'],
      where: { tenantId, sellerAccountId: row.sellerAccountId, currency: 'USD', summaryDate: dates },
      orderBy: { summaryDate: 'asc' },
      take: 1000,
    }),
    prisma.promotion.findMany({
      where: {
        tenantId,
        sellerAccountId: row.sellerAccountId,
        id: { not: row.id },
        status: { notIn: [...PROMOTION_NO_EFFECT_STATUSES] },
        startAt: { lt: zonedDayStart(addDays(range.to, 1), ctx.zone) },
        AND: [
          { OR: [{ endAt: null }, { endAt: { gte: zonedDayStart(range.from, ctx.zone) } }] },
          // 按目录选品、没有商品选择、商品清单还没同步的促销无法排除，一律视为与本促销有交集
          { OR: [{ selectionType: { not: 'ITEMS' } }, { selectionType: null }, { itemCount: null }, { items: { some: { asin: { in: ctx.asins } } } }] },
        ],
      },
      select: { startAt: true, endAt: true },
      take: 500,
    }),
  ])
  const covered = new Set(coveredRows.map(item => dateText(item.summaryDate)))
  const baselineDates = eachDay(range.from, range.to)
  const spans = others.map(item => ({ from: localDate(item.startAt, ctx.zone), to: item.endAt ? localDate(item.endAt, ctx.zone) : null }))
  const excluded = new Set(baselineDates.filter(date => spans.some(span => promoOverlaps({ from: date, to: date }, span))))
  return {
    range,
    windowDates: eachDay(window.from, window.to),
    covered,
    excluded,
    units: new Map(summaries.map(item => [dateText(item.summaryDate), item._sum.units ?? 0])),
    sales: new Map(summaries.map(item => [dateText(item.summaryDate), num(item._sum.salesAmount) ?? 0])),
  }
}

/** 基线期每一天的取值（没数据为 null）与是否被占用。 */
export const baselineDaysOf = (plan: BaselinePlan, value: (date: string) => number | null): BaselineDay[] =>
  eachDay(plan.range.from, plan.range.to).map(date => ({ date, value: plan.covered.has(date) ? value(date) : null, excluded: plan.excluded.has(date) }))

export interface ReportedDaily {
  state: 'OK' | 'NO_RECORD' | 'NOT_CONNECTED'
  units: number | null
  sales: number | null
  redemptions: number | null
  clips: number | null
  budgetSpent: number | null
  byDate: Map<string, { units: number | null; sales: number | null }>
}

/** 绩效报告里这个促销（按映射编号）的逐日数据；没有映射编号、报告没接入或没有行时不给数字。 */
export async function reportedDaily(prisma: PrismaService, ctx: DetailContext): Promise<ReportedDaily> {
  const { row } = ctx
  const coupon = row.promotionType === 'COUPON'
  const empty = (state: ReportedDaily['state']): ReportedDaily => ({ state, units: null, sales: null, redemptions: null, clips: null, budgetSpent: null, byDate: new Map() })
  const missing = (coupon ? ctx.reportConnected.coupon : ctx.reportConnected.promotion) ? 'NO_RECORD' : 'NOT_CONNECTED'
  if (!row.mappingId) return empty('NO_RECORD')
  const where = { tenantId: ctx.tenantId, sellerAccountId: row.sellerAccountId, mappingId: row.mappingId, currency: 'USD' }
  if (coupon) {
    const rows = await prisma.couponMetric.groupBy({ by: ['metricDate'], where, _sum: { clips: true, redemptions: true, budgetSpent: true, sales: true }, orderBy: { metricDate: 'asc' }, take: 1000 })
    if (rows.length === 0) return empty(missing)
    return {
      state: 'OK',
      units: null,
      sales: nullableSum(rows.map(item => num(item._sum.sales))),
      redemptions: nullableSum(rows.map(item => item._sum.redemptions)),
      clips: nullableSum(rows.map(item => item._sum.clips)),
      budgetSpent: nullableSum(rows.map(item => num(item._sum.budgetSpent))),
      byDate: new Map(rows.map(item => [dateText(item.metricDate), { units: null, sales: num(item._sum.sales) }])),
    }
  }
  const rows = await prisma.promotionMetric.groupBy({ by: ['metricDate'], where, _sum: { units: true, sales: true, redemptions: true }, orderBy: { metricDate: 'asc' }, take: 1000 })
  if (rows.length === 0) return empty(missing)
  return {
    state: 'OK',
    units: nullableSum(rows.map(item => item._sum.units)),
    sales: nullableSum(rows.map(item => num(item._sum.sales))),
    redemptions: nullableSum(rows.map(item => item._sum.redemptions)),
    clips: null,
    budgetSpent: null,
    byDate: new Map(rows.map(item => [dateText(item.metricDate), { units: item._sum.units, sales: num(item._sum.sales) }])),
  }
}

const REPORT_NOTE: Record<ReportedDaily['state'], string | null> = {
  OK: null,
  NO_RECORD: '尚无记录：绩效报告里没有这个促销的数据（报告晚于活动，或没有映射编号）',
  NOT_CONNECTED: '尚未接入：绩效报告还没有成功同步过',
}

export async function effectSection(prisma: PrismaService, ctx: DetailContext): Promise<{ section: PromotionEffectSection; plan: BaselinePlan | null }> {
  const reported = await reportedDaily(prisma, ctx)
  const none = { units: null, sales: null }
  const base = {
    reported: {
      state: reported.state,
      units: reported.units,
      sales: reported.sales,
      redemptions: reported.redemptions,
      clips: reported.clips,
      budgetSpent: reported.budgetSpent,
      note: REPORT_NOTE[reported.state],
    },
    baseline: { state: 'NONE' as const, usedDays: 0, excludedDays: 0, from: null, to: null },
    actual: none,
    expected: none,
    incremental: { units: null, sales: null, liftPct: null },
    daily: [] as PromotionDay[],
    window: ctx.window,
  }
  const gate = gateOf(ctx)
  if (gate || !ctx.window) return { section: { ...base, state: gate?.state ?? 'NOT_STARTED', note: gate?.note ?? null }, plan: null }
  const plan = await loadPlan(prisma, ctx, ctx.window)
  const dates = plan.windowDates.filter(date => plan.covered.has(date))
  const unitsBase = baselineExpectation(
    baselineDaysOf(plan, date => plan.units.get(date) ?? 0),
    dates,
    PROMOTION_BASELINE_MIN_DAYS,
  )
  const salesBase = baselineExpectation(
    baselineDaysOf(plan, date => plan.sales.get(date) ?? 0),
    dates,
    PROMOTION_BASELINE_MIN_DAYS,
  )
  const baseline = { ...unitsBase.info, from: plan.range.from, to: plan.range.to }
  const actualUnits = dates.length ? dates.reduce((sum, date) => sum + (plan.units.get(date) ?? 0), 0) : null
  const actualSales = dates.length ? Math.round(dates.reduce((sum, date) => sum + (plan.sales.get(date) ?? 0), 0) * 100) / 100 : null
  const expectedUnits = unitsBase.total
  const expectedSales = salesBase.total === null ? null : Math.round(salesBase.total * 100) / 100
  const unitsIncrement = promoIncrementOf(actualUnits, expectedUnits)
  const salesIncrement = promoIncrementOf(actualSales, expectedSales)
  const daily = plan.windowDates.map((date): PromotionDay => {
    const has = plan.covered.has(date)
    const report = reported.byDate.get(date)
    return {
      date,
      actualUnits: has ? (plan.units.get(date) ?? 0) : null,
      actualSales: has ? (plan.sales.get(date) ?? 0) : null,
      baselineUnits: unitsBase.perDate.get(date) ?? null,
      baselineSales: salesBase.perDate.get(date) ?? null,
      reportedUnits: report?.units ?? null,
      reportedSales: report?.sales ?? null,
    }
  })
  const notes = [
    dates.length === 0 ? '尚无记录：活动期间还没有销售汇总数据' : null,
    dates.length > 0 && dates.length < plan.windowDates.length ? `活动期间有 ${plan.windowDates.length - dates.length} 天还没有销售汇总，不计入实际与基线` : null,
    baseline.state === 'INSUFFICIENT'
      ? `基线有效日只有 ${baseline.usedDays} 天（不足 ${PROMOTION_BASELINE_MIN_DAYS} 天；${baseline.excludedDays} 天被同期其他促销占用或没有数据），不给增量估算`
      : null,
    baseline.state === 'NONE' ? `基线期没有可用的日子（${baseline.excludedDays} 天被同期其他促销占用或没有数据），不给增量估算` : null,
    ctx.asinsPartial ? PARTIAL_NOTE : null,
  ].filter((note): note is string => note !== null)
  const state = dates.length === 0 ? 'NO_DATA' : baseline.state === 'OK' ? 'OK' : 'INSUFFICIENT'
  return {
    section: {
      ...base,
      state,
      note: notes.length ? notes.join('；') : null,
      baseline,
      actual: { units: actualUnits, sales: actualSales },
      expected: { units: expectedUnits === null ? null : Math.round(expectedUnits * 100) / 100, sales: expectedSales },
      incremental: {
        units: unitsIncrement.value === null ? null : Math.round(unitsIncrement.value * 100) / 100,
        sales: salesIncrement.value,
        liftPct: salesIncrement.liftPct === null ? null : Math.round(salesIncrement.liftPct * 10) / 10,
      },
      daily,
    },
    plan,
  }
}
