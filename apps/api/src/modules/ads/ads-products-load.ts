import { ADS_ASIN_GROUP_LIMIT, ADS_CONSOLE_CURRENCY, type AdsTotals } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, storeWhere } from '../auth'
import { asDate } from '../overview'
import { num } from './ads-campaigns-common'
import { anyRowInScope } from './ads-campaigns-load'
import type { AdsLoadContext } from './ads-overview-load'
import { latestSnapshots } from './ads-today-load'

// 广告商品页的数据读取（P3-09）：被推广商品日报表、ASIN 日汇总（全部销售额）、转化商品日报表（光环销售）、广告表（在投广告数）、商品资料与库存快照。
// 全部在数据库里聚合，只取聚合结果；租户条件与数据范围显式带上，行级安全同时生效。金额只取美元，不同币种不折算也不相加。

const HARD_LIMIT = 19_999

/** 被推广商品日报表按“广告档案 × ASIN × 活动”分组后的合计。 */
export interface ReportGroup {
  adsProfileId: string
  asin: string
  campaignId: string
  totals: AdsTotals
}

/** 范围内被推广商品的合计（按花费从高到低；花费为空的行不读，那是来源没给）。多读一行判断是否截断。 */
export async function advertisedGroups(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<{ groups: ReportGroup[]; truncated: boolean }> {
  const found = await prisma.adsAdvertisedProductMetric.groupBy({
    by: ['adsProfileId', 'advertisedAsin', 'campaignId'],
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), currency: ADS_CONSOLE_CURRENCY, reportDate: { gte: asDate(from), lte: asDate(to) }, spend: { not: null } },
    _sum: { impressions: true, clicks: true, spend: true, sales: true, orders: true },
    orderBy: [{ _sum: { spend: 'desc' } }, { advertisedAsin: 'asc' }, { adsProfileId: 'asc' }, { campaignId: 'asc' }],
    take: ADS_ASIN_GROUP_LIMIT + 1,
  })
  const groups = found.slice(0, ADS_ASIN_GROUP_LIMIT).map(group => ({
    adsProfileId: group.adsProfileId,
    asin: group.advertisedAsin,
    campaignId: group.campaignId,
    totals: { impressions: group._sum.impressions ?? 0, clicks: group._sum.clicks ?? 0, spend: num(group._sum.spend), sales: num(group._sum.sales), orders: group._sum.orders ?? 0 },
  }))
  return { groups, truncated: found.length > ADS_ASIN_GROUP_LIMIT }
}

/** 范围内是否还有非美元的被推广商品行（不折算、不并入，只在说明里披露）。 */
export async function hasOtherCurrency(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<boolean> {
  const row = await prisma.adsAdvertisedProductMetric.findFirst({
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), currency: { not: ADS_CONSOLE_CURRENCY }, reportDate: { gte: asDate(from), lte: asDate(to) } },
    select: { id: true },
  })
  return row !== null
}

export interface ProfileStore {
  storeId: string | null
  storeName: string | null
}
/** 广告档案对应的店铺（没有绑定店铺为空）。 */
export async function profileStores(prisma: PrismaService, ctx: AdsLoadContext, profileIds: readonly string[]): Promise<Map<string, ProfileStore>> {
  if (profileIds.length === 0) return new Map()
  const found = await prisma.adsProfile.findMany({
    where: { tenantId: ctx.tenantId, ...(ctx.scope.unrestricted ? {} : { sellerAccountId: { in: ctx.scope.sellerAccountIds } }), id: { in: [...new Set(profileIds)] } },
    select: { id: true, sellerAccountId: true, sellerAccount: { select: { displayName: true } } },
    orderBy: { id: 'asc' },
    take: 2000,
  })
  return new Map(found.map(row => [row.id, { storeId: row.sellerAccountId, storeName: row.sellerAccount?.displayName ?? null }]))
}

