import { COMPETITOR_LIMITS, COMPETITOR_MARKETPLACE_ID, competitorWindowStart, type CompetitorFeatured, type CompetitorReason, type RankInput, type SnapshotFields } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { firstBy, keyOf, num } from './competitors-common'

// 竞品监控取数（P4-12）：一律显式带企业与数据范围条件；快照只在变化或每 24 小时写一次，所以“最近一次”只看 3 天内的行。

export interface WatchRow {
  id: string
  sellerAccountId: string
  asin: string
  ownAsin: string
  reason: CompetitorReason
  note: string | null
  createdAt: Date
}

const reasonOf = (value: string): CompetitorReason => (value === 'SEARCH_TERM' ? 'SEARCH_TERM' : 'MANUAL')

export async function loadWatches(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  filter: { reason?: CompetitorReason; storeId?: string; asin?: string },
): Promise<{ rows: WatchRow[]; truncated: boolean }> {
  const where: Prisma.WatchedAsinWhereInput = {
    tenantId,
    marketplaceId: COMPETITOR_MARKETPLACE_ID,
    ...storeWhere(scope),
    ...(filter.storeId ? { sellerAccountId: filter.storeId } : {}),
    ...(filter.asin ? { asin: filter.asin } : {}),
    ...(filter.reason ? { reason: filter.reason } : {}),
  }
  const found = await prisma.watchedAsin.findMany({
    where,
    select: { id: true, sellerAccountId: true, asin: true, ownAsin: true, reason: true, note: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: COMPETITOR_LIMITS.listMax + 1,
  })
  return { rows: found.slice(0, COMPETITOR_LIMITS.listMax).map(row => ({ ...row, reason: reasonOf(row.reason) })), truncated: found.length > COMPETITOR_LIMITS.listMax }
}

export interface SnapshotRow extends SnapshotFields {
  id: string
  sellerAccountId: string
  asin: string
  currency: string
  rankName: string | null
  observedAt: Date
}

type SnapshotRecord = Awaited<ReturnType<PrismaService['competitorSnapshot']['findMany']>>[number]
export const snapshotOf = (row: SnapshotRecord): SnapshotRow => ({
  id: row.id,
  sellerAccountId: row.sellerAccountId,
  asin: row.asin,
  title: row.title,
  brand: row.brand,
  imageCount: row.imageCount,
  price: num(row.price),
  currency: row.currency,
  featured: row.featuredStatus === 'HAS_FEATURED' || row.featuredStatus === 'NONE' ? (row.featuredStatus as CompetitorFeatured) : null,
  fulfillment: row.fulfillment,
  memberEligible: row.memberEligible,
  rank: row.rank,
  rankClassificationId: row.rankClassificationId,
  rankName: row.rankClassificationName,
  observedAt: row.observedAt,
})

/** 每个（店铺，竞品 ASIN）最近一次快照（3 天内）。 */
export async function loadLatestSnapshots(prisma: PrismaService, tenantId: string, storeIds: readonly string[], asins: readonly string[], now: Date): Promise<Map<string, SnapshotRow>> {
  if (asins.length === 0 || storeIds.length === 0) return new Map()
  const rows = await prisma.competitorSnapshot.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: { in: [...asins] }, observedAt: { gte: competitorWindowStart(now) } },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take: Math.min(19_999, asins.length * 14 + 100),
  })
  return new Map([...firstBy(rows, row => keyOf(row.sellerAccountId, row.asin))].map(([key, row]) => [key, snapshotOf(row)]))
}

export interface OwnProduct {
  asin: string
  title: string
  brand: string | null
  fulfillmentChannel: string
}

/** 我方商品（同店铺同 ASIN 取排在最前的 SKU）。 */
export async function loadOwnProducts(prisma: PrismaService, tenantId: string, storeIds: readonly string[], asins: readonly string[]): Promise<Map<string, OwnProduct>> {
  if (asins.length === 0 || storeIds.length === 0) return new Map()
  const rows = await prisma.fbaProduct.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: { in: [...asins] } },
    select: { sellerAccountId: true, asin: true, title: true, brand: true, fulfillmentChannel: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }],
    take: 5000,
  })
  return new Map(
    [...firstBy(rows, row => keyOf(row.sellerAccountId, row.asin))].map(([key, row]) => [key, { asin: row.asin, title: row.title, brand: row.brand, fulfillmentChannel: row.fulfillmentChannel }]),
  )
}

export interface OwnPrice {
  price: number
  currency: string
  observedAt: Date
}

/** 我方商品最近一次价格快照（定价同步器写入，3 天内；同一个 ASIN 有多个 SKU 时取最近的一条）。 */
export async function loadOwnPrices(prisma: PrismaService, tenantId: string, storeIds: readonly string[], asins: readonly string[], now: Date): Promise<Map<string, OwnPrice>> {
  if (asins.length === 0 || storeIds.length === 0) return new Map()
  const rows = await prisma.priceSnapshot.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, asin: { in: [...asins] }, observedAt: { gte: competitorWindowStart(now) } },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take: Math.min(19_999, asins.length * 40 + 100),
  })
  return new Map(
    [...firstBy(rows, row => keyOf(row.sellerAccountId, row.asin))].map(([key, row]) => [key, { price: Number(row.price.toString()), currency: row.currency, observedAt: row.observedAt }]),
  )
}

/** 我方商品最近一天的销售排名（该 ASIN 的各个分类），最近 14 天内。 */
export async function loadOwnRanks(prisma: PrismaService, tenantId: string, storeIds: readonly string[], asins: readonly string[], now: Date): Promise<Map<string, RankInput[]>> {
  if (asins.length === 0 || storeIds.length === 0) return new Map()
  const rows = await prisma.salesRankSnapshot.findMany({
    where: { tenantId, sellerAccountId: { in: [...storeIds] }, asin: { in: [...asins] }, snapshotDate: { gte: new Date(now.getTime() - 14 * 86_400_000) } },
    orderBy: [{ snapshotDate: 'desc' }, { classificationId: 'asc' }],
    take: Math.min(19_999, asins.length * 140 + 100),
  })
  const latest = new Map<string, number>()
  for (const row of rows) {
    const key = keyOf(row.sellerAccountId, row.asin)
    if (!latest.has(key)) latest.set(key, row.snapshotDate.getTime())
  }
  const out = new Map<string, RankInput[]>()
  for (const row of rows) {
    const key = keyOf(row.sellerAccountId, row.asin)
    if (latest.get(key) !== row.snapshotDate.getTime()) continue
    out.set(key, [...(out.get(key) ?? []), { classificationId: row.classificationId, name: row.classificationName, rank: row.rank }])
  }
  return out
}
