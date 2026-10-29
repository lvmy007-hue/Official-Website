import { COMPETITOR_MARKETPLACE_ID, memberEligibleOf, pickRank, type CompetitorFeatured, type SnapshotFields } from '@nova/api-contracts'
import { parseCatalogItems } from '../catalog/items-parse'
import type { SummaryRow } from '../pricing/parse'

// 竞品监控的响应解析（importers.md I-09、I-13 对关注的竞品 ASIN 的调用）：纯函数，不访问数据库与网络。
// 商品目录提供标题、品牌、图片数量与销售排名；竞争摘要提供价格、推荐报价状态、配送方式与会员资格。
// 规则：解析宽松（缺字段给 null，不抛错）；某个接口这次没给的字段保持 null，由 mergeSnapshot 沿用上一条快照的值，不当 0。

type Loose = Record<string, unknown>
const record = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

export interface CompetitorCatalogItem {
  asin: string
  title: string | null
  brand: string | null
  imageCount: number | null
  rank: { classificationId: string; name: string; rank: number } | null
}

/** 美国站那一组（只有一组且没写站点时也取它）。 */
function marketGroup(value: unknown): Loose | null {
  const groups = list(value)
    .map(record)
    .filter((group): group is Loose => group !== null)
  return groups.find(group => group.marketplaceId === COMPETITOR_MARKETPLACE_ID) ?? (groups.length === 1 && !groups[0]!.marketplaceId ? groups[0]! : null)
}

/** 图片数量：按图片变体（MAIN、PT01 …）去重计数；没有变体字段时按地址去重；这个站点没有图片信息为 null（不是 0）。 */
export function imageCountOf(images: unknown): number | null {
  const group = marketGroup(images)
  if (!group) return null
  const keys = new Set<string>()
  for (const entry of list(group.images)) {
    const image = record(entry)
    const key = text(image?.variant) ?? text(image?.link)
    if (key) keys.add(key)
  }
  return keys.size > 0 ? keys.size : null
}

export function parseCompetitorCatalog(body: unknown): { items: CompetitorCatalogItem[]; skipped: number } {
  const base = parseCatalogItems(body)
  const raw = new Map<string, Loose>()
  for (const entry of list(record(body)?.items)) {
    const item = record(entry)
    const asin = text(item?.asin)
    if (item && asin) raw.set(asin.toUpperCase(), item)
  }
  const items = base.items.map<CompetitorCatalogItem>(item => {
    const source = raw.get(item.asin.toUpperCase())
    const title = text(marketGroup(source?.summaries)?.itemName)
    const picked = pickRank(item.ranks)
    return {
      asin: item.asin.toUpperCase(),
      title: title ? title.slice(0, 500) : null,
      brand: item.brand,
      imageCount: imageCountOf(source?.images),
      rank: picked ? { classificationId: picked.classificationId, name: picked.name, rank: picked.rank } : null,
    }
  })
  return { items, skipped: base.skipped }
}

/** 竞争摘要里这个 ASIN 的价格：推荐报价价格优先，没有推荐报价就取最低报价；两个都没有为 null。 */
export interface CompetitorPrice {
  price: number | null
  currency: string
  featured: CompetitorFeatured
  fulfillment: string | null
  memberEligible: boolean | null
}

export function competitorPriceOf(summary: SummaryRow): CompetitorPrice {
  return {
    price: summary.featuredPrice ?? summary.lowestPrice,
    currency: summary.currency || 'USD',
    featured: summary.hasFeatured ? 'HAS_FEATURED' : 'NONE',
    fulfillment: summary.featuredFulfillment ?? summary.offers[0]?.fulfillment ?? null,
    memberEligible: memberEligibleOf(summary.hasFeatured, summary.viewWeightMember),
  }
}

/** 把两个接口这一次的结果拼成快照字段；某个接口没返回这个 ASIN（或整批失败）就保持 null。 */
export function snapshotFieldsOf(catalog: CompetitorCatalogItem | undefined, summary: SummaryRow | undefined): SnapshotFields & { currency: string; rankName: string | null } {
  const price = summary ? competitorPriceOf(summary) : null
  return {
    title: catalog?.title ?? null,
    brand: catalog?.brand ?? null,
    imageCount: catalog?.imageCount ?? null,
    price: price?.price ?? null,
    featured: price?.featured ?? null,
    fulfillment: price?.fulfillment ?? null,
    memberEligible: price?.memberEligible ?? null,
    rank: catalog?.rank?.rank ?? null,
    rankClassificationId: catalog?.rank?.classificationId ?? null,
    currency: price?.currency ?? 'USD',
    rankName: catalog?.rank?.name ?? null,
  }
}
