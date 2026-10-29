import { Injectable } from '@nestjs/common'
import {
  ADS_CONSOLE_CURRENCY,
  ADS_READ,
  ADS_TODAY_BASELINE_DAYS,
  ADS_TODAY_HISTORY_DAYS,
  ADS_TODAY_LIST_LIMIT,
  ADS_TODAY_METRIC_VERSION,
  ADS_TODAY_STOCKOUT_LOOKBACK_DAYS,
  ADS_TODAY_UPDATE_NOTE,
  ScopeSearchSchema,
  adsStreamState,
  type AdsTodayResponse,
  type AdsTodayStreamState,
  type AdsTotals,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { addDays, todayIn, validZone, zonedDayStart } from '../overview'
import type { AdsLoadContext } from './ads-overview-load'
import {
  advertisedSpend,
  budgetCampaigns,
  campaignNameMap,
  campaignSums,
  campaignKeyOf,
  everAdvertised,
  hourlyByHour,
  hourlyOtherCurrencies,
  latestHourlyUpdate,
  latestSnapshots,
  latestSummaryDay,
  outOfBudgetCampaigns,
  profileStores,
  storeNames,
} from './ads-today-load'
import { buildAnomalies, buildBudget, buildHours, buildOutOfBudget, buildStockout, STREAM_NOTE, todayTotals, totalsView, yesterdaySameHour } from './ads-today-sections'

const DAY_MS = 86_400_000
const noRows = () => ({ rows: new Map<string, AdsTotals>(), truncated: false })

/**
 * 营销数据流的接收端是否配置：看部署专项环境变量 AMAZON_ADS_STREAM_SINK（接收端的队列或存储桶标识）。
 * 没有配置就是“未接入”（14.10）：不查小时指标，退化展示最近一天的日报表汇总。
 */
export const adsStreamSinkConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.AMAZON_ADS_STREAM_SINK?.trim())

