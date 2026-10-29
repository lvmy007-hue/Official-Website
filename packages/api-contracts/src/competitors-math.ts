import { COMPETITOR_CHANGE_LABEL, COMPETITOR_LIMITS, type CompetitorChange, type CompetitorChangeField, type CompetitorFeatured } from './competitors.js'

// 竞品监控的纯计算（P4-12）：ASIN 校验、价格差与名次差、核心词点击份额、快照留存与变化识别。不访问数据库与网络，接口与同步器共用。

export const COMPETITOR_ASIN_PATTERN = /^[A-Z0-9]{10}$/
export const normalizeAsin = (value: string): string => value.trim().toUpperCase()
export const isAsin = (value: string): boolean => COMPETITOR_ASIN_PATTERN.test(value)

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

/** 价格差：竞品 − 我方，以及占我方价格的比例；任一边没有价格、或我方价格不是正数，就没有价格差（不当 0）。 */
export function priceGapOf(own: number | null, competitor: number | null): { gap: number | null; pct: number | null } {
  if (own === null || competitor === null || own <= 0) return { gap: null, pct: null }
  const gap = round(competitor - own, 2)
  return { gap: gap === 0 ? 0 : gap, pct: round((competitor - own) / own, 6) }
}

/** 名次差：竞品名次 − 我方名次（负数表示竞品名次更靠前）；两边必须是同一个分类的排名，否则不比较。 */
export function rankGapOf(own: { rank: number; classificationId: string } | null, competitor: { rank: number; classificationId: string | null } | null): { gap: number | null; note: string | null } {
  if (!competitor) return { gap: null, note: '竞品还没有销售排名记录' }
  if (!own) return { gap: null, note: '我方对应商品没有销售排名记录' }
  if (competitor.classificationId !== own.classificationId) return { gap: null, note: '两边的排名分类不同，不能直接比较' }
  return { gap: competitor.rank - own.rank, note: null }
}

export interface RankInput {
  classificationId: string
  name: string
  rank: number
}
/** 竞品的主排名：优先取展示组（大类）排名，没有就取第一个分类排名；展示组排名在目录同步器里以 `display:` 为编号前缀。 */
export function pickRank(ranks: readonly RankInput[]): RankInput | null {
  return ranks.find(item => item.classificationId.startsWith('display:')) ?? ranks[0] ?? null
}
/** 在我方的排名里找与竞品同一分类的那一条；没有就返回 null。 */
export const sameClassificationRank = (own: readonly RankInput[], classificationId: string | null): RankInput | null =>
  classificationId === null ? null : (own.find(item => item.classificationId === classificationId) ?? null)

export interface TermShareInput {
  /** 我方这个商品在这个核心词上的搜索量。 */
  volume: number | null
  /** 竞品在这个词里点击份额前三的份额；没进前三为 null（按 0 计）。 */
  share: number | null
}
/**
 * 在我方核心词中的点击份额（下限）：按我方的搜索量加权，竞品没进前三的词按 0 计。
 * 没有搜索量的词不参与（无法加权）；一个都没有时没有结果（不当 0）。
 */
export function weightedClickShare(terms: readonly TermShareInput[]): { share: number | null; hit: number; total: number } {
  const eligible = terms.filter(term => term.volume !== null && term.volume > 0)
  const total = eligible.length
  if (total === 0) return { share: null, hit: 0, total: 0 }
  const volume = eligible.reduce((sum, term) => sum + (term.volume ?? 0), 0)
  const weighted = eligible.reduce((sum, term) => sum + (term.volume ?? 0) * Math.max(0, term.share ?? 0), 0)
  return { share: round(Math.min(1, weighted / volume), 6), hit: eligible.filter(term => (term.share ?? 0) > 0).length, total }
}

// ---- 快照留存与变化 ----

export interface SnapshotFields {
  title: string | null
  brand: string | null
  imageCount: number | null
  price: number | null
  featured: CompetitorFeatured | null
  fulfillment: string | null
  memberEligible: boolean | null
  rank: number | null
  rankClassificationId: string | null
}

const priceDiffers = (a: number | null, b: number | null) => (a === null || b === null ? a !== b : Math.abs(a - b) >= 0.005)

