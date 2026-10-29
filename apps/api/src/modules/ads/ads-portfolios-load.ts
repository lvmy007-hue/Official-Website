import type { Prisma } from '@prisma/client'
import { ADS_CAMPAIGN_ROW_LIMIT, ADS_PORTFOLIO_PACE_RULES, ADS_PORTFOLIO_ROW_LIMIT, ADS_PORTFOLIO_RULE_LIMIT, type AdsTotals } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere } from '../auth'
import { addDays, dateText } from '../overview'
import { campaignKey, summaryWhere, totalsOf, type AdsLoadContext } from './ads-overview-load'
import { num } from './ads-campaigns-common'

// 广告组合页的数据读取（P3-11）：广告组合、组合下的活动、广告日汇总（逐日花费与范围合计）、预算规则。
// 全部在数据库里聚合，只取聚合结果；租户条件与数据范围显式带上，行级安全同时生效。花费只取美元的活动级汇总行（不折算币种），花费为空的行是“来源没给”，不读。

const HARD_LIMIT = 19_999

export const PORTFOLIO_SELECT = {
  id: true,
  adsProfileId: true,
  portfolioId: true,
  name: true,
  status: true,
  currency: true,
  budgetCap: true,
  budgetPeriod: true,
  budgetStart: true,
  budgetEnd: true,
  spent: true,
  syncedAt: true,
  adsProfile: { select: { displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } } },
} satisfies Prisma.AdsPortfolioSelect
export type PortfolioRecord = Prisma.AdsPortfolioGetPayload<{ select: typeof PORTFOLIO_SELECT }>

export const portfolioKeyOf = (adsProfileId: string, portfolioId: string) => `${adsProfileId}|${portfolioId}`

/** 可见范围内的广告组合（按名称、编号排序），最多 ADS_PORTFOLIO_ROW_LIMIT 个，多读一个判断是否截断。 */
export async function loadPortfolios(prisma: PrismaService, ctx: AdsLoadContext): Promise<{ records: PortfolioRecord[]; truncated: boolean }> {
  const found = await prisma.adsPortfolio.findMany({
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope) },
    select: PORTFOLIO_SELECT,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: ADS_PORTFOLIO_ROW_LIMIT + 1,
  })
  return { records: found.slice(0, ADS_PORTFOLIO_ROW_LIMIT), truncated: found.length > ADS_PORTFOLIO_ROW_LIMIT }
}

export const CAMPAIGN_FIELDS = {
  id: true,
  adsProfileId: true,
  adProduct: true,
  externalCampaignId: true,
  portfolioId: true,
  name: true,
  state: true,
  servingStatus: true,
  budget: true,
  budgetType: true,
  currency: true,
} satisfies Prisma.AdsCampaignSelect
export type PortfolioCampaign = Prisma.AdsCampaignGetPayload<{ select: typeof CAMPAIGN_FIELDS }> & { portfolioId: string }

/** 这些广告档案下归属任一广告组合的活动（最多 ADS_CAMPAIGN_ROW_LIMIT 个）；`portfolioIds` 给出时只取这些组合的活动。 */
export async function loadPortfolioCampaigns(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  profileIds: readonly string[],
  portfolioIds?: readonly string[],
): Promise<{ campaigns: PortfolioCampaign[]; truncated: boolean }> {
  if (profileIds.length === 0) return { campaigns: [], truncated: false }
  const found = await prisma.adsCampaign.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...adsRelationWhere(ctx.scope),
      adsProfileId: { in: [...new Set(profileIds)] },
      portfolioId: portfolioIds ? { in: [...new Set(portfolioIds)] } : { not: null },
    },
    select: CAMPAIGN_FIELDS,
    orderBy: [{ id: 'asc' }],
    take: ADS_CAMPAIGN_ROW_LIMIT + 1,
  })
  const campaigns = found.slice(0, ADS_CAMPAIGN_ROW_LIMIT).flatMap(item => (item.portfolioId ? [{ ...item, portfolioId: item.portfolioId }] : []))
  return { campaigns, truncated: found.length > ADS_CAMPAIGN_ROW_LIMIT }
}