// 今日广告（P3-06，08 章 8.2）：读小时指标、活动预算与投放状态、被推广商品与库存快照，不调亚马逊、不写库。
// 范围经 adsProfile.sellerAccountId 过滤（未绑定的广告账户只有“全部店铺”成员看得到）；“今天”按企业数据口径时区。
@Injectable()
export class AdsTodayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async today(req: RequestWithContext, query: Record<string, string>, now: Date = new Date()): Promise<AdsTodayResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, query)
    ScopeSearchSchema.parse(query)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const timeZone = validZone(tenant?.timezone)
    const businessDate = todayIn(timeZone, now)
    const dayStart = zonedDayStart(businessDate, timeZone)
    const dayEndExclusive = zonedDayStart(addDays(businessDate, 1), timeZone)
    const ctx: AdsLoadContext = { tenantId: context.tenantId, scope }
    const prisma = this.prisma
    const stream = adsStreamState({ sinkConfigured: adsStreamSinkConfigured() })

    // 接收端没配置就不会有小时指标，不必去查
    const live = stream.connected
    const historyFrom = new Date(dayStart.getTime() - ADS_TODAY_HISTORY_DAYS * DAY_MS)
    const baselineFrom = new Date(dayStart.getTime() - ADS_TODAY_BASELINE_DAYS * DAY_MS)
    const [byHour, todayCampaigns, baselineCampaigns, asOf, others] = live
      ? await Promise.all([
          hourlyByHour(prisma, ctx, historyFrom, dayEndExclusive),
          campaignSums(prisma, ctx, dayStart, dayEndExclusive),
          campaignSums(prisma, ctx, baselineFrom, dayStart),
          latestHourlyUpdate(prisma, ctx, dayStart, dayEndExclusive),
          hourlyOtherCurrencies(prisma, ctx, dayStart, dayEndExclusive),
        ])
      : [new Map<string, AdsTotals>(), noRows(), noRows(), null, []]
    const todaySum = live ? todayTotals(byHour, dayStart, dayEndExclusive) : null
    const streamState: AdsTodayStreamState = !live ? 'NOT_CONNECTED' : todaySum ? 'LIVE' : 'NO_DATA'

    const lookbackFrom = addDays(businessDate, -(ADS_TODAY_STOCKOUT_LOOKBACK_DAYS - 1))
    const [fallback, budgeted, outOfBudget, ever, advertised] = await Promise.all([
      streamState === 'LIVE' ? Promise.resolve(null) : latestSummaryDay(prisma, ctx, businessDate),
      budgetCampaigns(prisma, ctx),
      outOfBudgetCampaigns(prisma, ctx, ADS_TODAY_LIST_LIMIT),
      everAdvertised(prisma, ctx),
      advertisedSpend(prisma, ctx, lookbackFrom, businessDate),
    ])

    const stockout = await this.stockout(ctx, ever, advertised)
    const anomalies = buildAnomalies({ stream: streamState, today: todayCampaigns.rows, baseline: baselineCampaigns.rows, truncated: todayCampaigns.truncated })
    const names = await campaignNameMap(prisma, ctx, anomalies.items)

    const note = streamState === 'LIVE' ? null : stream.connected ? STREAM_NOTE.NO_DATA : stream.label
    const totalsNote = streamState === 'LIVE' ? null : streamState === 'NOT_CONNECTED' ? STREAM_NOTE.NOT_CONNECTED : STREAM_NOTE.NO_DATA
    const dayState = streamState === 'LIVE' ? 'OK' : streamState
    return {
      streamState,
      note,
      updateNote: ADS_TODAY_UPDATE_NOTE,
      businessDate,
      asOf,
      currency: ADS_CONSOLE_CURRENCY,
      metricVersion: ADS_TODAY_METRIC_VERSION,
      otherCurrencies: others,
      totals: { state: dayState, note: totalsNote, value: todaySum ? totalsView(todaySum) : null, yesterdaySameHour: todaySum ? yesterdaySameHour(byHour, dayStart, now) : null },
      fallback: fallback ? { summaryDate: fallback.summaryDate, totals: totalsView(fallback.totals), refreshedAt: fallback.refreshedAt } : null,
      hours: { state: dayState, note: totalsNote, items: streamState === 'LIVE' ? buildHours({ byHour, dayStart, dayEndExclusive, now }) : [], historyDays: ADS_TODAY_HISTORY_DAYS },
      budget: buildBudget({
        stream: streamState,
        campaigns: budgeted.rows,
        truncated: budgeted.truncated,
        spend: todayCampaigns.rows,
        sumsTruncated: todayCampaigns.truncated,
        now,
        dayStart,
        dayEndExclusive,
      }),
      outOfBudget: buildOutOfBudget(outOfBudget),
      anomalies: { ...anomalies, items: anomalies.items.map(item => ({ ...item, name: names.get(campaignKeyOf(item.adsProfileId, item.campaignId)) ?? item.campaignId })) },
      stockout,
      truncated: todayCampaigns.truncated || baselineCampaigns.truncated || budgeted.truncated,
    }
  }

  private async stockout(ctx: AdsLoadContext, ever: boolean, advertised: Awaited<ReturnType<typeof advertisedSpend>>) {
    const profiles = [...new Set(advertised.rows.map(row => row.adsProfileId))]
    const storeOfProfile = await profileStores(this.prisma, ctx, profiles)
    const stores = [...new Set([...storeOfProfile.values()].filter((id): id is string => id !== null))]
    const asins = [...new Set(advertised.rows.map(row => row.asin).filter(Boolean))]
    const [snapshots, names] = await Promise.all([latestSnapshots(this.prisma, ctx, stores, asins), storeNames(this.prisma, ctx, stores)])
    return buildStockout({ ever, advertised: advertised.rows, truncated: advertised.truncated, storeOfProfile, snapshots, storeNames: names })
  }
}
