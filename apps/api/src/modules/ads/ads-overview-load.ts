import type { Prisma } from '@prisma/client'
import { ADS_CAMPAIGN_ROW_LIMIT, ADS_CONSOLE_CURRENCY, type AdsTotals } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, storeWhere, type ResolvedScope } from '../auth'
import { addDays, asDate, dateText, localDate } from '../overview'

// 广告控制台的数据读取（P3-05）：广告日汇总、店铺经营日汇总、活动预算与名称、事件。
// 全部在数据库里聚合，只取聚合结果；租户条件与数据范围显式带上，行级安全同时生效。
// 广告汇总只取美元行（店铺经营日汇总只有美元，不同币种不直接相加）。

export interface AdsLoadContext {
  tenantId: string
  scope: ResolvedScope
}

type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

const SUMS = { impressions: true, clicks: true, spend: true, sales: true, orders: true } as const
export type AdsSums = { impressions: number | null; clicks: number | null; spend: Dec; sales: Dec; orders: number | null }
export const totalsOf = (sum: AdsSums): AdsTotals => ({ impressions: sum.impressions ?? 0, clicks: sum.clicks ?? 0, spend: num(sum.spend), sales: num(sum.sales), orders: sum.orders ?? 0 })

export const summaryWhere = (ctx: AdsLoadContext, from: string, to: string, extra: Prisma.AdsDailySummaryWhereInput = {}): Prisma.AdsDailySummaryWhereInput => ({
  tenantId: ctx.tenantId,
  ...adsRelationWhere(ctx.scope),
  currency: ADS_CONSOLE_CURRENCY,
  summaryDate: { gte: asDate(from), lte: asDate(to) },
  ...extra,
})

export interface DailyAds {
  date: string
  adProduct: string
  totals: AdsTotals
}
/** 逐日 × 广告产品合计（美元）。 */
export async function dailyByProduct(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<DailyAds[]> {
  const groups = await prisma.adsDailySummary.groupBy({
    by: ['summaryDate', 'adProduct'],
    where: summaryWhere(ctx, from, to),
    _sum: SUMS,
    orderBy: [{ summaryDate: 'asc' }, { adProduct: 'asc' }],
    take: 20_000,
  })
  return groups.map(group => ({ date: dateText(group.summaryDate), adProduct: group.adProduct, totals: totalsOf(group._sum) }))
}

/** 范围内的合计与是否有行；没有行时合计为全空。 */
export async function adsTotals(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<{ totals: AdsTotals; hasRows: boolean }> {
  const result = await prisma.adsDailySummary.aggregate({ where: summaryWhere(ctx, from, to), _sum: SUMS, _count: { _all: true } })
  return { totals: totalsOf(result._sum), hasRows: result._count._all > 0 }
}

/** 可见范围内是否出现过任何广告日汇总（任何日期、任何币种）：区分“尚未接入”与“所选范围没有记录”。 */
export async function everHadAdsData(prisma: PrismaService, ctx: AdsLoadContext): Promise<boolean> {
  const row = await prisma.adsDailySummary.findFirst({ where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope) }, select: { id: true } })
  return row !== null
}

export async function refreshInfo(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string) {
  const row = await prisma.adsDailySummary.findFirst({ where: summaryWhere(ctx, from, to), orderBy: { refreshedAt: 'desc' }, select: { refreshedAt: true, metricVersion: true } })
  return row ? { refreshedAt: row.refreshedAt.toISOString(), metricVersion: row.metricVersion } : null
}

