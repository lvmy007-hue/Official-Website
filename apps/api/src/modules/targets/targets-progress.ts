import { TARGET_SEASONAL_LOOKBACK_YEARS, type TargetDimension, type TargetMetric, type TargetPaceMode, type TargetPeriodKind, type TargetProgress } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { PrismaService } from '../../platform/prisma.service'
import { achievementRatioOf, elapsedDaysOf, forecastOf, linearRatio, periodEndExclusive, seasonalRatio, totalDaysOf } from './targets-math'

// 目标达成进度与预测达成的数据库取数（P2a-04，freeze/metrics.md M-013、M-014）。
// 纯计算部分见 targets-math.ts；这里只负责把汇总表的数字喂给它。

const RECENT_WINDOW_DAYS = 7

type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const dateText = (value: Date) => value.toISOString().slice(0, 10)

type StoreRow = { summaryDate: Date; salesAmount: Dec; orders: number; units: number; profit: Dec; adsSpend: Dec }
type AsinRow = { summaryDate: Date; salesAmount: Dec; units: number; profit: Dec; adsSpend: Dec }

function storeMetricValue(row: StoreRow, metric: TargetMetric): number | null {
  if (metric === 'SALES') return num(row.salesAmount)
  if (metric === 'ORDERS') return row.orders
  if (metric === 'UNITS') return row.units
  if (metric === 'PROFIT') return num(row.profit)
  return num(row.adsSpend) // ADS_SPEND
}

function asinMetricValue(row: AsinRow, metric: TargetMetric): number | null {
  if (metric === 'SALES') return num(row.salesAmount)
  if (metric === 'UNITS') return row.units
  if (metric === 'PROFIT') return num(row.profit)
  if (metric === 'ADS_SPEND') return num(row.adsSpend)
  return null // ORDERS：ASIN 日汇总没有订单数字段
}

const NULLABLE_METRICS: ReadonlySet<TargetMetric> = new Set(['PROFIT', 'ADS_SPEND'])
const NOTE_CATEGORY = '类目目标的实际值依赖商品类目数据，随 P2a-14 商品目录同步器接入后计算'
const NOTE_ASIN_ORDERS = 'ASIN 维度的日汇总没有订单数字段，只支持销售额、件数、利润、广告花费'
const NOTE_PROFIT = '净利润来自利润日表，随 P2b-09 接入后计算'
const NOTE_ADS = '广告花费数据同步在阶段 3 交付，目前尚未接入'
const NOTE_RESTRICTED = '需要“利润”字段权限（财务相关角色）才能查看'
const NOTE_FALLBACK = '所选历史季节曲线数据不足（需近 2 年同月且有销售记录），本次按天均摊计算'
const NOTE_NO_PACE = '该周期粒度暂不支持节奏线与预测，只按整期合计计算达成率'

/** 一个店铺 × 日期范围内，某个维度 + 指标的逐日序列；metric 在该维度下不可用，或数据全部“尚未接入”时返回 null。 */
async function dailySeries(
  prisma: PrismaService,
  tenantId: string,
  sellerAccountId: string,
  dimension: TargetDimension,
  dimensionRef: string,
  metric: TargetMetric,
  from: Date,
  toExclusive: Date,
): Promise<Map<string, number> | null> {
  if (dimension === 'CATEGORY') return null
  if (dimension === 'ASIN' && metric === 'ORDERS') return null
  const where = { tenantId, sellerAccountId, summaryDate: { gte: from, lt: toExclusive } }
  const map = new Map<string, number>()
  let anyNonNull = false
  if (dimension === 'STORE') {
    const rows = await prisma.storeDailySummary.findMany({ where, select: { summaryDate: true, salesAmount: true, orders: true, units: true, profit: true, adsSpend: true } })
    for (const row of rows) {
      const value = storeMetricValue(row, metric)
      if (value !== null) {
        anyNonNull = true
        map.set(dateText(row.summaryDate), value)
      }
    }
  } else {
    const asins = dimensionRef.split(',').filter(Boolean)
    if (asins.length === 0) return null
    const rows = await prisma.asinDailySummary.findMany({ where: { ...where, asin: { in: asins } }, select: { summaryDate: true, salesAmount: true, units: true, profit: true, adsSpend: true } })
    for (const row of rows) {
      const value = asinMetricValue(row, metric)
      if (value === null) continue
      anyNonNull = true
      const key = dateText(row.summaryDate)
      map.set(key, (map.get(key) ?? 0) + value)
    }
  }
  // 简化：是否“接入”按当前查询范围内有没有非空值判断；范围为空（期间尚未开始，elapsed=0）时会判成未接入。
  // 目前 PROFIT / ADS_SPEND 本来就全局未接入（P2b-09 / 阶段 3 未交付），不影响现状；待它们上线后如需要可改成查最近一行判断。
  if (NULLABLE_METRICS.has(metric) && !anyNonNull) return null
  return map
}

