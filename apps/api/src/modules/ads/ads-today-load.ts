import type { Prisma } from '@prisma/client'
import { ADS_CONSOLE_CURRENCY, ADS_TODAY_ROW_LIMIT, type AdsTotals } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsProfileWhere, adsRelationWhere } from '../auth'
import { asDate, dateText } from '../overview'
import { summaryWhere, totalsOf, type AdsLoadContext } from './ads-overview-load'

// 今日广告的数据读取（P3-06）：营销数据流的小时指标、活动预算与投放状态、被推广商品、库存快照。
// 全部在数据库里聚合，只取聚合结果；租户条件与数据范围显式带上，行级安全同时生效；金额只取美元。

type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

const SUMS = { impressions: true, clicks: true, spend: true, sales: true, orders: true } as const
const HARD_LIMIT = 20_000

/** 活动级小时指标（不含广告组、广告、投放对象，避免同一笔花费被不同层级重复计数）。 */
const hourlyWhere = (ctx: AdsLoadContext, from: Date, to: Date, extra: Prisma.AdsPerformanceHourlyWhereInput = {}): Prisma.AdsPerformanceHourlyWhereInput => ({
  tenantId: ctx.tenantId,
  ...adsRelationWhere(ctx.scope),
  entityType: 'CAMPAIGN',
  currency: ADS_CONSOLE_CURRENCY,
  hourStart: { gte: from, lt: to },
  ...extra,
})

/** 逐小时合计（美元），键是小时起点的 ISO 文本。 */
export async function hourlyByHour(prisma: PrismaService, ctx: AdsLoadContext, from: Date, to: Date): Promise<Map<string, AdsTotals>> {
  const groups = await prisma.adsPerformanceHourly.groupBy({ by: ['hourStart'], where: hourlyWhere(ctx, from, to), _sum: SUMS, orderBy: { hourStart: 'asc' }, take: HARD_LIMIT })
  return new Map(groups.map(group => [group.hourStart.toISOString(), totalsOf(group._sum)]))
}

export const campaignKeyOf = (adsProfileId: string, campaignId: string) => `${adsProfileId}|${campaignId}`

/** 活动级合计（美元），按花费从高到低最多 ADS_TODAY_ROW_LIMIT 个；超过标记截断。小时指标的对象编号就是活动编号。 */
export async function campaignSums(prisma: PrismaService, ctx: AdsLoadContext, from: Date, to: Date): Promise<{ rows: Map<string, AdsTotals>; truncated: boolean }> {
  const groups = await prisma.adsPerformanceHourly.groupBy({
    by: ['adsProfileId', 'entityId'],
    where: hourlyWhere(ctx, from, to, { spend: { not: null } }),
    _sum: SUMS,
    orderBy: [{ _sum: { spend: 'desc' } }, { entityId: 'asc' }, { adsProfileId: 'asc' }],
    take: ADS_TODAY_ROW_LIMIT + 1,
  })
  const rows = new Map(groups.slice(0, ADS_TODAY_ROW_LIMIT).map(group => [campaignKeyOf(group.adsProfileId, group.entityId), totalsOf(group._sum)]))
  return { rows, truncated: groups.length > ADS_TODAY_ROW_LIMIT }
}

/** 范围内小时指标最近一次来源更新时刻。 */
export async function latestHourlyUpdate(prisma: PrismaService, ctx: AdsLoadContext, from: Date, to: Date): Promise<string | null> {
  const result = await prisma.adsPerformanceHourly.aggregate({ where: hourlyWhere(ctx, from, to), _max: { sourceUpdatedAt: true } })
  return result._max.sourceUpdatedAt ? result._max.sourceUpdatedAt.toISOString() : null
}

/** 今日小时指标里没有并入的其他币种花费（不折算）。 */
export async function hourlyOtherCurrencies(prisma: PrismaService, ctx: AdsLoadContext, from: Date, to: Date): Promise<Array<{ currency: string; spend: number | null }>> {
  const groups = await prisma.adsPerformanceHourly.groupBy({
    by: ['currency'],
    where: hourlyWhere(ctx, from, to, { currency: { not: ADS_CONSOLE_CURRENCY } }),
    _sum: { spend: true },
    orderBy: { currency: 'asc' },
    take: 20,
  })
  return groups.map(group => ({ currency: group.currency, spend: num(group._sum.spend) }))
}

