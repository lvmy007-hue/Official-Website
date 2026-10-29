import { Injectable } from '@nestjs/common'
import {
  ADS_CONSOLE_CURRENCY,
  ADS_PORTFOLIO_MAX_WINDOWS,
  ADS_PORTFOLIO_PACE_BASIS,
  ADS_PORTFOLIO_WRITE_PENDING,
  ADS_READ,
  AdsPortfolioListQuerySchema,
  addDaysToText,
  comparePortfolios,
  portfolioMatches,
  summarizePortfolios,
  type AdsPortfolioListResponse,
  type AdsPortfolioRow,
  type AdsPortfolioSort,
  type AdsPortfolioWindow,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ContextService } from '../auth'
import { rangeOf } from './ads-campaigns-common'
import type { AdsLoadContext } from './ads-overview-load'
import { decodeOffset, pageOf } from './ads-page'
import { campaignDailySpend, campaignRangeTotals, historyWindow, loadPortfolioCampaigns, loadPortfolios, portfolioKeyOf, type PortfolioRecord } from './ads-portfolios-load'
import { dailyOfCampaigns, groupCampaigns, rowOf, spendBetween, sumCampaignTotals, weightsOf, windowKey, windowOfRecord } from './ads-portfolios-rows'
const NOTE_NEVER = '可见范围内还没有同步到广告组合；连接广告账户并同步广告组合后才会出现'
const NOTE_FILTERED = '没有符合筛选条件的广告组合'
const NOTE_WINDOWS = `预算周期窗口超过 ${ADS_PORTFOLIO_MAX_WINDOWS} 个，多出来的组合没有读花费汇总，已用金额退回亚马逊同步来的数`

// 广告组合列表（08 章 8.8）：组合来自统一接口同步的 AdsPortfolio（预算上限与周期），花费来自广告日汇总（美元，活动级）。
// 做法：数据库取组合与它们的活动 → 每个不同的预算周期窗口各做一次花费聚合（按月循环的组合共用一个窗口），再做一次所选范围的指标聚合与一次历史节奏的逐日聚合
// → 内存里算节奏、筛选、排序 → 偏移游标分页（游标签名并绑定全部查询条件）。空值是 null，不是 0。
@Injectable()
export class AdsPortfolioListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsPortfolioListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsPortfolioListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const ctx: AdsLoadContext = { tenantId, scope }
    const { period, defaulted, today } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)

    const { records, truncated: portfoliosTruncated } = await loadPortfolios(this.prisma, ctx)
    const { rows, windowsTruncated, metricsTruncated, campaignsTruncated } = await this.assemble(ctx, records, today, period)
    const kept = rows
      .filter(row => portfolioMatches(row, query.q) && (!query.pace || row.pace.verdict === query.pace))
      .sort((a, b) => comparePortfolios(a, b, query.sort.field as AdsPortfolioSort, query.sort.dir))
    const { page, pageInfo } = pageOf(kept, offset, query.pageSize, binding)

    let state: AdsPortfolioListResponse['state'] = 'OK'
    let note: string | null = windowsTruncated ? NOTE_WINDOWS : null
    if (kept.length === 0) {
      // 有组合但被筛选条件挡掉了，与“可见范围内从未同步过组合”要分开说
      state = records.length > 0 ? 'NO_DATA' : 'NOT_CONNECTED'
      note = records.length > 0 ? NOTE_FILTERED : NOTE_NEVER
    }
    return {
      state,
      note,
      items: page,
      pageInfo,
      range: { from: period.from, to: period.to, defaulted },
      businessDate: today,
      currency: ADS_CONSOLE_CURRENCY,
      summary: summarizePortfolios(kept),
      paceBasis: ADS_PORTFOLIO_PACE_BASIS,
      write: ADS_PORTFOLIO_WRITE_PENDING,
      truncated: portfoliosTruncated || windowsTruncated || campaignsTruncated,
      metricsTruncated,
    }
  }

  /** 取全部需要的数据并装配成行（不筛选、不排序）。 */
  private async assemble(ctx: AdsLoadContext, records: readonly PortfolioRecord[], today: string, period: { from: string; to: string }) {
    const yesterday = addDaysToText(today, -1)
    const { campaigns, truncated: campaignsTruncated } = await loadPortfolioCampaigns(
      this.prisma,
      ctx,
      records.map(record => record.adsProfileId),
      records.map(record => record.portfolioId),
    )
    const grouped = groupCampaigns(campaigns)
    const campaignsOf = (record: PortfolioRecord) => grouped.get(portfolioKeyOf(record.adsProfileId, record.portfolioId)) ?? []
    const windows = new Map(records.map(record => [record.id, windowOfRecord(record, today)]))

    // 每个不同的预算周期窗口读一次花费（截至昨天）；超过上限的窗口不读
    const distinct = new Map<string, AdsPortfolioWindow>()
    for (const window of windows.values()) if (window.from !== null && window.to !== null && !distinct.has(windowKey(window))) distinct.set(windowKey(window), window)
    const readable = [...distinct.entries()].slice(0, ADS_PORTFOLIO_MAX_WINDOWS)
    const windowsTruncated = distinct.size > ADS_PORTFOLIO_MAX_WINDOWS
    const readableKeys = new Set(readable.map(([key]) => key))
    const usable = (record: PortfolioRecord) => record.currency === ADS_CONSOLE_CURRENCY && readableKeys.has(windowKey(windows.get(record.id)!))

    const windowSpend = new Map<string, Map<string, number>>()
    let metricsTruncated = false
    await Promise.all(
      readable.map(async ([key, window]) => {
        const members = records.filter(record => usable(record) && windowKey(windows.get(record.id)!) === key)
        const memberCampaigns = members.flatMap(campaignsOf)
        const to = window.to! < yesterday ? window.to! : yesterday
        const read = await campaignDailySpend(this.prisma, ctx, memberCampaigns, window.from!, to)
        metricsTruncated ||= read.truncated
        for (const member of members) windowSpend.set(member.id, dailyOfCampaigns(campaignsOf(member), read.rows))
      }),
    )

    // 历史节奏：只给要算节奏的组合（有预算上限、周期认识、美元）读最近 56 天的逐日花费
    const pacing = records.filter(record => usable(record) && record.budgetCap !== null)
    const history = historyWindow(today)
    const historyRead = await campaignDailySpend(this.prisma, ctx, pacing.flatMap(campaignsOf), history.from, history.to)
    // 历史超过读取上限时所有组合都退回按天均摊，不拿截断的历史算权重
    metricsTruncated ||= historyRead.truncated
    const rangeRead = await campaignRangeTotals(this.prisma, ctx, campaigns, period.from, period.to)
    metricsTruncated ||= rangeRead.truncated

    const rows: AdsPortfolioRow[] = records.map(record => {
      const window = windows.get(record.id)!
      const own = campaignsOf(record)
      const daily = windowSpend.get(record.id)
      return rowOf(record, {
        today,
        window,
        reportSpend: daily && window.from !== null && window.to !== null ? spendBetween(daily, window.from, window.to) : null,
        weights: !historyRead.truncated && pacing.includes(record) ? weightsOf(dailyOfCampaigns(own, historyRead.rows)) : null,
        campaigns: own,
        totals: sumCampaignTotals(own, rangeRead.byCampaign),
      })
    })
    return { rows, windowsTruncated, metricsTruncated, campaignsTruncated }
  }
}