function notConnectedNote(dimension: TargetDimension, metric: TargetMetric): string {
  if (dimension === 'CATEGORY') return NOTE_CATEGORY
  if (dimension === 'ASIN' && metric === 'ORDERS') return NOTE_ASIN_ORDERS
  if (metric === 'PROFIT') return NOTE_PROFIT
  return NOTE_ADS
}

/** 近 N 年同月的逐日数组（按当月天数对齐，缺失的日子记为 0），用于历史季节曲线；取不到数据的年份不在结果里。 */
async function historicalMonths(
  prisma: PrismaService,
  tenantId: string,
  sellerAccountId: string,
  dimension: TargetDimension,
  dimensionRef: string,
  metric: TargetMetric,
  periodStart: string,
  totalDays: number,
): Promise<number[][]> {
  const [year, month] = periodStart.split('-').map(Number)
  const months: number[][] = []
  for (let back = 1; back <= TARGET_SEASONAL_LOOKBACK_YEARS; back += 1) {
    const histStart = `${year - back}-${String(month).padStart(2, '0')}-01`
    if (totalDaysOf('MONTH', histStart) !== totalDays) continue
    const from = new Date(`${histStart}T00:00:00Z`)
    const toExclusive = periodEndExclusive('MONTH', histStart)
    const series = await dailySeries(prisma, tenantId, sellerAccountId, dimension, dimensionRef, metric, from, toExclusive)
    if (!series) continue
    months.push(Array.from({ length: totalDays }, (_, day) => series.get(dateText(new Date(from.getTime() + day * 86_400_000))) ?? 0))
  }
  return months
}

export interface ProgressInput {
  tenantId: string
  sellerAccountId: string
  dimension: TargetDimension
  dimensionRef: string
  metric: TargetMetric
  periodKind: TargetPeriodKind
  periodStart: string
  asOf: string
  targetValue: number | null
  paceMode: TargetPaceMode
  permissions: readonly string[]
}

const NOT_SET: TargetProgress = {
  state: 'NOT_SET',
  note: '尚未设置目标',
  asOf: null,
  actualToDate: null,
  expectedToDate: null,
  achievementRatio: null,
  elapsedDays: null,
  totalDays: null,
  paceFallback: false,
  forecast: null,
}

export async function computeProgress(prisma: PrismaService, input: ProgressInput): Promise<TargetProgress> {
  if (input.targetValue === null) return NOT_SET
  if (input.metric === 'PROFIT' && !canSeeField(input.permissions, 'profit')) {
    return { ...NOT_SET, state: 'RESTRICTED', note: NOTE_RESTRICTED }
  }
  const totalDays = totalDaysOf(input.periodKind, input.periodStart)
  const elapsed = elapsedDaysOf(input.periodKind, input.periodStart, input.asOf)
  const from = new Date(`${input.periodStart}T00:00:00Z`)
  // elapsedDaysOf 已把 elapsed 裁剪到 [0, totalDays]，所以 asOf 对应的结束时刻一定不晚于期末
  const asOfExclusive = new Date(from.getTime() + elapsed * 86_400_000)
  const series = await dailySeries(prisma, input.tenantId, input.sellerAccountId, input.dimension, input.dimensionRef, input.metric, from, asOfExclusive)
  if (series === null) return { ...NOT_SET, state: 'NOT_CONNECTED', note: notConnectedNote(input.dimension, input.metric) }

  const actualToDate = [...series.values()].reduce((sum, v) => sum + v, 0)
  const supportsPace = input.periodKind === 'MONTH'
  let expectedToDate: number | null = null
  let paceFallback = false
  if (supportsPace) {
    let ratio = linearRatio(elapsed, totalDays)
    if (input.paceMode === 'SEASONAL') {
      const months = await historicalMonths(prisma, input.tenantId, input.sellerAccountId, input.dimension, input.dimensionRef, input.metric, input.periodStart, totalDays)
      const seasonal = seasonalRatio(months, elapsed, totalDays)
      if (seasonal !== null) ratio = seasonal
      else paceFallback = true
    }
    expectedToDate = input.targetValue * ratio
  }

  const recentDaily: number[] = []
  for (let day = Math.max(0, elapsed - RECENT_WINDOW_DAYS); day < elapsed; day += 1) {
    const key = dateText(new Date(from.getTime() + day * 86_400_000))
    recentDaily.push(series.get(key) ?? 0)
  }
  const remainingDays = totalDays - elapsed
  const forecast = supportsPace ? forecastOf(actualToDate, remainingDays, recentDaily, input.targetValue) : null

  return {
    state: 'OK',
    note: !supportsPace ? NOTE_NO_PACE : paceFallback ? NOTE_FALLBACK : null,
    asOf: input.asOf,
    actualToDate,
    expectedToDate,
    achievementRatio: achievementRatioOf(actualToDate, input.targetValue),
    elapsedDays: elapsed,
    totalDays,
    paceFallback,
    forecast,
  }
}
