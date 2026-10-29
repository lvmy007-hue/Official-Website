import {
  addTotals,
  adsAttribution,
  buildHourlyCells,
  ratiosOf,
  type AdsAttributionSection,
  type AdsEntityHourlyResponse,
  type AdsEntityMetricsBlock,
  type AdsEntityTrendResponse,
  type AdsTotals,
  type AdsTrendPointDay,
  type DashCompare,
  type DashPeriod,
} from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere } from '../auth'
import { eachDay } from '../overview'
import { num } from './ads-campaigns-common'
import { entityDaily, entityEverHadMetrics, type MetricRef } from './ads-campaigns-load'
import type { AdsLoadContext } from './ads-overview-load'
import { adsStreamSinkConfigured } from './ads-today.service'

// 广告组与投放对象共用的“指标块、趋势、分时”（P3-08）。指标读指标表（AdsMetric，对象类型 AD_GROUP、TARGET、KEYWORD），不折算币种；
// 没有指标行的日期保持为空，不补 0；区分“同步器尚未接入”（这个对象从没出现过指标行）与“所选范围没有记录”。

const HISTORY_DAYS = 28

export interface EntityKey {
  ref: MetricRef
  entityTypes: readonly string[]
  entityId: string
  /** 页面上怎么称呼这个对象（“广告组”“投放对象”），写进说明里。 */
  label: string
}

const noteNever = (label: string) => `这个${label}还没有任何指标记录（需要广告报表按“${label}”粒度的报告）；同步后才会出现`
const noteEmpty = (label: string) => `所选日期范围内这个${label}没有指标记录`
const NOTE_AMAZON_EVENTS = '亚马逊侧的出价、状态变更没有同步器（需要广告变更历史接口），趋势图上不标注外部改动'
const noteStreamOff = '营销数据流尚未配置（没有设置数据流接收端），没有分时数据；配置并开始接收后才会出现'
const noteStreamEmpty = (label: string) => `近 ${HISTORY_DAYS} 天没有这个${label}的分时记录（数据流只在配置之后才开始累积，不会补历史；活动级之外的粒度取决于数据流给的对象编号）`
const NOTE_REPORT_HOURS = '分时只来自营销数据流；亚马逊的小时级广告报告（用于核对与补缺）没有同步器'

const pointOf = (date: string, totals: AdsTotals | undefined): AdsTrendPointDay => ({
  date,
  impressions: totals?.impressions ?? null,
  clicks: totals?.clicks ?? null,
  spend: totals?.spend ?? null,
  sales: totals?.sales ?? null,
  orders: totals?.orders ?? null,
})

export function trendAttribution(
  current: AdsTotals | null,
  previous: AdsTotals | null,
  hasCompare: boolean,
  state: AdsEntityTrendResponse['state'],
  note: string | null,
  label: string,
): AdsAttributionSection {
  if (state !== 'OK' || !current) return { state, note, spend: null, sales: null }
  if (!hasCompare) return { state: 'NO_DATA', note: '没有选择对比期，无法拆解变化', spend: null, sales: null }
  if (!previous) return { state: 'NO_DATA', note: `对比期这个${label}没有指标记录，无法拆解变化`, spend: null, sales: null }
  const result = adsAttribution(current, previous)
  return { state: result.spend || result.sales ? 'OK' : 'NO_DATA', note: result.note, spend: result.spend, sales: result.sales }
}

