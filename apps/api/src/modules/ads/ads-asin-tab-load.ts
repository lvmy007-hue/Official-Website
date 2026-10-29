import type { Prisma } from '@prisma/client'
import { ADS_CONSOLE_CURRENCY, ASIN360_ADS_READ_LIMIT, type AdsEntityMetrics, type AdsTotals } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { asDate, dateText } from '../overview'
import { entityMetricMap } from './ads-campaigns-load'
import { totalsOf, type AdsLoadContext } from './ads-overview-load'
import { groupKey, type AdGroupRecord, type CampaignGroup, type CampaignRecord } from './ads-asin-tab-math'

// ASIN 360 广告页签的数据读取（P3-19）：全部在数据库里聚合，只取聚合结果；租户条件与店铺（经广告档案绑定）显式带上，行级安全同时生效。
// 只取美元；一个商品 = 一个店铺 × 一个 ASIN，店铺下可以有多个广告档案（不同站点），所以带 profileIds。

const HARD_LIMIT = 19_999
const DAY_ROWS_LIMIT = 1200

export interface AsinTarget {
  storeId: string
  asin: string
  /** 绑定到这个店铺的广告档案；没有绑定任何档案时为空数组，整页“尚未接入”。 */
  profileIds: readonly string[]
}

const inProfiles = (target: AsinTarget) => ({ in: [...target.profileIds] })

/** 绑定到这个店铺的广告档案（范围内未绑定的档案不算）。 */
export async function storeProfileIds(prisma: PrismaService, ctx: AdsLoadContext, storeId: string): Promise<string[]> {
  const found = await prisma.adsProfile.findMany({ where: { tenantId: ctx.tenantId, sellerAccountId: storeId }, select: { id: true }, orderBy: { id: 'asc' }, take: 200 })
  return found.map(row => row.id)
}

const reportWhere = (ctx: AdsLoadContext, target: AsinTarget, from: string, to: string): Prisma.AdsAdvertisedProductMetricWhereInput => ({
  tenantId: ctx.tenantId,
  adsProfileId: inProfiles(target),
  advertisedAsin: target.asin,
  currency: ADS_CONSOLE_CURRENCY,
  reportDate: { gte: asDate(from), lte: asDate(to) },
  spend: { not: null },
})

const SUMS = { impressions: true, clicks: true, spend: true, sales: true, orders: true } as const

/** 被推广商品日报表按日合计（这个 ASIN，所有活动）。花费为空的行不读：那是来源没给。 */
export async function advertisedDaily(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget, from: string, to: string): Promise<Map<string, AdsTotals>> {
  const found = await prisma.adsAdvertisedProductMetric.groupBy({ by: ['reportDate'], where: reportWhere(ctx, target, from, to), _sum: SUMS, orderBy: { reportDate: 'asc' }, take: DAY_ROWS_LIMIT })
  return new Map(found.map(group => [dateText(group.reportDate), totalsOf(group._sum)]))
}

/** 范围内推广这个 ASIN 的活动合计（按花费从高到低）；多读一行判断是否截断。 */
export async function advertisedCampaigns(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget, from: string, to: string): Promise<{ groups: CampaignGroup[]; truncated: boolean }> {
  const found = await prisma.adsAdvertisedProductMetric.groupBy({
    by: ['adsProfileId', 'campaignId'],
    where: reportWhere(ctx, target, from, to),
    _sum: SUMS,
    orderBy: [{ _sum: { spend: 'desc' } }, { adsProfileId: 'asc' }, { campaignId: 'asc' }],
    take: ASIN360_ADS_READ_LIMIT + 1,
  })
  return {
    groups: found.slice(0, ASIN360_ADS_READ_LIMIT).map(group => ({ adsProfileId: group.adsProfileId, campaignId: group.campaignId, totals: totalsOf(group._sum) })),
    truncated: found.length > ASIN360_ADS_READ_LIMIT,
  }
}

/** 范围内是否有非美元的行（不并入，只披露）；这些档案是否同步过任何被推广商品行（区分“尚未接入”与“范围内没有”）。 */
export async function reportPresence(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget, from: string, to: string): Promise<{ otherCurrency: boolean; everSynced: boolean }> {
  const [other, ever] = await Promise.all([
    prisma.adsAdvertisedProductMetric.findFirst({
      where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target), advertisedAsin: target.asin, currency: { not: ADS_CONSOLE_CURRENCY }, reportDate: { gte: asDate(from), lte: asDate(to) } },
      select: { id: true },
    }),
    prisma.adsAdvertisedProductMetric.findFirst({ where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target) }, select: { id: true } }),
  ])
  return { otherCurrency: other !== null, everSynced: ever !== null }
}

/** 这个 ASIN 每天的全部销售额（ASIN 日汇总，美元）；没有汇总行的日子不在结果里。 */
export async function dailyTotalSales(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget, from: string, to: string): Promise<Map<string, number>> {
  const found = await prisma.asinDailySummary.groupBy({
    by: ['summaryDate'],
    where: { tenantId: ctx.tenantId, sellerAccountId: target.storeId, asin: target.asin, currency: ADS_CONSOLE_CURRENCY, summaryDate: { gte: asDate(from), lte: asDate(to) } },
    _sum: { salesAmount: true },
    orderBy: { summaryDate: 'asc' },
    take: DAY_ROWS_LIMIT,
  })
  return new Map(found.map(group => [dateText(group.summaryDate), group._sum.salesAmount === null ? 0 : Number(group._sum.salesAmount.toString())]))
}

/** 转化商品日报表是否在这些档案里出现过任何行：区分光环销售的“尚未接入”与“这个商品没有”。 */
export async function convertedEver(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget): Promise<boolean> {
  const row = await prisma.adsConvertedProductDaily.findFirst({ where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target) }, select: { id: true } })
  return row !== null
}