/** 范围内没有并入的其他币种花费（不折算）。 */
export async function otherCurrencies(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<Array<{ currency: string; spend: number | null }>> {
  const groups = await prisma.adsDailySummary.groupBy({
    by: ['currency'],
    where: { ...summaryWhere(ctx, from, to), currency: { not: ADS_CONSOLE_CURRENCY } },
    _sum: { spend: true },
    orderBy: { currency: 'asc' },
    take: 20,
  })
  return groups.map(group => ({ currency: group.currency, spend: num(group._sum.spend) }))
}

/** 未绑定店铺的广告账户的美元花费：未绑定的账户只有“全部店铺”范围的成员看得到，受限成员直接返回 null。 */
export async function unboundSpend(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<number | null> {
  if (!ctx.scope.unrestricted) return null
  const result = await prisma.adsDailySummary.aggregate({ where: summaryWhere(ctx, from, to, { adsProfile: { sellerAccountId: null } }), _sum: { spend: true } })
  return num(result._sum.spend)
}

export interface CampaignRow {
  key: string
  adsProfileId: string
  adProduct: string
  campaignId: string
  totals: AdsTotals
}
export const campaignKey = (adsProfileId: string, adProduct: string, campaignId: string) => `${adsProfileId}|${adProduct}|${campaignId}`

/** 活动级合计，按花费从高到低；最多 ADS_CAMPAIGN_ROW_LIMIT 个，超过标记截断。没有活动编号的账户级行不在其中。 */
export async function campaignTotals(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<{ rows: CampaignRow[]; truncated: boolean }> {
  const groups = await prisma.adsDailySummary.groupBy({
    by: ['adsProfileId', 'adProduct', 'campaignId'],
    where: summaryWhere(ctx, from, to, { campaignId: { not: '' }, spend: { not: null } }),
    _sum: SUMS,
    orderBy: [{ _sum: { spend: 'desc' } }, { campaignId: 'asc' }, { adsProfileId: 'asc' }, { adProduct: 'asc' }],
    take: ADS_CAMPAIGN_ROW_LIMIT + 1,
  })
  const rows = groups.slice(0, ADS_CAMPAIGN_ROW_LIMIT).map(group => ({
    key: campaignKey(group.adsProfileId, group.adProduct, group.campaignId),
    adsProfileId: group.adsProfileId,
    adProduct: group.adProduct,
    campaignId: group.campaignId,
    totals: totalsOf(group._sum),
  }))
  return { rows, truncated: groups.length > ADS_CAMPAIGN_ROW_LIMIT }
}

export interface StoreDay {
  sales: number
  adsSpend: number | null
  adsSales: number | null
}
const STORE_SUMS = { salesAmount: true, adsSpend: true, adsSales: true } as const
const storeWhereOf = (ctx: AdsLoadContext, from: string, to: string): Prisma.StoreDailySummaryWhereInput => ({
  tenantId: ctx.tenantId,
  ...storeWhere(ctx.scope),
  summaryDate: { gte: asDate(from), lte: asDate(to) },
})
const storeDay = (sum: { salesAmount: Dec; adsSpend: Dec; adsSales: Dec }): StoreDay => ({ sales: num(sum.salesAmount) ?? 0, adsSpend: num(sum.adsSpend), adsSales: num(sum.adsSales) })

/** 店铺经营日汇总：逐日合计（范围内全部店铺）。 */
export async function storeDaily(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<Map<string, StoreDay>> {
  const groups = await prisma.storeDailySummary.groupBy({ by: ['summaryDate'], where: storeWhereOf(ctx, from, to), _sum: STORE_SUMS, orderBy: { summaryDate: 'asc' }, take: 20_000 })
  return new Map(groups.map(group => [dateText(group.summaryDate), storeDay(group._sum)]))
}

export async function storeTotals(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<{ day: StoreDay; hasRows: boolean }> {
  const result = await prisma.storeDailySummary.aggregate({ where: storeWhereOf(ctx, from, to), _sum: STORE_SUMS, _count: { _all: true } })
  return { day: storeDay(result._sum), hasRows: result._count._all > 0 }
}

export interface BudgetCampaign {
  key: string
  dailyBudget: number
  startDate: string | null
  endDate: string | null
}
const campaignScope = (ctx: AdsLoadContext): Prisma.AdsCampaignWhereInput => ({ tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), currency: ADS_CONSOLE_CURRENCY })

/** 启用中、带“日预算”的美元活动（预算类型未同步的活动无法判断是日预算还是总预算，不计入，只统计个数）。 */
export async function budgetedCampaigns(prisma: PrismaService, ctx: AdsLoadContext): Promise<{ campaigns: BudgetCampaign[]; unknownType: number; truncated: boolean }> {
  const [rows, unknownType] = await Promise.all([
    prisma.adsCampaign.findMany({
      where: { ...campaignScope(ctx), budget: { gt: 0 }, budgetType: 'DAILY', state: { equals: 'ENABLED', mode: 'insensitive' } },
      select: { adsProfileId: true, adProduct: true, externalCampaignId: true, budget: true, startDate: true, endDate: true },
      orderBy: [{ id: 'asc' }],
      take: ADS_CAMPAIGN_ROW_LIMIT + 1,
    }),
    prisma.adsCampaign.count({ where: { ...campaignScope(ctx), budget: { gt: 0 }, budgetType: null } }),
  ])
  const campaigns = rows.slice(0, ADS_CAMPAIGN_ROW_LIMIT).map(row => ({
    key: campaignKey(row.adsProfileId, row.adProduct, row.externalCampaignId),
    dailyBudget: num(row.budget) ?? 0,
    startDate: row.startDate ? dateText(row.startDate) : null,
    endDate: row.endDate ? dateText(row.endDate) : null,
  }))
  return { campaigns, unknownType, truncated: rows.length > ADS_CAMPAIGN_ROW_LIMIT }
}

/** 活动名称（活动管理接口同步的）；没有记录的活动编号不在结果里。 */
export async function campaignNames(prisma: PrismaService, ctx: AdsLoadContext, rows: ReadonlyArray<{ adsProfileId: string; adProduct: string; campaignId: string }>): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map()
  const found = await prisma.adsCampaign.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...adsRelationWhere(ctx.scope),
      adsProfileId: { in: [...new Set(rows.map(row => row.adsProfileId))] },
      externalCampaignId: { in: [...new Set(rows.map(row => row.campaignId))] },
    },
    select: { adsProfileId: true, adProduct: true, externalCampaignId: true, name: true },
    orderBy: [{ id: 'asc' }],
    take: 5000,
  })
  return new Map(found.map(row => [campaignKey(row.adsProfileId, row.adProduct, row.externalCampaignId), row.name]))
}

const EVENT_LIMIT = 200
/** 事件标注：范围内的实体事件（不含工作项），按企业时区落日。事件时间是 UTC 时刻，查询两端各放宽一天后再落日。 */
export async function trendEvents(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string, timeZone: string) {
  const rows = await prisma.entityEvent.findMany({
    where: {
      tenantId: ctx.tenantId,
      entityType: { not: 'WORK_ITEM' },
      occurredAt: { gte: asDate(addDays(from, -1)), lt: asDate(addDays(to, 2)) },
      ...(ctx.scope.unrestricted ? {} : { OR: [{ sellerAccountId: null }, { sellerAccountId: { in: ctx.scope.sellerAccountIds } }] }),
    },
    select: { occurredAt: true, title: true, kind: true },
    orderBy: { occurredAt: 'asc' },
    take: EVENT_LIMIT,
  })
  return rows.map(row => ({ date: localDate(row.occurredAt, timeZone), label: row.title, kind: row.kind })).filter(event => event.date >= from && event.date <= to)
}