/** 这些店铺里这些 ASIN 在范围内的全部销售额（ASIN 日汇总，美元）。键是 `店铺|ASIN`；没有汇总行的不在结果里。 */
export async function totalSalesByAsin(prisma: PrismaService, ctx: AdsLoadContext, storeIds: readonly string[], asins: readonly string[], from: string, to: string): Promise<Map<string, number>> {
  if (storeIds.length === 0 || asins.length === 0) return new Map()
  const groups = await prisma.asinDailySummary.groupBy({
    by: ['sellerAccountId', 'asin'],
    where: {
      tenantId: ctx.tenantId,
      ...storeWhere(ctx.scope),
      sellerAccountId: { in: [...storeIds] },
      asin: { in: [...asins] },
      currency: ADS_CONSOLE_CURRENCY,
      summaryDate: { gte: asDate(from), lte: asDate(to) },
    },
    _sum: { salesAmount: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
    take: HARD_LIMIT,
  })
  return new Map(groups.map(group => [`${group.sellerAccountId}|${group.asin}`, num(group._sum.salesAmount) ?? 0]))
}

/** 转化商品日报表里这些被推广 ASIN 的光环销售（购买了别的商品的销售额）。有转化商品行但没有光环行为 0，完全没有转化商品行不在结果里。 */
export async function haloByAsin(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  asins: readonly string[],
  from: string,
  to: string,
  keyOf: (adsProfileId: string, asin: string) => string,
): Promise<Map<string, number>> {
  if (asins.length === 0) return new Map()
  const groups = await prisma.adsConvertedProductDaily.groupBy({
    by: ['adsProfileId', 'advertisedAsin', 'isHalo'],
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), currency: ADS_CONSOLE_CURRENCY, advertisedAsin: { in: [...asins] }, reportDate: { gte: asDate(from), lte: asDate(to) } },
    _sum: { sales: true },
    orderBy: [{ adsProfileId: 'asc' }, { advertisedAsin: 'asc' }, { isHalo: 'asc' }],
    take: HARD_LIMIT,
  })
  const result = new Map<string, number>()
  for (const group of groups) {
    const key = keyOf(group.adsProfileId, group.advertisedAsin)
    result.set(key, (result.get(key) ?? 0) + (group.isHalo ? (num(group._sum.sales) ?? 0) : 0))
  }
  return result
}

/** 转化商品日报表在可见范围内是否出现过任何行：区分“尚未接入”与“这个商品没有”。 */
export const everHadConverted = (prisma: PrismaService, ctx: AdsLoadContext): Promise<boolean> => anyRowInScope(prisma, ctx, 'adsConvertedProductDaily')

/** 广告表里这些 ASIN 的广告数（在投 = 状态 ENABLED，不分大小写）。 */
export async function adCounts(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  asins: readonly string[],
  keyOf: (adsProfileId: string, asin: string) => string,
): Promise<Map<string, { enabled: number; total: number }>> {
  if (asins.length === 0) return new Map()
  const groups = await prisma.adsAd.groupBy({
    by: ['adsProfileId', 'asin', 'state'],
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), asin: { in: [...asins] } },
    _count: { _all: true },
    orderBy: [{ adsProfileId: 'asc' }, { asin: 'asc' }, { state: 'asc' }],
    take: HARD_LIMIT,
  })
  const result = new Map<string, { enabled: number; total: number }>()
  for (const group of groups) {
    if (!group.asin) continue
    const key = keyOf(group.adsProfileId, group.asin)
    const held = result.get(key) ?? { enabled: 0, total: 0 }
    held.total += group._count._all
    if (group.state.toUpperCase() === 'ENABLED') held.enabled += group._count._all
    result.set(key, held)
  }
  return result
}

export interface AsinFact {
  title: string | null
  imageUrl: string | null
  sellable: number | null
  snapshotDate: string | null
}

/** 这些店铺里这些 ASIN 的商品资料与最近一次库存快照的可售数量（同一 ASIN 多个 SKU 的可售数量相加）。键是 `店铺|ASIN`。 */
export async function asinFacts(prisma: PrismaService, ctx: AdsLoadContext, storeIds: readonly string[], asins: readonly string[]): Promise<Map<string, AsinFact>> {
  const facts = new Map<string, AsinFact>()
  if (storeIds.length === 0 || asins.length === 0) return facts
  const [products, snapshots] = await Promise.all([
    prisma.fbaProduct.findMany({
      where: { tenantId: ctx.tenantId, ...storeWhere(ctx.scope), sellerAccountId: { in: [...storeIds] }, asin: { in: [...asins] } },
      select: { sellerAccountId: true, asin: true, title: true, imageUrl: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { sellerSku: 'asc' }],
      take: HARD_LIMIT,
    }),
    latestSnapshots(prisma, ctx, storeIds, asins),
  ])
  for (const product of products) {
    const key = `${product.sellerAccountId}|${product.asin}`
    if (!facts.has(key)) facts.set(key, { title: product.title, imageUrl: product.imageUrl, sellable: null, snapshotDate: null })
  }
  for (const snapshot of snapshots) {
    const key = `${snapshot.sellerAccountId}|${snapshot.asin}`
    const held = facts.get(key) ?? { title: null, imageUrl: null, sellable: null, snapshotDate: null }
    const sellable = snapshot.sellable === null ? held.sellable : (held.sellable ?? 0) + snapshot.sellable
    facts.set(key, { ...held, sellable, snapshotDate: snapshot.snapshotDate })
  }
  return facts
}
