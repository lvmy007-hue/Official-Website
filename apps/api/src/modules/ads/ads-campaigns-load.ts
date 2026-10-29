import type { Prisma } from '@prisma/client'
import type { AdsEntityMetrics, AdsTotals } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, storeWhere } from '../auth'
import { asDate, dateText } from '../overview'
import { num } from './ads-campaigns-common'
import { summaryWhere, type AdsLoadContext } from './ads-overview-load'

// 广告活动页的数据读取（P3-07）：全部在数据库里聚合，只取聚合结果；租户条件与数据范围显式带上，行级安全同时生效。

const DAY_ROWS_LIMIT = 1200
const ENTITY_ROWS_LIMIT = 5000

export interface CampaignRef {
  adsProfileId: string
  adProduct: string
  externalCampaignId: string
  currency: string
}

/** 读指标表用的引用：广告产品未知（上级活动还没有同步）时不按广告产品过滤。 */
export type MetricRef = Pick<CampaignRef, 'adsProfileId' | 'currency'> & { adProduct: string | null }

/** 某个对象（广告组、投放对象）逐日合计；对象类型可以多个（投放对象与关键词）。一天可能有多行（不同广告产品），所以按日分组求和。 */
export async function entityDaily(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  input: { ref: MetricRef; entityTypes: readonly string[]; entityId: string; from: string; to: string },
): Promise<Map<string, AdsTotals>> {
  const groups = await prisma.adsMetric.groupBy({
    by: ['reportDate'],
    where: {
      tenantId: ctx.tenantId,
      ...adsRelationWhere(ctx.scope),
      adsProfileId: input.ref.adsProfileId,
      ...(input.ref.adProduct ? { adProduct: input.ref.adProduct } : {}),
      currency: input.ref.currency,
      entityType: { in: [...input.entityTypes] },
      entityId: input.entityId,
      reportDate: { gte: asDate(input.from), lte: asDate(input.to) },
    },
    _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    orderBy: { reportDate: 'asc' },
    take: DAY_ROWS_LIMIT,
  })
  return new Map(
    groups.map(group => [
      dateText(group.reportDate),
      { impressions: group._sum.impressions ?? 0, clicks: group._sum.clicks ?? 0, spend: num(group._sum.cost), sales: num(group._sum.sales), orders: group._sum.purchases ?? 0 },
    ]),
  )
}

/** 某个对象在可见范围内是否出现过任何指标行（任何日期、任何币种）。 */
export async function entityEverHadMetrics(prisma: PrismaService, ctx: AdsLoadContext, input: { adsProfileId: string; entityTypes: readonly string[]; entityId: string }): Promise<boolean> {
  const row = await prisma.adsMetric.findFirst({
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), adsProfileId: input.adsProfileId, entityType: { in: [...input.entityTypes] }, entityId: input.entityId },
    select: { id: true },
  })
  return row !== null
}

/** 每个店铺范围内的总销售额（店铺经营日汇总，美元）：广告销售占比的分母。 */
export async function storeSalesByStore(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<Map<string, number>> {
  const groups = await prisma.storeDailySummary.groupBy({
    by: ['sellerAccountId'],
    where: { tenantId: ctx.tenantId, ...storeWhere(ctx.scope), summaryDate: { gte: asDate(from), lte: asDate(to) } },
    _sum: { salesAmount: true },
    orderBy: { sellerAccountId: 'asc' },
    take: 2000,
  })
  return new Map(groups.map(group => [group.sellerAccountId, num(group._sum.salesAmount) ?? 0]))
}

/** 单个活动逐日合计（活动自己的币种）。一天最多一行（汇总表唯一键含币种）。 */
export async function campaignDaily(prisma: PrismaService, ctx: AdsLoadContext, ref: CampaignRef, from: string, to: string): Promise<Map<string, AdsTotals>> {
  const rows = await prisma.adsDailySummary.findMany({
    where: summaryWhere(ctx, from, to, { adsProfileId: ref.adsProfileId, adProduct: ref.adProduct, campaignId: ref.externalCampaignId, currency: ref.currency }),
    select: { summaryDate: true, impressions: true, clicks: true, spend: true, sales: true, orders: true },
    orderBy: { summaryDate: 'asc' },
    take: DAY_ROWS_LIMIT,
  })
  return new Map(rows.map(row => [dateText(row.summaryDate), { impressions: row.impressions, clicks: row.clicks, spend: num(row.spend), sales: num(row.sales), orders: row.orders }]))
}

/** 单个活动在时间范围内是否出现过任何汇总行（任何日期）。 */
export async function campaignEverHadSummary(prisma: PrismaService, ctx: AdsLoadContext, ref: CampaignRef): Promise<boolean> {
  const row = await prisma.adsDailySummary.findFirst({
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), adsProfileId: ref.adsProfileId, adProduct: ref.adProduct, campaignId: ref.externalCampaignId },
    select: { id: true },
  })
  return row !== null
}