/** 最近一天的广告日汇总（不晚于 upTo）与它的合计，退化展示用；没有任何汇总返回 null。 */
export async function latestSummaryDay(prisma: PrismaService, ctx: AdsLoadContext, upTo: string): Promise<{ summaryDate: string; totals: AdsTotals; refreshedAt: string | null } | null> {
  const latest = await prisma.adsDailySummary.findFirst({ where: summaryWhere(ctx, '1970-01-01', upTo), orderBy: { summaryDate: 'desc' }, select: { summaryDate: true } })
  if (!latest) return null
  const day = dateText(latest.summaryDate)
  const [sum, info] = await Promise.all([
    prisma.adsDailySummary.aggregate({ where: summaryWhere(ctx, day, day), _sum: SUMS }),
    prisma.adsDailySummary.findFirst({ where: summaryWhere(ctx, day, day), orderBy: { refreshedAt: 'desc' }, select: { refreshedAt: true } }),
  ])
  return { summaryDate: day, totals: totalsOf(sum._sum), refreshedAt: info ? info.refreshedAt.toISOString() : null }
}

export interface BudgetCampaignRow {
  adsProfileId: string
  campaignId: string
  adProduct: string
  name: string
  dailyBudget: number
}
const campaignScope = (ctx: AdsLoadContext): Prisma.AdsCampaignWhereInput => ({ tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), currency: ADS_CONSOLE_CURRENCY })

/** 启用中、日预算的美元活动（预算类型没同步的活动无法判断是不是日预算，不计入）。 */
export async function budgetCampaigns(prisma: PrismaService, ctx: AdsLoadContext): Promise<{ rows: BudgetCampaignRow[]; truncated: boolean }> {
  const found = await prisma.adsCampaign.findMany({
    where: { ...campaignScope(ctx), budget: { gt: 0 }, budgetType: 'DAILY', state: { equals: 'ENABLED', mode: 'insensitive' } },
    select: { adsProfileId: true, externalCampaignId: true, adProduct: true, name: true, budget: true },
    orderBy: [{ id: 'asc' }],
    take: ADS_TODAY_ROW_LIMIT + 1,
  })
  const rows = found.slice(0, ADS_TODAY_ROW_LIMIT).map(row => ({
    adsProfileId: row.adsProfileId,
    campaignId: row.externalCampaignId,
    adProduct: row.adProduct,
    name: row.name,
    dailyBudget: num(row.budget) ?? 0,
  }))
  return { rows, truncated: found.length > ADS_TODAY_ROW_LIMIT }
}

export interface OutOfBudgetRow {
  adsProfileId: string
  campaignId: string
  adProduct: string
  name: string
  servingStatus: string
}
/** 活动管理接口的投放状态带“预算用完”的启用中活动，与已经同步过投放状态的活动个数（个数为 0 说明投放状态从没同步过）。 */
export async function outOfBudgetCampaigns(prisma: PrismaService, ctx: AdsLoadContext, limit: number): Promise<{ rows: OutOfBudgetRow[]; total: number; withStatus: number }> {
  const enabled = { ...campaignScope(ctx), state: { equals: 'ENABLED', mode: 'insensitive' as const } }
  const outOfBudget = { ...enabled, servingStatus: { contains: 'OUT_OF_BUDGET', mode: 'insensitive' as const } }
  const [found, total, withStatus] = await Promise.all([
    prisma.adsCampaign.findMany({
      where: outOfBudget,
      select: { adsProfileId: true, externalCampaignId: true, adProduct: true, name: true, servingStatus: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit,
    }),
    prisma.adsCampaign.count({ where: outOfBudget }),
    prisma.adsCampaign.count({ where: { ...enabled, servingStatus: { not: null } } }),
  ])
  const rows = found.map(row => ({ adsProfileId: row.adsProfileId, campaignId: row.externalCampaignId, adProduct: row.adProduct, name: row.name, servingStatus: row.servingStatus ?? '' }))
  return { rows, total, withStatus }
}

/** 活动名称（活动管理接口同步的）；键是 档案|活动编号，没有记录的活动不在结果里。 */
export async function campaignNameMap(prisma: PrismaService, ctx: AdsLoadContext, rows: ReadonlyArray<{ adsProfileId: string; campaignId: string }>): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map()
  const found = await prisma.adsCampaign.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...adsRelationWhere(ctx.scope),
      adsProfileId: { in: [...new Set(rows.map(row => row.adsProfileId))] },
      externalCampaignId: { in: [...new Set(rows.map(row => row.campaignId))] },
    },
    select: { adsProfileId: true, externalCampaignId: true, name: true },
    orderBy: [{ id: 'asc' }],
    take: 5000,
  })
  return new Map(found.map(row => [campaignKeyOf(row.adsProfileId, row.externalCampaignId), row.name]))
}