const campaignFilter = (campaigns: readonly PortfolioCampaign[]): Prisma.AdsDailySummaryWhereInput => ({
  adsProfileId: { in: [...new Set(campaigns.map(item => item.adsProfileId))] },
  campaignId: { in: [...new Set(campaigns.map(item => item.externalCampaignId))] },
})

/** 范围内每个活动的合计（美元）；键是 campaignKey。没有活动编号的账户级行不读；多读一行判断是否截断。 */
export async function campaignRangeTotals(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  campaigns: readonly PortfolioCampaign[],
  from: string,
  to: string,
): Promise<{ byCampaign: Map<string, AdsTotals>; truncated: boolean }> {
  if (campaigns.length === 0 || to < from) return { byCampaign: new Map(), truncated: false }
  const groups = await prisma.adsDailySummary.groupBy({
    by: ['adsProfileId', 'adProduct', 'campaignId'],
    where: summaryWhere(ctx, from, to, { ...campaignFilter(campaigns), spend: { not: null } }),
    _sum: { impressions: true, clicks: true, spend: true, sales: true, orders: true },
    orderBy: [{ adsProfileId: 'asc' }, { adProduct: 'asc' }, { campaignId: 'asc' }],
    take: HARD_LIMIT + 1,
  })
  const byCampaign = new Map(groups.slice(0, HARD_LIMIT).map(group => [campaignKey(group.adsProfileId, group.adProduct, group.campaignId), totalsOf(group._sum)]))
  return { byCampaign, truncated: groups.length > HARD_LIMIT }
}

export interface DailySpend {
  adsProfileId: string
  adProduct: string
  campaignId: string
  date: string
  spend: number
}

/** 范围内活动逐日花费（美元，花费不为空的行）：用来画曲线与算历史节奏。多读一行判断是否截断。 */
export async function campaignDailySpend(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  campaigns: readonly PortfolioCampaign[],
  from: string,
  to: string,
): Promise<{ rows: DailySpend[]; truncated: boolean }> {
  if (campaigns.length === 0 || to < from) return { rows: [], truncated: false }
  const groups = await prisma.adsDailySummary.groupBy({
    by: ['adsProfileId', 'adProduct', 'campaignId', 'summaryDate'],
    where: summaryWhere(ctx, from, to, { ...campaignFilter(campaigns), spend: { not: null } }),
    _sum: { spend: true },
    orderBy: [{ adsProfileId: 'asc' }, { adProduct: 'asc' }, { campaignId: 'asc' }, { summaryDate: 'asc' }],
    take: HARD_LIMIT + 1,
  })
  const rows = groups.slice(0, HARD_LIMIT).map(group => ({
    adsProfileId: group.adsProfileId,
    adProduct: group.adProduct,
    campaignId: group.campaignId,
    date: dateText(group.summaryDate),
    spend: num(group._sum.spend) ?? 0,
  }))
  return { rows, truncated: groups.length > HARD_LIMIT }
}

/** 历史节奏的回看窗口：最近 historyDays 天，到昨天为止。 */
export const historyWindow = (today: string): { from: string; to: string } => ({ from: addDays(today, -ADS_PORTFOLIO_PACE_RULES.historyDays), to: addDays(today, -1) })

/** 这些档案下的预算规则（功能开关打开时才读）；按活动编号与规则类型排序，最多 ADS_PORTFOLIO_RULE_LIMIT 条。 */
export async function loadBudgetRules(prisma: PrismaService, ctx: AdsLoadContext, adsProfileId: string, campaignIds: readonly string[]) {
  if (campaignIds.length === 0) return []
  return prisma.adsBudgetRule.findMany({
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), adsProfileId, campaignId: { in: [...new Set(campaignIds)] } },
    select: { id: true, campaignId: true, ruleType: true, status: true, paramsJson: true, syncedAt: true },
    orderBy: [{ campaignId: 'asc' }, { ruleType: 'asc' }],
    take: ADS_PORTFOLIO_RULE_LIMIT,
  })
}
