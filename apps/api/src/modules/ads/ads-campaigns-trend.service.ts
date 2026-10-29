import { Injectable } from '@nestjs/common'
import {
  ADS_CAMPAIGN_ENTITY_TYPE,
  addTotals,
  adsAttribution,
  buildHourlyCells,
  ScopeSearchSchema,
  type AdsAttributionSection,
  type AdsCampaignHourlyResponse,
  type AdsCampaignTrendResponse,
  type AdsTotals,
  type AdsTrendPointDay,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere } from '../auth'
import { addDays, asDate, eachDay, localDate } from '../overview'
import { AdsCampaignAccessService, num, rangeOf } from './ads-campaigns-common'
import { campaignDaily, campaignEverHadSummary } from './ads-campaigns-load'
import { adsStreamSinkConfigured } from './ads-today.service'

const HISTORY_DAYS = 28
const NOTE_NEVER = '这个活动还没有任何广告日汇总记录；同步广告报告后才会出现'
const NOTE_EMPTY = '所选日期范围内这个活动没有广告日汇总记录'
const NOTE_AMAZON_EVENTS = '亚马逊侧的预算、竞价、状态变更没有同步器（需要广告变更历史接口），趋势图上只标注本系统内的改动（标签、负责人）'
const NOTE_STREAM_OFF = '营销数据流尚未配置（没有设置数据流接收端），没有分时数据；配置并开始接收后才会出现'
const NOTE_STREAM_EMPTY = `近 ${HISTORY_DAYS} 天没有这个活动的分时记录（数据流只在配置之后才开始累积，不会补历史）`
const NOTE_REPORT_HOURS = '分时只来自营销数据流；亚马逊的小时级广告报告（用于核对与补缺）没有同步器'

const pointOf = (date: string, totals: AdsTotals | undefined): AdsTrendPointDay => ({
  date,
  impressions: totals?.impressions ?? null,
  clicks: totals?.clicks ?? null,
  spend: totals?.spend ?? null,
  sales: totals?.sales ?? null,
  orders: totals?.orders ?? null,
})

// 活动详情的“表现趋势”与“分时表现”页签：趋势读广告日汇总（活动自己的币种），分时读营销数据流的小时指标（按企业时区归到“周几 × 几点”）。
@Injectable()
export class AdsCampaignTrendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsCampaignAccessService,
  ) {}

  async trend(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsCampaignTrendResponse> {
    const { campaign, ctx, tenantId } = await this.access.resolve(req, id, rawQuery)
    const dates = ScopeSearchSchema.parse(rawQuery)
    const { zone, period, compare } = await rangeOf(this.prisma, tenantId, dates)
    const ref = { adsProfileId: campaign.adsProfileId, adProduct: campaign.adProduct, externalCampaignId: campaign.externalCampaignId, currency: campaign.currency }
    const [byDate, previousByDate, everHad, events] = await Promise.all([
      campaignDaily(this.prisma, ctx, ref, period.from, period.to),
      compare ? campaignDaily(this.prisma, ctx, ref, compare.from, compare.to) : Promise.resolve(new Map<string, AdsTotals>()),
      campaignEverHadSummary(this.prisma, ctx, ref),
      this.prisma.entityEvent.findMany({
        where: { tenantId, entityType: ADS_CAMPAIGN_ENTITY_TYPE, entityId: campaign.id, occurredAt: { gte: asDate(addDays(period.from, -1)), lt: asDate(addDays(period.to, 2)) } },
        select: { occurredAt: true, title: true, kind: true },
        orderBy: { occurredAt: 'asc' },
        take: 200,
      }),
    ])
    const has = byDate.size > 0
    const state = has ? 'OK' : everHad ? 'NO_DATA' : 'NOT_CONNECTED'
    const note = state === 'NOT_CONNECTED' ? NOTE_NEVER : state === 'NO_DATA' ? NOTE_EMPTY : null
    const totals = has ? addTotals([...byDate.values()]) : null
    const previous = previousByDate.size > 0 ? addTotals([...previousByDate.values()]) : null
    return {
      state,
      note,
      period,
      compare,
      currency: campaign.currency,
      points: eachDay(period.from, period.to).map(date => pointOf(date, byDate.get(date))),
      previousPoints: compare ? eachDay(compare.from, compare.to).map(date => pointOf(date, previousByDate.get(date))) : [],
      totals,
      previous,
      events: events.map(event => ({ date: localDate(event.occurredAt, zone), label: event.title, kind: event.kind })).filter(event => event.date >= period.from && event.date <= period.to),
      amazonEvents: { state: 'NOT_CONNECTED', note: NOTE_AMAZON_EVENTS },
      attribution: this.attribution(totals, previous, Boolean(compare), state, note),
    }
  }

  private attribution(current: AdsTotals | null, previous: AdsTotals | null, hasCompare: boolean, state: AdsCampaignTrendResponse['state'], note: string | null): AdsAttributionSection {
    if (state !== 'OK' || !current) return { state, note, spend: null, sales: null }
    if (!hasCompare) return { state: 'NO_DATA', note: '没有选择对比期，无法拆解变化', spend: null, sales: null }
    if (!previous) return { state: 'NO_DATA', note: '对比期这个活动没有广告汇总记录，无法拆解变化', spend: null, sales: null }
    const result = adsAttribution(current, previous)
    return { state: result.spend || result.sales ? 'OK' : 'NO_DATA', note: result.note, spend: result.spend, sales: result.sales }
  }

  async hourly(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<AdsCampaignHourlyResponse> {
    const { campaign, ctx, tenantId } = await this.access.resolve(req, id, rawQuery)
    const base = { streamConnected: adsStreamSinkConfigured(), historyDays: HISTORY_DAYS, reportHours: { state: 'NOT_CONNECTED' as const, note: NOTE_REPORT_HOURS } }
    if (!base.streamConnected) return { ...base, state: 'NOT_CONNECTED', note: NOTE_STREAM_OFF, cells: [] }
    const { zone } = await rangeOf(this.prisma, tenantId, {}, now)
    const rows = await this.prisma.adsPerformanceHourly.findMany({
      where: {
        tenantId,
        ...adsRelationWhere(ctx.scope),
        adsProfileId: campaign.adsProfileId,
        entityType: 'CAMPAIGN',
        entityId: campaign.externalCampaignId,
        currency: campaign.currency,
        hourStart: { gte: new Date(now.getTime() - HISTORY_DAYS * 86_400_000), lte: now },
      },
      select: { hourStart: true, clicks: true, orders: true, spend: true, sales: true },
      orderBy: { hourStart: 'asc' },
      take: HISTORY_DAYS * 25 + 24,
    })
    if (rows.length === 0) return { ...base, state: 'NO_DATA', note: NOTE_STREAM_EMPTY, cells: [] }
    const cells = buildHourlyCells(
      rows.map(row => ({ hourStart: row.hourStart, clicks: row.clicks, orders: row.orders, spend: num(row.spend), sales: num(row.sales) })),
      zone,
    )
    return { ...base, state: 'OK', note: null, cells }
  }
}
