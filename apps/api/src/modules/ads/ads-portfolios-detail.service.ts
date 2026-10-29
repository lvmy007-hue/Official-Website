import { Injectable } from '@nestjs/common'
import {
  ADS_BUDGET_RULES_DISABLED_NOTE,
  ADS_BUDGET_RULES_EMPTY_NOTE,
  ADS_BUDGET_RULES_FLAG,
  ADS_CONSOLE_CURRENCY,
  ADS_PORTFOLIO_PACE_BASIS,
  ADS_PORTFOLIO_WRITE_PENDING,
  ADS_READ,
  ScopeSearchSchema,
  addDaysToText,
  adviceOf,
  curveOf,
  describeRuleParams,
  type AdsBudgetRuleView,
  type AdsPortfolioDetailResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, ContextService } from '../auth'
import { CAMPAIGN_ID_PATTERN, rangeOf } from './ads-campaigns-common'
import type { AdsLoadContext } from './ads-overview-load'
import { campaignDailySpend, campaignRangeTotals, historyWindow, loadBudgetRules, loadPortfolioCampaigns, PORTFOLIO_SELECT, type PortfolioCampaign } from './ads-portfolios-load'
import { allocationOf, campaignSpendOf, currentDailyBudgetOf, dailyOfCampaigns, recentDailyOf, rowOf, spendBetween, sumCampaignTotals, weightsOf, windowOfRecord } from './ads-portfolios-rows'

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes'])

/** 预算规则功能开关：环境变量 ADS_BUDGET_RULES_BETA 为 1、true、on、yes 才打开（默认关闭）。 */
export const budgetRulesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => TRUE_VALUES.has(env[ADS_BUDGET_RULES_FLAG]?.trim().toLowerCase() ?? '')

const NO_ROWS = { rows: [], truncated: false }

// 广告组合详情（08 章 8.8）：身份区与节奏 → 预算节奏图（理想与实际累计）→ 各活动的预算分配 → 预算规则（测试版资源，功能开关）。
// 先权限、再按范围找组合（范围外与不存在都是 404）。实际花费一律是广告日汇总里组合下全部活动的美元花费，截至昨天。
@Injectable()
export class AdsPortfolioDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsPortfolioDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    if (!CAMPAIGN_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '广告组合不存在')
    const tenantId = context.tenantId
    const ctx: AdsLoadContext = { tenantId, scope }
    const record = await this.prisma.adsPortfolio.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: PORTFOLIO_SELECT })
    if (!record) throw appError('RESOURCE_NOT_FOUND', '广告组合不存在')
    const { period, defaulted, today } = await rangeOf(this.prisma, tenantId, ScopeSearchSchema.parse(rawQuery))

    const { campaigns: loaded, truncated: campaignsTruncated } = await loadPortfolioCampaigns(this.prisma, ctx, [record.adsProfileId], [record.portfolioId])
    const campaigns = loaded.filter(item => item.adsProfileId === record.adsProfileId && item.portfolioId === record.portfolioId)
    const window = windowOfRecord(record, today)
    const yesterday = addDaysToText(today, -1)
    const usd = record.currency === ADS_CONSOLE_CURRENCY
    const known = window.from !== null && window.to !== null
    const windowTo = window.to !== null && window.to < yesterday ? window.to : yesterday
    const history = historyWindow(today)

    const [windowRead, historyRead, rangeRead] = await Promise.all([
      usd && known ? campaignDailySpend(this.prisma, ctx, campaigns, window.from!, windowTo) : NO_ROWS,
      usd && record.budgetCap !== null ? campaignDailySpend(this.prisma, ctx, campaigns, history.from, history.to) : NO_ROWS,
      campaignRangeTotals(this.prisma, ctx, campaigns, period.from, period.to),
    ])
    const windowDaily = dailyOfCampaigns(campaigns, windowRead.rows)
    const historyDaily = dailyOfCampaigns(campaigns, historyRead.rows)
    // 历史超过读取上限时退回按天均摊，不拿截断的历史算权重
    const weights = historyRead.truncated ? null : weightsOf(historyDaily)
    const row = rowOf(record, {
      today,
      window,
      reportSpend: known ? spendBetween(windowDaily, window.from!, windowTo) : null,
      weights,
      campaigns,
      totals: sumCampaignTotals(campaigns, rangeRead.byCampaign),
    })
    const { advice, note: adviceNote } = adviceOf({
      pace: row.pace,
      window,
      cap: row.budget.cap,
      today,
      currentDailyBudget: currentDailyBudgetOf(campaigns),
      recentDaily: recentDailyOf(historyDaily, today),
    })
    // 实际线只在实际花费来自广告日汇总时才画；退回亚马逊同步来的已用金额时没有逐日数据，实际线整条为空，不画成 0
    const curve = curveOf(window, row.budget.cap, weights, row.spentSource === 'REPORTS' ? windowDaily : new Map(), today)
    const allocation = known
      ? allocationOf(campaigns, campaignSpendOf(campaigns, windowRead.rows), { from: window.from!, to: windowTo, basis: 'BUDGET_PERIOD' }, usd)
      : allocationOf(
          campaigns,
          new Map([...rangeRead.byCampaign].flatMap(([key, totals]) => (totals.spend === null ? [] : [[key, totals.spend] as const]))),
          { from: period.from, to: period.to, basis: 'SELECTED_RANGE' },
          usd,
        )

    return {
      row,
      businessDate: today,
      curve,
      advice,
      adviceNote,
      allocation: { ...allocation, truncated: campaignsTruncated || windowRead.truncated || allocation.truncated },
      rules: await this.rules(ctx, record.adsProfileId, campaigns),
      range: { from: period.from, to: period.to, defaulted },
      paceBasis: ADS_PORTFOLIO_PACE_BASIS,
      write: ADS_PORTFOLIO_WRITE_PENDING,
    }
  }

  private async rules(ctx: AdsLoadContext, adsProfileId: string, campaigns: readonly PortfolioCampaign[]): Promise<AdsPortfolioDetailResponse['rules']> {
    if (!budgetRulesEnabled()) return { state: 'DISABLED', note: ADS_BUDGET_RULES_DISABLED_NOTE, flag: ADS_BUDGET_RULES_FLAG, items: [] }
    const found = await loadBudgetRules(
      this.prisma,
      ctx,
      adsProfileId,
      campaigns.map(item => item.externalCampaignId),
    )
    const names = new Map(campaigns.map(item => [item.externalCampaignId, item.name]))
    const items: AdsBudgetRuleView[] = found.map(item => ({
      id: item.id,
      campaignId: item.campaignId,
      campaignName: names.get(item.campaignId) ?? null,
      ruleType: item.ruleType,
      status: item.status,
      params: describeRuleParams(item.paramsJson),
      syncedAt: item.syncedAt.toISOString(),
    }))
    return items.length === 0 ? { state: 'NO_DATA', note: ADS_BUDGET_RULES_EMPTY_NOTE, flag: ADS_BUDGET_RULES_FLAG, items } : { state: 'OK', note: null, flag: ADS_BUDGET_RULES_FLAG, items }
  }
}
