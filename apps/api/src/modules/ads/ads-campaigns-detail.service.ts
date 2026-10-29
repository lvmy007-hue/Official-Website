import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  ADS_CAMPAIGN_WRITE,
  ADS_CONSOLE_CURRENCY,
  ADS_OVER_BUDGET_NOTE,
  ADS_WRITE_PENDING,
  addTotals,
  adsCampaignTabsFor,
  adsShareOf,
  campaignBudgetUtilization,
  ratiosOf,
  ScopeSearchSchema,
  type AdsCampaignDetailResponse,
  type AdsCampaignMetrics,
  type AdsTotals,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { dateText } from '../overview'
import { AdsCampaignAdviceService } from './ads-campaigns-advice.service'
import { activeMembers, AdsCampaignAccessService, identityOf, num, portfolioKey, portfolioNames, rangeOf } from './ads-campaigns-common'
import { campaignDaily, campaignEverHadSummary, storeSalesByStore } from './ads-campaigns-load'

const NOTE_NEVER = '这个活动还没有任何广告日汇总记录；同步广告报告后才会出现'
const NOTE_EMPTY = '所选日期范围内这个活动没有广告日汇总记录'

// 广告活动详情（08 章 8.3）：身份区、指标区、建议动作区与页签清单。各页签的数据由各自接口按需取。
@Injectable()
export class AdsCampaignDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsCampaignAccessService,
    private readonly advice: AdsCampaignAdviceService,
  ) {}

  async detail(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<AdsCampaignDetailResponse> {
    const { campaign, ctx, tenantId, permissions } = await this.access.resolve(req, id, rawQuery)
    const dates = ScopeSearchSchema.parse(rawQuery)
    const { today, period, compare } = await rangeOf(this.prisma, tenantId, dates, now)
    const ref = { adsProfileId: campaign.adsProfileId, adProduct: campaign.adProduct, externalCampaignId: campaign.externalCampaignId, currency: campaign.currency }
    const canWrite = hasPermission(permissions as string[], ADS_CAMPAIGN_WRITE)
    const storeId = campaign.adsProfile.sellerAccountId

    const [byDate, previousByDate, everHad, stores, portfolios, owners, advice, members] = await Promise.all([
      campaignDaily(this.prisma, ctx, ref, period.from, period.to),
      compare ? campaignDaily(this.prisma, ctx, ref, compare.from, compare.to) : Promise.resolve(new Map<string, AdsTotals>()),
      campaignEverHadSummary(this.prisma, ctx, ref),
      storeId && campaign.currency === ADS_CONSOLE_CURRENCY ? storeSalesByStore(this.prisma, ctx, period.from, period.to) : Promise.resolve(new Map<string, number>()),
      portfolioNames(this.prisma, tenantId, [campaign]),
      memberNames(this.prisma, tenantId, [campaign.ownerId]),
      this.advice.rules(ctx, campaign, today),
      canWrite ? activeMembers(this.prisma, tenantId) : Promise.resolve([]),
    ])
    const totals = byDate.size > 0 ? addTotals([...byDate.values()]) : null
    const previous = previousByDate.size > 0 ? addTotals([...previousByDate.values()]) : null
    const state = totals ? 'OK' : everHad ? 'NO_DATA' : 'NOT_CONNECTED'
    const budget = num(campaign.budget)
    const metrics: AdsCampaignMetrics = {
      state,
      note: state === 'NOT_CONNECTED' ? NOTE_NEVER : state === 'NO_DATA' ? NOTE_EMPTY : null,
      period,
      compare,
      totals,
      previous,
      ratios: ratiosOf(totals),
      previousRatios: ratiosOf(previous),
      adsShare: adsShareOf(totals?.spend ?? null, storeId ? (stores.get(storeId) ?? null) : null),
      budgetUtilization: campaignBudgetUtilization(
        {
          state: campaign.state,
          budget,
          budgetType: campaign.budgetType,
          startDate: campaign.startDate ? dateText(campaign.startDate) : null,
          endDate: campaign.endDate ? dateText(campaign.endDate) : null,
        },
        totals?.spend ?? null,
        period.from,
        period.to,
      ),
      avgOverBudget: { state: 'NOT_CONNECTED', note: ADS_OVER_BUDGET_NOTE },
    }
    return {
      identity: identityOf(campaign, {
        portfolioName: campaign.portfolioId ? (portfolios.get(portfolioKey(campaign.adsProfileId, campaign.portfolioId)) ?? null) : null,
        ownerName: campaign.ownerId ? (owners.get(campaign.ownerId) ?? null) : null,
      }),
      metrics,
      advice,
      tabs: adsCampaignTabsFor(campaign.adProduct),
      canWrite,
      members,
      write: ADS_WRITE_PENDING,
    }
  }
}
