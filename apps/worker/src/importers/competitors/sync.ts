import {
  COMPETITOR_LIMITS,
  COMPETITOR_MARKETPLACE_ID,
  COMPETITOR_ROLE_MISSING,
  competitorWindowStart,
  mergeSnapshot,
  rotateWatched,
  shouldStoreSnapshot,
  type SnapshotFields,
} from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { isBadIdentifiers, isCatalogForbidden, type CatalogApi } from '../../connectors/catalog-api'
import { isPricingForbidden, type PricingApi } from '../../connectors/pricing-api'
import type { ImportContext } from '../../types'
import { parseSummaries, type SummaryRow } from '../pricing/parse'
import { parseCompetitorCatalog, snapshotFieldsOf, type CompetitorCatalogItem } from './parse'

// 竞品监控同步器（importers.md I-09、I-13 的竞品用法，P4-12）：每 6 小时一次，对店铺关注的竞品 ASIN 取商品目录（标题、品牌、图片数量、销售排名）与竞争摘要（价格、推荐报价、配送方式、会员资格），
// 只在可见属性变化、或距上一条超过 24 小时时才写一条快照。只用官方接口，不抓取亚马逊前台页面。
// 规则：
//   - 关注的竞品多于一次的容量（syncBatchesMax × 20）时按“时间槽”确定性轮转，下一个槽接着往后；
//   - 两个接口各自可能失败或没返回某个 ASIN：这一次没取到的字段沿用上一条快照的值（不用空值覆盖，也不当 0）；两个接口都没返回且没有历史就不写；
//   - 403（缺“商品目录”或“定价”角色）以不可重试的失败码结束；批内整批失败（限速以外的错误）向上抛出由任务重试，已写入的批因唯一键加 skipDuplicates 幂等。

export interface CompetitorScope {
  tenantId: string
  sellerAccountId: string
}
export interface CompetitorSyncOptions {
  now?: Date
  maxBatches?: number
}
export type CompetitorSyncResult =
  | { notApplicable: true; reason: 'NO_WATCHED'; imported: 0 }
  | { notApplicable: false; imported: number; watched: number; processed: number; stored: number; catalogMissing: number; summaryMissing: number; skipped: number; incomplete: boolean }

const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))

async function guarded<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (isCatalogForbidden(error) || isPricingForbidden(error)) throw new NonRetryableError(COMPETITOR_ROLE_MISSING, '亚马逊商品目录或定价接口的角色尚未获批，竞品数据无法同步')
    throw error
  }
}

/** 商品目录整批被拒（400，例如某个 ASIN 格式不合法）：退化为逐个请求，单个仍被拒就当目录里没有。 */
async function catalogBatch(api: CatalogApi, asins: string[]): Promise<{ items: CompetitorCatalogItem[]; skipped: number }> {
  try {
    return parseCompetitorCatalog(await guarded(() => api.getItems(asins)))
  } catch (error) {
    if (!isBadIdentifiers(error)) throw error
    if (asins.length === 1) return { items: [], skipped: 0 }
    const items: CompetitorCatalogItem[] = []
    let skipped = 0
    for (const asin of asins) {
      const one = await catalogBatch(api, [asin])
      items.push(...one.items)
      skipped += one.skipped
    }
    return { items, skipped }
  }
}

interface LastSnapshot extends SnapshotFields {
  observedAt: Date
  currency: string
  rankClassificationName: string | null
}

async function lastSnapshots(ctx: ImportContext, scope: CompetitorScope, asins: readonly string[], now: Date): Promise<Map<string, LastSnapshot>> {
  const rows = await ctx.prisma.competitorSnapshot.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: { in: [...asins] }, observedAt: { gte: competitorWindowStart(now) } },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take: asins.length * 4,
  })
  const map = new Map<string, LastSnapshot>()
  for (const row of rows) {
    if (map.has(row.asin)) continue
    map.set(row.asin, {
      title: row.title,
      brand: row.brand,
      imageCount: row.imageCount,
      price: num(row.price),
      featured: row.featuredStatus === 'HAS_FEATURED' || row.featuredStatus === 'NONE' ? row.featuredStatus : null,
      fulfillment: row.fulfillment,
      memberEligible: row.memberEligible,
      rank: row.rank,
      rankClassificationId: row.rankClassificationId,
      observedAt: row.observedAt,
      currency: row.currency,
      rankClassificationName: row.rankClassificationName,
    })
  }
  return map
}

export async function syncCompetitors(ctx: ImportContext, catalog: CatalogApi, pricing: PricingApi, scope: CompetitorScope, options: CompetitorSyncOptions = {}): Promise<CompetitorSyncResult> {
  const now = options.now ?? new Date()
  const watched = await ctx.prisma.watchedAsin.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, marketplaceId: COMPETITOR_MARKETPLACE_ID },
    distinct: ['asin'],
    select: { asin: true },
    orderBy: { asin: 'asc' },
    take: COMPETITOR_LIMITS.watchMaxPerStore + 1,
  })
  if (watched.length === 0) return { notApplicable: true, reason: 'NO_WATCHED', imported: 0 }
  const all = watched.map(row => row.asin)
  const capacity = COMPETITOR_LIMITS.catalogBatch * (options.maxBatches ?? COMPETITOR_LIMITS.syncBatchesMax)
  const chosen = rotateWatched(all, capacity, now)
  const counts = { stored: 0, catalogMissing: 0, summaryMissing: 0, skipped: 0 }
  for (const batch of chunk(chosen, COMPETITOR_LIMITS.catalogBatch)) {
    const catalogResult = await catalogBatch(catalog, batch)
    const summaryRaw = await guarded(() => pricing.competitiveSummaries(batch))
    const summaries = new Map<string, SummaryRow>(parseSummaries(summaryRaw, '').rows.map(row => [row.asin.toUpperCase(), row]))
    const items = new Map(catalogResult.items.map(item => [item.asin, item]))
    counts.skipped += catalogResult.skipped
    const last = await lastSnapshots(ctx, scope, batch, now)
    const data = []
    for (const asin of batch) {
      const item = items.get(asin)
      const summary = summaries.get(asin)
      if (!item) counts.catalogMissing += 1
      if (!summary) counts.summaryMissing += 1
      const before = last.get(asin) ?? null
      if (!item && !summary && !before) continue
      const fresh = snapshotFieldsOf(item, summary)
      const merged = mergeSnapshot(before, fresh)
      if (!shouldStoreSnapshot(before, merged, now)) continue
      data.push({
        ...scope,
        marketplaceId: COMPETITOR_MARKETPLACE_ID,
        asin,
        title: merged.title,
        brand: merged.brand,
        imageCount: merged.imageCount,
        price: merged.price,
        currency: summary ? fresh.currency : (before?.currency ?? 'USD'),
        featuredStatus: merged.featured,
        fulfillment: merged.fulfillment,
        memberEligible: merged.memberEligible,
        rank: merged.rank,
        rankClassificationId: merged.rankClassificationId,
        rankClassificationName: fresh.rank !== null ? fresh.rankName : (before?.rankClassificationName ?? null),
        observedAt: now,
      })
    }
    if (data.length > 0) counts.stored += (await ctx.prisma.competitorSnapshot.createMany({ data, skipDuplicates: true })).count
  }
  const incomplete = all.length > capacity
  if (incomplete) ctx.logger.warn({ ...scope, watched: all.length, capacity }, 'competitor sync covers a rotating slice of the watched list')
  return { notApplicable: false, imported: counts.stored, watched: all.length, processed: chosen.length, ...counts, incomplete }
}
