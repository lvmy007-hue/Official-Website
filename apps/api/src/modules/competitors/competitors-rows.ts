import { priceGapOf, rankGapOf, sameClassificationRank, type CompetitorRow, type CompetitorSort, type CompetitorSummary, type RankInput } from '@nova/api-contracts'
import type { OwnPrice, OwnProduct, SnapshotRow, WatchRow } from './competitors-load'
import type { ShareResult } from './competitors-terms'

// 竞品列表的行装配与排序（P4-12）：纯函数，没有数据的字段一律为 null（页面显示“尚无记录”），不用 0 代替。

export interface RowInput {
  watch: WatchRow
  storeName: string
  snapshot: SnapshotRow | undefined
  own: OwnProduct | undefined
  ownPrice: OwnPrice | undefined
  ownRanks: readonly RankInput[]
  share: ShareResult | null
}

export function rankGapFor(ownAsin: string | null, snapshot: SnapshotRow | undefined, ownRanks: readonly RankInput[]): { ownRank: number | null; gap: number | null; note: string | null } {
  if (!ownAsin) return { ownRank: null, gap: null, note: '没有指定我方对应商品' }
  const competitor = snapshot && snapshot.rank !== null ? { rank: snapshot.rank, classificationId: snapshot.rankClassificationId } : null
  const same = sameClassificationRank(ownRanks, competitor?.classificationId ?? null)
  const own = same ?? ownRanks[0] ?? null
  const { gap, note } = rankGapOf(own ? { rank: own.rank, classificationId: own.classificationId } : null, competitor)
  return { ownRank: same?.rank ?? null, gap, note }
}

export function buildRow(input: RowInput): CompetitorRow {
  const { watch, snapshot, own, ownPrice, share } = input
  const ownAsin = watch.ownAsin === '' ? null : watch.ownAsin
  const currency = snapshot?.currency ?? 'USD'
  const sameCurrency = ownPrice !== undefined && snapshot !== undefined && ownPrice.currency === snapshot.currency
  const gap = ownAsin && sameCurrency ? priceGapOf(ownPrice.price, snapshot.price) : { gap: null, pct: null }
  const rank = rankGapFor(ownAsin, snapshot, input.ownRanks)
  return {
    id: watch.id,
    storeId: watch.sellerAccountId,
    storeName: input.storeName,
    asin: watch.asin,
    ownAsin,
    ownTitle: own?.title ?? null,
    reason: watch.reason,
    reasonNote: watch.note,
    title: snapshot?.title ?? null,
    brand: snapshot?.brand ?? null,
    imageCount: snapshot?.imageCount ?? null,
    price: snapshot?.price ?? null,
    currency,
    featured: snapshot?.featured ?? null,
    fulfillment: snapshot?.fulfillment ?? null,
    memberEligible: snapshot?.memberEligible ?? null,
    rank: snapshot?.rank ?? null,
    rankName: snapshot?.rankName ?? null,
    ownPrice: ownAsin ? (ownPrice?.price ?? null) : null,
    priceGap: gap.gap,
    priceGapPct: gap.pct,
    ownRank: rank.ownRank,
    rankGap: rank.gap,
    rankNote: rank.gap === null ? rank.note : null,
    clickShare: share?.share ?? null,
    clickShareTerms: share && share.total > 0 ? { hit: share.hit, total: share.total } : null,
    observedAt: snapshot ? snapshot.observedAt.toISOString() : null,
    addedAt: watch.createdAt.toISOString(),
  }
}

const valueOf = (row: CompetitorRow, field: CompetitorSort): number | string | null => {
  switch (field) {
    case 'asin':
      return row.asin
    case 'price':
      return row.price
    case 'rank':
      return row.rank
    case 'priceGap':
      return row.priceGap
    case 'rankGap':
      return row.rankGap
    case 'clickShare':
      return row.clickShare
    case 'observedAt':
      return row.observedAt
    default:
      return row.addedAt
  }
}

/** 排序：没有值的行永远排在最后（不论升降序）；值相同按竞品 ASIN、关注编号稳定排序。 */
export function compareRows(a: CompetitorRow, b: CompetitorRow, field: CompetitorSort, dir: 'asc' | 'desc'): number {
  const x = valueOf(a, field)
  const y = valueOf(b, field)
  if (x === null && y !== null) return 1
  if (x !== null && y === null) return -1
  if (x !== null && y !== null && x !== y) {
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return dir === 'asc' ? order : -order
  }
  return a.asin.localeCompare(b.asin) || a.id.localeCompare(b.id)
}

export const summaryOf = (rows: readonly CompetitorRow[]): CompetitorSummary => {
  const withSnapshot = rows.filter(row => row.observedAt !== null).length
  return { watched: rows.length, withSnapshot, waiting: rows.length - withSnapshot }
}

/** 关键字：匹配竞品 ASIN、我方对应 ASIN、标题、品牌与备注（不区分大小写）。 */
export function matchesQuery(row: CompetitorRow, q: string | undefined): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return [row.asin, row.ownAsin, row.title, row.brand, row.reasonNote, row.ownTitle].some(value => value !== null && value.toLowerCase().includes(needle))
}
