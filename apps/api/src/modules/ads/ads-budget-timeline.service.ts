import { Injectable } from '@nestjs/common'
import {
  ADS_BUDGET_TIMELINE_DAYS,
  ADS_BUDGET_TIMELINE_PRECISION,
  ADS_DEFAULT_ATTRIBUTION_WINDOW,
  ScopeSearchSchema,
  attributionWindows,
  averageOverBudgetHours,
  budgetTimelineDay,
  weekdayHourOf,
  type AdsBudgetTimelineResponse,
  type BudgetHourInput,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, type ResolvedScope } from '../auth'
import { addDays, asDate, dateText, eachDay, localDate, todayIn, validZone } from '../overview'
import { AdsCampaignAccessService, num } from './ads-campaigns-common'
import { adsStreamSinkConfigured } from './ads-today.service'

const DAY_MS = 86_400_000
const NOTE_STREAM_OFF = '营销数据流接收端尚未配置（没有设置 AMAZON_ADS_STREAM_SINK），没有小时级数据，超预算时间条无法生成；配置并开始接收后才会出现，数据流不会补历史'
const NOTE_NO_HOURS = `所选范围内这个活动没有小时记录（数据流只在配置之后才开始累积，小时维度的历史最多 ${ADS_BUDGET_TIMELINE_DAYS} 天）`
const NOTE_BUDGET_UNKNOWN = '这个活动的日预算还没有同步，只显示小时花费，不判断超预算'
const NOTE_BUDGET_TYPE = (type: string) => `这个活动的预算类型是“${type}”，不是日预算，只显示小时花费，不判断超预算`
const ROW_LIMIT = (ADS_BUDGET_TIMELINE_DAYS + 2) * 25 + 48

// 活动详情的“超预算时间条”（P6-24，16 章第 8 节；freeze/api.md GET /ads/campaigns/:id/budget-timeline）：
// 营销数据流的小时指标（活动级，14 天窗口）按企业时区归到“日期 × 小时”，累计花费与日预算比较；另给 1、7、14、30 天归因窗口的可用性与合计。
// 只读 ads.read 与数据范围，范围外的活动与不存在一样 404。没有数据写原因，不补 0；预算未知只显示花费。
@Injectable()
export class AdsBudgetTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsCampaignAccessService,
  ) {}

  async timeline(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<AdsBudgetTimelineResponse> {
    const { campaign, ctx, tenantId } = await this.access.resolve(req, id, rawQuery)
    const dates = ScopeSearchSchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const today = todayIn(zone, now)
    const to = dates.to ?? today
    const from = dates.from ?? addDays(to, -(ADS_BUDGET_TIMELINE_DAYS - 1))
    const span = eachDay(from, to).length
    if (from > to || span > ADS_BUDGET_TIMELINE_DAYS)
      throw appError('VALIDATION_FAILED', `时间范围要从早到晚，且最多 ${ADS_BUDGET_TIMELINE_DAYS} 天（小时数据最多保留这么久）`, { fieldErrors: { from: [`最多 ${ADS_BUDGET_TIMELINE_DAYS} 天`] } })

    const budget = num(campaign.budget)
    const isDaily = !campaign.budgetType || campaign.budgetType.toUpperCase() === 'DAILY'
    const usable = budget !== null && isDaily ? budget : null
    const budgetNote = budget === null ? NOTE_BUDGET_UNKNOWN : isDaily ? null : NOTE_BUDGET_TYPE(campaign.budgetType ?? '')
    const base = {
      precisionNote: ADS_BUDGET_TIMELINE_PRECISION,
      zone,
      currency: campaign.currency,
      budget: usable,
      budgetNote,
      historyDays: ADS_BUDGET_TIMELINE_DAYS,
      period: { from, to },
      defaultWindow: ADS_DEFAULT_ATTRIBUTION_WINDOW,
    }
    const windows = await this.windows(tenantId, ctx.scope, campaign, from, to)
    if (!adsStreamSinkConfigured()) return { ...base, state: 'NOT_CONNECTED', note: NOTE_STREAM_OFF, days: [], averageOverBudgetHours: null, windows }

    const rows = await this.prisma.adsPerformanceHourly.findMany({
      where: {
        tenantId,
        ...adsRelationWhere(ctx.scope),
        adsProfileId: campaign.adsProfileId,
        entityType: 'CAMPAIGN',
        entityId: campaign.externalCampaignId,
        currency: campaign.currency,
        hourStart: { gte: new Date(asDate(from).getTime() - DAY_MS), lt: new Date(asDate(to).getTime() + 2 * DAY_MS) },
      },
      select: { hourStart: true, spend: true, impressions: true, clicks: true },
      orderBy: { hourStart: 'asc' },
      take: ROW_LIMIT,
    })
    const byDate = new Map<string, Map<number, BudgetHourInput>>()
    for (const row of rows) {
      const date = localDate(row.hourStart, zone)
      if (date < from || date > to) continue
      const hours = byDate.get(date) ?? new Map<number, BudgetHourInput>()
      const hour = weekdayHourOf(row.hourStart, zone).hour
      const before = hours.get(hour)
      const spend = num(row.spend)
      // 同一个本地小时可能有多行（夏令时回拨的重复小时）：累加，花费都为空才保持为空
      hours.set(hour, {
        spend: before?.spend === null || before?.spend === undefined ? spend : spend === null ? before.spend : before.spend + spend,
        impressions: (before?.impressions ?? 0) + row.impressions,
        clicks: (before?.clicks ?? 0) + row.clicks,
      })
      byDate.set(date, hours)
    }
    if (byDate.size === 0) return { ...base, state: 'NO_DATA', note: NOTE_NO_HOURS, days: [], averageOverBudgetHours: null, windows }
    const days = eachDay(from, to).map(date => budgetTimelineDay(date, usable, byDate.get(date) ?? new Map()))
    return { ...base, state: 'OK', note: null, days, averageOverBudgetHours: averageOverBudgetHours(days), windows }
  }

  /** 归因窗口：读范围内这个活动的日报告行里保存的原始列（只有行里真带了 sales{N}d 的窗口才可用）。 */
  private async windows(tenantId: string, scope: ResolvedScope, campaign: { adsProfileId: string; adProduct: string; externalCampaignId: string; currency: string }, from: string, to: string) {
    const rows = await this.prisma.adsMetric.findMany({
      where: {
        tenantId,
        ...adsRelationWhere(scope),
        adsProfileId: campaign.adsProfileId,
        adProduct: campaign.adProduct,
        entityType: 'CAMPAIGN',
        externalCampaignId: campaign.externalCampaignId,
        currency: campaign.currency,
        reportDate: { gte: asDate(from), lte: asDate(to) },
      },
      select: { reportDate: true, raw: true },
      orderBy: { reportDate: 'asc' },
      take: ADS_BUDGET_TIMELINE_DAYS * 8,
    })
    return attributionWindows(rows.map(row => ({ date: dateText(row.reportDate), raw: row.raw })))
  }
}