/** 快照只在可见属性变化、或距上一条已超过 24 小时（心跳）时才写；没有上一条一定写。 */
export function shouldStoreSnapshot(last: (SnapshotFields & { observedAt: Date }) | null, next: SnapshotFields, now: Date): boolean {
  if (!last) return true
  if (now.getTime() - last.observedAt.getTime() >= COMPETITOR_LIMITS.heartbeatMs) return true
  return (
    priceDiffers(last.price, next.price) ||
    last.title !== next.title ||
    last.brand !== next.brand ||
    last.imageCount !== next.imageCount ||
    last.featured !== next.featured ||
    last.fulfillment !== next.fulfillment ||
    last.memberEligible !== next.memberEligible ||
    last.rank !== next.rank ||
    last.rankClassificationId !== next.rankClassificationId
  )
}

/**
 * 把这一次取到的值与上一条快照合并：接口这次没给的字段（null）沿用上一条的值，不用“没取到”覆盖已知值。
 * 价格与推荐报价状态来自竞争摘要，标题、品牌、图片数量与排名来自商品目录；两个接口各自可能失败，所以按字段合并。
 */
export function mergeSnapshot(last: SnapshotFields | null, next: SnapshotFields): SnapshotFields {
  if (!last) return next
  return {
    title: next.title ?? last.title,
    brand: next.brand ?? last.brand,
    imageCount: next.imageCount ?? last.imageCount,
    price: next.price ?? last.price,
    featured: next.featured ?? last.featured,
    fulfillment: next.fulfillment ?? last.fulfillment,
    memberEligible: next.memberEligible ?? last.memberEligible,
    rank: next.rank ?? last.rank,
    rankClassificationId: next.rank === null ? last.rankClassificationId : next.rankClassificationId,
  }
}

const CHANGE_FIELDS: readonly CompetitorChangeField[] = ['title', 'brand', 'imageCount']
const textOf = (value: string | number | null): string | null => (value === null ? null : String(value))

/**
 * 目录属性变化（标题、品牌、图片数量）：按时间从旧到新给入快照，逐字段与“上一个有值的快照”比较，
 * 两边都有值且不同才算变化（没取到的快照不算变化，也不覆盖上一个已知值）；返回时间从新到旧，最多 limit 条。
 */
export function catalogChanges(
  chronological: ReadonlyArray<{ at: string; title: string | null; brand: string | null; imageCount: number | null }>,
  limit: number = COMPETITOR_LIMITS.changesMax,
): { items: CompetitorChange[]; truncated: boolean } {
  const last: Record<CompetitorChangeField, string | number | null> = { title: null, brand: null, imageCount: null }
  const found: CompetitorChange[] = []
  for (const row of chronological) {
    for (const field of CHANGE_FIELDS) {
      const value = row[field]
      if (value === null) continue
      const before = last[field]
      if (before !== null && before !== value) found.push({ at: row.at, field, label: COMPETITOR_CHANGE_LABEL[field], before: textOf(before), after: textOf(value) })
      last[field] = value
    }
  }
  const newestFirst = found.reverse()
  return { items: newestFirst.slice(0, limit), truncated: newestFirst.length > limit }
}

/** 竞争摘要里的会员资格：推荐报价对会员有展示权重才算“会员可享”；没有推荐报价就没有结论（null）。 */
export const memberEligibleOf = (hasFeatured: boolean, viewWeightMember: number | null): boolean | null => (hasFeatured ? viewWeightMember !== null && viewWeightMember > 0 : null)

/** 同步器与页面共用的“最近一次快照”的有效窗口起点。 */
export const competitorWindowStart = (now: Date): Date => new Date(now.getTime() - COMPETITOR_LIMITS.freshWindowMs)

/** 无状态轮转：同一时间槽内选同一段，下一个时间槽接着往后；容量够用时每次全量。 */
export function rotateWatched<T>(items: readonly T[], size: number, now: Date): T[] {
  if (items.length <= size) return [...items]
  const start = (Math.floor(now.getTime() / COMPETITOR_LIMITS.syncSlotMs) * size) % items.length
  return [...items.slice(start), ...items.slice(0, start)].slice(0, size)
}