async function loadPeriods(prisma: PrismaService, ctx: AdsLoadContext, key: EntityKey, period: DashPeriod, compare: DashCompare | null) {
  const input = { ref: key.ref, entityTypes: key.entityTypes, entityId: key.entityId }
  const [byDate, previousByDate, everHad] = await Promise.all([
    entityDaily(prisma, ctx, { ...input, from: period.from, to: period.to }),
    compare ? entityDaily(prisma, ctx, { ...input, from: compare.from, to: compare.to }) : Promise.resolve(new Map<string, AdsTotals>()),
    entityEverHadMetrics(prisma, ctx, { adsProfileId: key.ref.adsProfileId, entityTypes: key.entityTypes, entityId: key.entityId }),
  ])
  const state = byDate.size > 0 ? ('OK' as const) : everHad ? ('NO_DATA' as const) : ('NOT_CONNECTED' as const)
  const note = state === 'NOT_CONNECTED' ? noteNever(key.label) : state === 'NO_DATA' ? noteEmpty(key.label) : null
  const totals = byDate.size > 0 ? addTotals([...byDate.values()]) : null
  const previous = previousByDate.size > 0 ? addTotals([...previousByDate.values()]) : null
  return { byDate, previousByDate, state, note, totals, previous }
}

/** 详情页的指标区：范围内合计、对比期合计与比率。 */
export async function entityMetricsBlock(prisma: PrismaService, ctx: AdsLoadContext, key: EntityKey, period: DashPeriod, compare: DashCompare | null): Promise<AdsEntityMetricsBlock> {
  const loaded = await loadPeriods(prisma, ctx, key, period, compare)
  return { state: loaded.state, note: loaded.note, period, compare, totals: loaded.totals, previous: loaded.previous, ratios: ratiosOf(loaded.totals), previousRatios: ratiosOf(loaded.previous) }
}

export async function entityTrend(prisma: PrismaService, ctx: AdsLoadContext, key: EntityKey, period: DashPeriod, compare: DashCompare | null): Promise<AdsEntityTrendResponse> {
  const loaded = await loadPeriods(prisma, ctx, key, period, compare)
  return {
    state: loaded.state,
    note: loaded.note,
    period,
    compare,
    currency: key.ref.currency,
    points: eachDay(period.from, period.to).map(date => pointOf(date, loaded.byDate.get(date))),
    previousPoints: compare ? eachDay(compare.from, compare.to).map(date => pointOf(date, loaded.previousByDate.get(date))) : [],
    totals: loaded.totals,
    previous: loaded.previous,
    events: [],
    amazonEvents: { state: 'NOT_CONNECTED', note: NOTE_AMAZON_EVENTS },
    attribution: trendAttribution(loaded.totals, loaded.previous, Boolean(compare), loaded.state, loaded.note, key.label),
  }
}

/** 分时表现：营销数据流的小时指标按企业时区归到“周几 × 几点”。数据流接收端没配置就不查小时表。 */
export async function entityHourly(prisma: PrismaService, ctx: AdsLoadContext, key: EntityKey, zone: string, now: Date = new Date()): Promise<AdsEntityHourlyResponse> {
  const base = { streamConnected: adsStreamSinkConfigured(), historyDays: HISTORY_DAYS, reportHours: { state: 'NOT_CONNECTED' as const, note: NOTE_REPORT_HOURS } }
  if (!base.streamConnected) return { ...base, state: 'NOT_CONNECTED', note: noteStreamOff, cells: [] }
  const rows = await prisma.adsPerformanceHourly.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...adsRelationWhere(ctx.scope),
      adsProfileId: key.ref.adsProfileId,
      entityType: { in: [...key.entityTypes] },
      entityId: key.entityId,
      currency: key.ref.currency,
      hourStart: { gte: new Date(now.getTime() - HISTORY_DAYS * 86_400_000), lte: now },
    },
    select: { hourStart: true, clicks: true, orders: true, spend: true, sales: true },
    orderBy: { hourStart: 'asc' },
    take: HISTORY_DAYS * 25 + 24,
  })
  if (rows.length === 0) return { ...base, state: 'NO_DATA', note: noteStreamEmpty(key.label), cells: [] }
  const cells = buildHourlyCells(
    rows.map(row => ({ hourStart: row.hourStart, clicks: row.clicks, orders: row.orders, spend: num(row.spend), sales: num(row.sales) })),
    zone,
  )
  return { ...base, state: 'OK', note: null, cells }
}