export interface AsinAdLink {
  adsProfileId: string
  adGroupId: string
  enabled: number
  total: number
}

/** 广告表里关联这个 ASIN 的广告，按“档案 × 广告组”合计（在投 = 状态 ENABLED，不分大小写）。 */
export async function asinAdLinks(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget): Promise<AsinAdLink[]> {
  const found = await prisma.adsAd.groupBy({
    by: ['adsProfileId', 'adGroupId', 'state'],
    where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target), asin: target.asin },
    _count: { _all: true },
    orderBy: [{ adsProfileId: 'asc' }, { adGroupId: 'asc' }, { state: 'asc' }],
    take: HARD_LIMIT,
  })
  const merged = new Map<string, AsinAdLink>()
  for (const group of found) {
    const key = groupKey(group.adsProfileId, group.adGroupId)
    const held = merged.get(key) ?? { adsProfileId: group.adsProfileId, adGroupId: group.adGroupId, enabled: 0, total: 0 }
    held.total += group._count._all
    if (group.state.toUpperCase() === 'ENABLED') held.enabled += group._count._all
    merged.set(key, held)
  }
  return [...merged.values()]
}

/** 这些档案的广告表是否出现过任何行：区分“广告实体尚未同步”与“这个 ASIN 没有广告”。 */
export async function adsEver(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget): Promise<boolean> {
  const row = await prisma.adsAd.findFirst({ where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target) }, select: { id: true } })
  return row !== null
}

/** 每个广告组里推广了几个不同的 ASIN（含本商品）；广告表没给 ASIN 的广告不计。键是 `档案|广告组`。 */
export async function groupAsinCounts(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget, links: readonly AsinAdLink[]): Promise<Map<string, number>> {
  if (links.length === 0) return new Map()
  const wanted = new Set(links.map(link => groupKey(link.adsProfileId, link.adGroupId)))
  const found = await prisma.adsAd.groupBy({
    by: ['adsProfileId', 'adGroupId', 'asin'],
    where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target), adGroupId: { in: [...new Set(links.map(link => link.adGroupId))] }, asin: { not: null } },
    orderBy: [{ adsProfileId: 'asc' }, { adGroupId: 'asc' }, { asin: 'asc' }],
    take: HARD_LIMIT,
  })
  const counts = new Map<string, number>()
  for (const group of found) {
    const key = groupKey(group.adsProfileId, group.adGroupId)
    if (wanted.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** 广告组记录（只留“档案 × 广告组”精确对上的，查询里的 in 条件会有跨档案的多余命中）。 */
export async function adGroupRecords(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget, links: readonly AsinAdLink[]): Promise<{ records: AdGroupRecord[]; truncated: boolean }> {
  if (links.length === 0) return { records: [], truncated: false }
  const wanted = new Set(links.map(link => groupKey(link.adsProfileId, link.adGroupId)))
  const found = await prisma.adsAdGroup.findMany({
    where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target), adGroupId: { in: [...new Set(links.map(link => link.adGroupId))] } },
    select: { id: true, adsProfileId: true, adGroupId: true, campaignId: true, name: true, state: true, defaultBid: true },
    orderBy: [{ name: 'asc' }, { adGroupId: 'asc' }],
    take: ASIN360_ADS_READ_LIMIT + 1,
  })
  const records = found
    .slice(0, ASIN360_ADS_READ_LIMIT)
    .filter(row => wanted.has(groupKey(row.adsProfileId, row.adGroupId)))
    .map((row): AdGroupRecord => ({ ...row, defaultBid: row.defaultBid === null ? null : Number(row.defaultBid.toString()) }))
  return { records, truncated: found.length > ASIN360_ADS_READ_LIMIT }
}

/** 本地活动记录（名称、状态、系统编号）；活动还没有同步下来的没有记录。 */
export async function campaignRecordsOf(prisma: PrismaService, ctx: AdsLoadContext, target: AsinTarget, externalIds: readonly string[]): Promise<CampaignRecord[]> {
  if (externalIds.length === 0) return []
  return prisma.adsCampaign.findMany({
    where: { tenantId: ctx.tenantId, adsProfileId: inProfiles(target), externalCampaignId: { in: [...new Set(externalIds)] } },
    select: { id: true, adsProfileId: true, externalCampaignId: true, adProduct: true, name: true, state: true },
    orderBy: [{ adProduct: 'asc' }, { externalCampaignId: 'asc' }],
    take: ASIN360_ADS_READ_LIMIT * 2,
  })
}

/** 广告组自己的指标合计（指标表按对象类型存放）；按档案分别读。键是 `档案|广告组`。 */
export async function adGroupMetrics(prisma: PrismaService, ctx: AdsLoadContext, records: readonly AdGroupRecord[], from: string, to: string): Promise<Map<string, AdsEntityMetrics>> {
  const byProfile = new Map<string, string[]>()
  for (const record of records) byProfile.set(record.adsProfileId, [...(byProfile.get(record.adsProfileId) ?? []), record.adGroupId])
  const parts = await Promise.all(
    [...byProfile.entries()].map(async ([adsProfileId, entityIds]) => {
      const found = await entityMetricMap(prisma, ctx, { ref: { adsProfileId, currency: ADS_CONSOLE_CURRENCY, adProduct: null }, entityTypes: ['AD_GROUP'], entityIds, from, to })
      return [...found.entries()].map(([entityId, metrics]): [string, AdsEntityMetrics] => [groupKey(adsProfileId, entityId), metrics])
    }),
  )
  return new Map(parts.flat())
}
