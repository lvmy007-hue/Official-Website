import { Injectable } from '@nestjs/common'
import {
  ADS_ANOMALY_LIST_LIMIT,
  ADS_ANOMALY_RULES,
  ADS_CONSOLE_CURRENCY,
  ADS_QUADRANT_LIMIT,
  ADS_READ,
  AdsOverviewQuerySchema,
  ScopeSearchSchema,
  adsAttribution,
  adsRatios,
  addTotals,
  budgetUtilizationOf,
  campaignAnomaly,
  quadrantOf,
  type AdsAnomalyItem,
  type AdsAnomalySection,
  type AdsAttributionSection,
  type AdsBudgetSection,
  type AdsOverviewResponse,
  type AdsQuadrantPoint,
  type AdsQuadrantSection,
  type AdsTotals,
  type DashState,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { eachDay, resolvePeriods, todayIn, validZone } from '../overview'
import { buildAdsCards, NOTE_EMPTY_RANGE, NOTE_NEVER, NOTE_NO_STORE_ROWS } from './ads-overview-cards'
import {
  adsTotals,
  budgetedCampaigns,
  campaignNames,
  campaignTotals,
  dailyByProduct,
  everHadAdsData,
  otherCurrencies,
  refreshInfo,
  storeDaily,
  storeTotals,
  trendEvents,
  unboundSpend,
  type AdsLoadContext,
  type CampaignRow,
  type StoreDay,
} from './ads-overview-load'
import { budgetDays, dailyTotals, funnelOf, mixPoints, productRows, trendPoints } from './ads-overview-series'

const NOTE_NO_CAMPAIGNS = '没有活动级的广告汇总（账户级汇总行不带活动编号）'
const NOTE_BUDGET_ESTIMATE = '估算：按活动当前的日预算回看所选范围（预算历史没有同步），只含启用中、日预算的美元活动'
const NOTE_OVER_BUDGET = '平均超预算时长需要活动管理接口的预算消耗数据（营销数据流第二版不含），该同步器尚未接入'
const NOTE_TARGET_ACOS = '目标 ACoS 还没有设置入口（随广告活动详情 P3-07 与规则 P3-13 提供），暂无法对比'

const sumStore = (days: ReadonlyMap<string, StoreDay>): { day: StoreDay; hasRows: boolean } => {
  let sales = 0
  let spend: number | null = null
  let adsSales: number | null = null
  for (const day of days.values()) {
    sales += day.sales
    if (day.adsSpend !== null) spend = (spend ?? 0) + day.adsSpend
    if (day.adsSales !== null) adsSales = (adsSales ?? 0) + day.adsSales
  }
  return { day: { sales, adsSpend: spend, adsSales }, hasRows: days.size > 0 }
}

// 广告控制台（P3-05，08 章 8.1）：读广告日汇总与店铺经营日汇总，不调亚马逊、不写库。
// 范围经 adsProfile.sellerAccountId 过滤（未绑定的广告账户只有“全部店铺”成员看得到）；日期按企业数据口径时区落日（广告日汇总的日期是广告账户自己的报告日）。
@Injectable()
export class AdsOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async overview(req: RequestWithContext, query: Record<string, string>): Promise<AdsOverviewResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, query)
    const dates = ScopeSearchSchema.parse(query)
    const { granularity } = AdsOverviewQuerySchema.parse(query)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const timeZone = validZone(tenant?.timezone)
    const { period, compare, defaulted } = resolvePeriods(dates, todayIn(timeZone))
    const ctx: AdsLoadContext = { tenantId: context.tenantId, scope }
    const prisma = this.prisma
    const days = eachDay(period.from, period.to)

    const [rows, before, everHad, info, others, unbound, campaigns, budgeted, store, storeBefore] = await Promise.all([
      dailyByProduct(prisma, ctx, period.from, period.to),
      compare ? adsTotals(prisma, ctx, compare.from, compare.to) : Promise.resolve(null),
      everHadAdsData(prisma, ctx),
      refreshInfo(prisma, ctx, period.from, period.to),
      otherCurrencies(prisma, ctx, period.from, period.to),
      unboundSpend(prisma, ctx, period.from, period.to),
      campaignTotals(prisma, ctx, period.from, period.to),
      budgetedCampaigns(prisma, ctx),
      storeDaily(prisma, ctx, period.from, period.to),
      compare ? storeTotals(prisma, ctx, compare.from, compare.to) : Promise.resolve(null),
    ])
    const byDate = dailyTotals(rows)
    const current = addTotals([...byDate.values()])
    const hasRows = rows.length > 0
    const state: DashState = !everHad ? 'NOT_CONNECTED' : !hasRows ? 'NO_DATA' : 'OK'
    const stateNote = state === 'NOT_CONNECTED' ? NOTE_NEVER : state === 'NO_DATA' ? NOTE_EMPTY_RANGE : null
    const storeNow = sumStore(store)

    const quadrant = this.quadrant(campaigns.rows, current, state)
    const anomalies = this.anomalies(campaigns.rows, state)
    const budget = this.budget({ budgeted, campaigns: campaigns.rows, from: period.from, to: period.to, days, byDate, state })
    const names = await campaignNames(prisma, ctx, [...quadrant.points, ...anomalies.items])
    const named = <T extends { adsProfileId: string; adProduct: string; campaignId: string; key: string; name: string }>(item: T): T => ({ ...item, name: names.get(item.key) ?? item.campaignId })
    const events = state === 'OK' ? await trendEvents(prisma, ctx, period.from, period.to, timeZone) : []

    return {
      period,
      compare,
      defaulted,
      currency: ADS_CONSOLE_CURRENCY,
      state,
      note: stateNote,
      refreshedAt: info?.refreshedAt ?? null,
      metricVersion: info?.metricVersion ?? null,
      otherCurrencies: others,
      unboundSpend: unbound,
      granularity,
      cards: buildAdsCards({
        everHadData: everHad,
        hasRows,
        current,
        previous: before?.totals ?? null,
        previousHasRows: before?.hasRows ?? false,
        days,
        daily: byDate,
        store: { hasRows: storeNow.hasRows, current: storeNow.day, previous: storeBefore?.day ?? null, previousHasRows: storeBefore?.hasRows ?? false, daily: store },
        budget: { state: budget.state, note: budget.note, utilization: budget.utilization },
        anomalyCount: anomalies.count,
        anomalyState: anomalies.state,
        anomalyNote: anomalies.note,
        unboundSpend: unbound,
      }),
      trend: { state, note: stateNote, points: state === 'OK' ? trendPoints(days, byDate, granularity) : [], events },
      mix: storeNow.hasRows ? { state: 'OK', note: null, points: mixPoints(days, store, granularity) } : { state: 'NO_DATA', note: NOTE_NO_STORE_ROWS, points: [] },
      products: productRows(rows),
      funnel: { state, note: stateNote, value: state === 'OK' ? funnelOf(current) : null },
      budget,
      targetAcos: { state: 'NOT_CONNECTED', note: NOTE_TARGET_ACOS },
      quadrant: { ...quadrant, points: quadrant.points.map(named) },
      anomalies: { ...anomalies, items: anomalies.items.map(named) },
      attribution: this.attribution(current, before, state),
      campaignsTruncated: campaigns.truncated,
    }
  }

  private budget(input: {
    budgeted: Awaited<ReturnType<typeof budgetedCampaigns>>
    campaigns: readonly CampaignRow[]
    from: string
    to: string
    days: readonly string[]
    byDate: ReadonlyMap<string, AdsTotals>
    state: DashState
  }): AdsBudgetSection {
    const overBudget = { state: 'NOT_CONNECTED' as const, note: NOTE_OVER_BUDGET }
    const base = { days: budgetDays(input.days, input.byDate), dailyBudgetTotal: null, utilization: null, budgetedCampaigns: 0, overBudget }
    const { campaigns, unknownType, truncated } = input.budgeted
    if (campaigns.length === 0) {
      const note = unknownType > 0 ? `有 ${unknownType} 个活动带预算但预算类型没有同步，无法判断是不是日预算，未计算` : '没有带日预算的活动记录（活动管理接口的预算尚未同步）'
      return { ...base, state: 'NO_DATA', note }
    }
    if (input.state !== 'OK') return { ...base, state: input.state, note: input.state === 'NOT_CONNECTED' ? NOTE_NEVER : NOTE_EMPTY_RANGE }
    const spendOf = new Map(input.campaigns.map(row => [row.key, row.totals.spend ?? 0]))
    const result = budgetUtilizationOf(
      campaigns.map(campaign => ({ dailyBudget: campaign.dailyBudget, spend: spendOf.get(campaign.key) ?? 0, startDate: campaign.startDate, endDate: campaign.endDate })),
      input.from,
      input.to,
    )
    const extra = truncated ? '；活动超过读取上限，只含前一部分' : ''
    return {
      ...base,
      state: 'OK',
      note: `${NOTE_BUDGET_ESTIMATE}${extra}`,
      dailyBudgetTotal: campaigns.reduce((total, campaign) => total + campaign.dailyBudget, 0),
      utilization: result.utilization,
      budgetedCampaigns: campaigns.length,
    }
  }

  private quadrant(rows: readonly CampaignRow[], current: AdsTotals, state: DashState): AdsQuadrantSection {
    const empty = (note: string | null): AdsQuadrantSection => ({ state: state === 'OK' ? 'NO_DATA' : state, note, spendLine: null, acosLine: null, points: [], withoutSales: 0 })
    if (state !== 'OK') return empty(state === 'NOT_CONNECTED' ? NOTE_NEVER : NOTE_EMPTY_RANGE)
    const spending = rows.filter(row => (row.totals.spend ?? 0) > 0)
    if (spending.length === 0) return empty(NOTE_NO_CAMPAIGNS)
    const withSales = spending.filter(row => (row.totals.sales ?? 0) > 0)
    const spendLine = spending.reduce((total, row) => total + (row.totals.spend ?? 0), 0) / spending.length
    const acosLine = adsRatios(current).acos
    if (withSales.length === 0 || acosLine === null) return { ...empty('没有活动带广告销售额，ACoS 无法计算，四象限画不出'), withoutSales: spending.length }
    const points: AdsQuadrantPoint[] = withSales.slice(0, ADS_QUADRANT_LIMIT).map(row => {
      const spend = row.totals.spend ?? 0
      const sales = row.totals.sales ?? 0
      const acos = spend / sales
      return {
        key: row.key,
        adsProfileId: row.adsProfileId,
        adProduct: row.adProduct,
        campaignId: row.campaignId,
        name: row.campaignId,
        spend,
        sales,
        orders: row.totals.orders,
        acos,
        quadrant: quadrantOf(spend, acos, spendLine, acosLine),
      }
    })
    const shown = withSales.length > points.length ? `；活动较多，只画花费最高的 ${points.length} 个` : null
    return { state: 'OK', note: shown, spendLine, acosLine, points, withoutSales: spending.length - withSales.length }
  }

  private anomalies(rows: readonly CampaignRow[], state: DashState): AdsAnomalySection {
    if (state !== 'OK') return { state, note: state === 'NOT_CONNECTED' ? NOTE_NEVER : NOTE_EMPTY_RANGE, count: 0, items: [], rules: ADS_ANOMALY_RULES }
    const hits = rows.flatMap((row): AdsAnomalyItem[] => {
      const kind = campaignAnomaly({ spend: row.totals.spend, sales: row.totals.sales, clicks: row.totals.clicks, orders: row.totals.orders })
      return kind
        ? [
            {
              key: row.key,
              adsProfileId: row.adsProfileId,
              adProduct: row.adProduct,
              campaignId: row.campaignId,
              name: row.campaignId,
              kind,
              spend: row.totals.spend ?? 0,
              sales: row.totals.sales,
              clicks: row.totals.clicks,
              orders: row.totals.orders,
            },
          ]
        : []
    })
    const note = rows.length === 0 ? NOTE_NO_CAMPAIGNS : null
    return { state: 'OK', note, count: hits.length, items: hits.slice(0, ADS_ANOMALY_LIST_LIMIT), rules: ADS_ANOMALY_RULES }
  }

  private attribution(current: AdsTotals, before: { totals: AdsTotals; hasRows: boolean } | null, state: DashState): AdsAttributionSection {
    if (state !== 'OK') return { state, note: state === 'NOT_CONNECTED' ? NOTE_NEVER : NOTE_EMPTY_RANGE, spend: null, sales: null }
    if (!before) return { state: 'NO_DATA', note: '没有选择对比期，无法拆解变化', spend: null, sales: null }
    if (!before.hasRows) return { state: 'NO_DATA', note: '对比期没有广告汇总记录，无法拆解变化', spend: null, sales: null }
    const result = adsAttribution(current, before.totals)
    return { state: result.spend || result.sales ? 'OK' : 'NO_DATA', note: result.note, spend: result.spend, sales: result.sales }
  }
}