const sumsOf = (sum: { impressions: number | null; clicks: number | null; cost?: unknown; spend?: unknown; sales: unknown; purchases?: number | null; orders?: number | null }): AdsEntityMetrics => ({
  impressions: sum.impressions ?? 0,
  clicks: sum.clicks ?? 0,
  spend: num((sum.cost ?? sum.spend) as { toString(): string } | null | undefined),
  sales: num(sum.sales as { toString(): string } | null | undefined),
  orders: sum.purchases ?? sum.orders ?? 0,
})

/** 广告组、投放对象等实体在范围内的指标合计（指标表按实体类型与编号存放）。键是实体编号。 */
export async function entityMetricMap(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  input: { ref: MetricRef; entityTypes: readonly string[]; entityIds: readonly string[]; from: string; to: string },
): Promise<Map<string, AdsEntityMetrics>> {
  if (input.entityIds.length === 0) return new Map()
  const groups = await prisma.adsMetric.groupBy({
    by: ['entityId'],
    where: {
      tenantId: ctx.tenantId,
      ...adsRelationWhere(ctx.scope),
      adsProfileId: input.ref.adsProfileId,
      ...(input.ref.adProduct ? { adProduct: input.ref.adProduct } : {}),
      currency: input.ref.currency,
      entityType: { in: [...input.entityTypes] },
      entityId: { in: [...input.entityIds] },
      reportDate: { gte: asDate(input.from), lte: asDate(input.to) },
    },
    _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    orderBy: { entityId: 'asc' },
    take: ENTITY_ROWS_LIMIT,
  })
  const map = new Map<string, AdsEntityMetrics>()
  for (const group of groups) if (group.entityId) map.set(group.entityId, sumsOf(group._sum))
  return map
}

export { sumsOf as entitySums }

/** 活动下的广告组：外部活动编号相同的广告组（按名称排）。 */
export async function campaignAdGroups(prisma: PrismaService, ctx: AdsLoadContext, ref: CampaignRef, limit: number) {
  return prisma.adsAdGroup.findMany({
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), adsProfileId: ref.adsProfileId, campaignId: ref.externalCampaignId },
    select: { id: true, adGroupId: true, name: true, state: true, defaultBid: true },
    orderBy: [{ name: 'asc' }, { adGroupId: 'asc' }],
    take: limit,
  })
}

/** 某类实体在可见范围内是否出现过任何行：区分“同步器尚未接入”与“这个活动下没有”。 */
export async function anyRowInScope(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  table:
    | 'adsAdGroup'
    | 'adsTarget'
    | 'adsKeyword'
    | 'adsNegativeTarget'
    | 'adsCreative'
    | 'adsAd'
    | 'adsPlacementMetric'
    | 'adsAdvertisedProductMetric'
    | 'adsConvertedProductDaily'
    | 'adsTermMetric'
    | 'adsRecommendation'
    | 'adsForecastRun'
    | 'adsPerformanceHourly',
): Promise<boolean> {
  const where = { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope) } as Prisma.AdsAdGroupWhereInput
  const delegate = prisma[table] as unknown as { findFirst(args: { where: Prisma.AdsAdGroupWhereInput; select: { id: true } }): Promise<unknown> }
  // 分区表（词级、分时、被推广商品）没有单列主键，id 不是唯一键，但 findFirst 只要“有没有”，不依赖唯一
  return (await delegate.findFirst({ where, select: { id: true } })) !== null
}