export interface AdvertisedDay {
  adsProfileId: string
  asin: string
  date: string
  spend: number
}
/** 回看期内每个 档案 × 被推广 ASIN × 日 的花费（美元，花费大于 0）；是否可能被读取上限截断一并返回。 */
export async function advertisedSpend(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<{ rows: AdvertisedDay[]; truncated: boolean }> {
  const groups = await prisma.adsAdvertisedProductMetric.groupBy({
    by: ['adsProfileId', 'advertisedAsin', 'reportDate'],
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), currency: ADS_CONSOLE_CURRENCY, reportDate: { gte: asDate(from), lte: asDate(to) }, spend: { gt: 0 } },
    _sum: { spend: true },
    orderBy: [{ reportDate: 'asc' }, { adsProfileId: 'asc' }, { advertisedAsin: 'asc' }],
    take: HARD_LIMIT,
  })
  const rows = groups.map(group => ({ adsProfileId: group.adsProfileId, asin: group.advertisedAsin, date: dateText(group.reportDate), spend: num(group._sum.spend) ?? 0 }))
  return { rows, truncated: groups.length >= HARD_LIMIT }
}

/** 可见范围内是否出现过任何被推广商品日报表行：区分“尚未接入”与“回看期没有记录”。 */
export async function everAdvertised(prisma: PrismaService, ctx: AdsLoadContext): Promise<boolean> {
  const row = await prisma.adsAdvertisedProductMetric.findFirst({ where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope) }, select: { id: true } })
  return row !== null
}

/** 广告档案对应的店铺（未绑定为 null）。 */
export async function profileStores(prisma: PrismaService, ctx: AdsLoadContext, profileIds: readonly string[]): Promise<Map<string, string | null>> {
  if (profileIds.length === 0) return new Map()
  const found = await prisma.adsProfile.findMany({
    where: { tenantId: ctx.tenantId, id: { in: [...profileIds] }, ...adsProfileWhere(ctx.scope) },
    select: { id: true, sellerAccountId: true },
    take: 5000,
  })
  return new Map(found.map(row => [row.id, row.sellerAccountId]))
}

export interface SnapshotRow {
  sellerAccountId: string
  asin: string
  sellable: number | null
  snapshotDate: string
}
/** 每个店铺最近一次库存快照（接口来源）里这些 ASIN 的可售数量；ASIN 为空的快照行不参与。 */
export async function latestSnapshots(prisma: PrismaService, ctx: AdsLoadContext, storeIds: readonly string[], asins: readonly string[]): Promise<SnapshotRow[]> {
  if (storeIds.length === 0 || asins.length === 0) return []
  const dates = await prisma.inventoryDailySnapshot.groupBy({
    by: ['sellerAccountId'],
    where: { tenantId: ctx.tenantId, source: 'API', sellerAccountId: { in: [...storeIds] } },
    _max: { snapshotDate: true },
    orderBy: { sellerAccountId: 'asc' },
    take: 500,
  })
  const pairs = dates.flatMap(row => (row._max.snapshotDate ? [{ sellerAccountId: row.sellerAccountId, snapshotDate: row._max.snapshotDate }] : []))
  if (pairs.length === 0) return []
  const rows = await prisma.inventoryDailySnapshot.findMany({
    where: { tenantId: ctx.tenantId, source: 'API', asin: { in: [...asins] }, OR: pairs },
    select: { sellerAccountId: true, asin: true, sellable: true, snapshotDate: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { sku: 'asc' }],
    take: HARD_LIMIT,
  })
  return rows.map(row => ({ sellerAccountId: row.sellerAccountId, asin: row.asin, sellable: row.sellable, snapshotDate: dateText(row.snapshotDate) }))
}

export async function storeNames(prisma: PrismaService, ctx: AdsLoadContext, storeIds: readonly string[]): Promise<Map<string, string>> {
  if (storeIds.length === 0) return new Map()
  const found = await prisma.sellerAccount.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...storeIds] } }, select: { id: true, displayName: true }, take: 500 })
  return new Map(found.map(row => [row.id, row.displayName]))
}
