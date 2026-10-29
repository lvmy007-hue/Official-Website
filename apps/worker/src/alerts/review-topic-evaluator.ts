import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { choiceListParam, numberParam, scopeFilter } from './params'
import { DAY_MS, READ_LIMIT, asinsOfSkus, clip, dayText, keyOf, loadProductLookup, utcDay } from './product-common'

// 负面评论主题上升预警评估器（P4-15，09 章 9.1 售后与口碑类）：读评论主题快照（ReviewTopic，P4-13，客户反馈接口每个 ASIN 前 10 个负面主题）。
// 对每个 店铺 × ASIN，取回看天数内最近两次快照日期，比较最近一次与上一次的负面主题：
// - NEW（新进入前 10）：上一次的负面主题里没有它；
// - MENTIONS_UP（提及量上升）：两次都给了提及量区间且下限变大（区间是接口给的文字，如“10-50”“1000+”，取开头的数字作下限；读不出数字就不比较）；
// - RANK_UP（名次上升）：名次数字变小不少于“名次上升阈值”。同一个主题只记一种，按 提及量上升、新进入、名次上升 的顺序取第一个成立的。
// 提及量下限已知且小于“最小提及量下限”的主题不算（没给区间的不排除，也不当 0）。只比较接口给的主题与区间，不估算评论条数，不判断语义；
// 两次快照都要在回看天数内，最近一次快照滑出窗口、或此后又有新快照不再上升，命中随之消失。评论主题只有商品级的负面情感，没有逐条评论，所以证据里没有评论原文。

const KINDS = ['NEW', 'MENTIONS_UP', 'RANK_UP'] as const
export type RiseKind = (typeof KINDS)[number]
export const RISE_KIND_LABEL: Record<RiseKind, string> = { NEW: '新进入前 10', MENTIONS_UP: '提及量上升', RANK_UP: '名次上升' }
const TOP_TOPICS = 5

export interface TopicRow {
  topicKey: string
  rank: number
  mentionRange: string | null
}

export interface RisingTopic {
  topic: string
  kind: RiseKind
  rank: number
  previousRank: number | null
  mentionRange: string | null
  previousMentionRange: string | null
}

/** 提及量区间的下限：“10-50”→10，“1000+”→1000，“12”→12；读不出开头的数字（如“少于 10”、空）返回 null。 */
export function mentionLowOf(range: string | null): number | null {
  if (range === null) return null
  const match = /^\s*(\d[\d,]*)\s*(?:[-–—~]|to\b|\+|$)/i.exec(range)
  return match ? Number(match[1].replace(/,/g, '')) : null
}

/** 比较最近一次与上一次快照的负面主题，返回上升的；名次靠前（数字小）的排前面（纯函数）。 */
export function risingTopics(latest: readonly TopicRow[], previous: readonly TopicRow[], options: { kinds: readonly RiseKind[]; minRankRise: number; minMentionLow: number }): RisingTopic[] {
  const before = new Map(previous.map(row => [row.topicKey, row]))
  const out: RisingTopic[] = []
  for (const row of latest) {
    const low = mentionLowOf(row.mentionRange)
    if (low !== null && low < options.minMentionLow) continue
    const prev = before.get(row.topicKey)
    let kind: RiseKind | null = null
    if (prev) {
      const prevLow = mentionLowOf(prev.mentionRange)
      if (options.kinds.includes('MENTIONS_UP') && low !== null && prevLow !== null && low > prevLow) kind = 'MENTIONS_UP'
      else if (options.kinds.includes('RANK_UP') && prev.rank - row.rank >= options.minRankRise) kind = 'RANK_UP'
    } else if (options.kinds.includes('NEW')) kind = 'NEW'
    if (kind) out.push({ topic: row.topicKey, kind, rank: row.rank, previousRank: prev?.rank ?? null, mentionRange: row.mentionRange, previousMentionRange: prev?.mentionRange ?? null })
  }
  return out.sort((a, b) => a.rank - b.rank || (a.topic < b.topic ? -1 : 1))
}

export const negativeTopicRisingEvaluator: AlertEvaluator = {
  type: 'reviews.negative-topic-rising',
  async evaluate({ db, tenantId, rule, now }) {
    const lookbackDays = numberParam(rule, 'lookbackDays', 30, { min: 7, max: 90 })
    const kinds = choiceListParam(rule, 'kinds', KINDS, KINDS)
    const minRankRise = numberParam(rule, 'minRankRise', 3, { min: 1, max: 9 })
    const minMentionLow = numberParam(rule, 'minMentionLow', 10, { min: 0, max: 1_000_000 })
    const scope = scopeFilter(rule)
    const storeWhere = scope.stores ? { sellerAccountId: { in: scope.stores } } : {}
    const asins = await asinsOfSkus(db, tenantId, scope.stores, scope.skus)
    if (asins && asins.length === 0) return []
    // 第一步：每个 店铺 × ASIN 在窗口内有哪些快照日期（不分情感，只有正面主题的快照也算一次快照）
    const dates = await db.reviewTopic.groupBy({
      by: ['sellerAccountId', 'asin', 'snapshotDate'],
      where: { tenantId, snapshotDate: { gte: new Date(utcDay(now) - lookbackDays * DAY_MS), lte: new Date(utcDay(now)) }, ...storeWhere, ...(asins ? { asin: { in: asins } } : {}) },
      orderBy: [{ snapshotDate: 'desc' }, { sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: READ_LIMIT,
    })
    const byKey = new Map<string, { sellerAccountId: string; asin: string; days: string[] }>()
    for (const row of dates) {
      const key = keyOf(row.sellerAccountId, row.asin)
      const entry = byKey.get(key) ?? { sellerAccountId: row.sellerAccountId, asin: row.asin, days: [] }
      entry.days.push(dayText(row.snapshotDate))
      byKey.set(key, entry)
    }
    const pairs = [...byKey.values()].filter(entry => entry.days.length >= 2)
    if (pairs.length === 0) return []
    // 第二步：只取这些 ASIN 的负面主题，在内存里按 店铺|ASIN|日期 分组
    const wantedDays = [...new Set(pairs.flatMap(entry => entry.days.slice(0, 2)))]
    const topics = await db.reviewTopic.findMany({
      where: {
        tenantId,
        sentiment: 'NEGATIVE',
        sellerAccountId: { in: [...new Set(pairs.map(entry => entry.sellerAccountId))] },
        asin: { in: [...new Set(pairs.map(entry => entry.asin))] },
        snapshotDate: { in: wantedDays.map(day => new Date(`${day}T00:00:00.000Z`)) },
      },
      select: { sellerAccountId: true, asin: true, topicKey: true, rank: true, mentionRange: true, snapshotDate: true },
      orderBy: [{ snapshotDate: 'desc' }, { rank: 'asc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    const rowsOf = new Map<string, TopicRow[]>()
    for (const row of topics) {
      const key = `${keyOf(row.sellerAccountId, row.asin)}|${dayText(row.snapshotDate)}`
      rowsOf.set(key, [...(rowsOf.get(key) ?? []), { topicKey: row.topicKey, rank: row.rank, mentionRange: row.mentionRange }])
    }
    const found = pairs.flatMap(entry => {
      const [latestDay, previousDay] = entry.days
      const key = keyOf(entry.sellerAccountId, entry.asin)
      const rising = risingTopics(rowsOf.get(`${key}|${latestDay}`) ?? [], rowsOf.get(`${key}|${previousDay}`) ?? [], { kinds, minRankRise, minMentionLow })
      return rising.length > 0 ? [{ ...entry, latestDay, previousDay, rising }] : []
    })
    if (found.length === 0) return []
    found.sort((a, b) => b.rising.length - a.rising.length || (keyOf(a.sellerAccountId, a.asin) < keyOf(b.sellerAccountId, b.asin) ? -1 : 1))
    const lookup = await loadProductLookup(db, tenantId, { storeIds: found.map(entry => entry.sellerAccountId), asins: found.map(entry => entry.asin) })
    return found.map((entry): AlertHit => {
      const key = keyOf(entry.sellerAccountId, entry.asin)
      const product = lookup.byAsin.get(key)
      const store = lookup.storeName.get(entry.sellerAccountId) ?? '店铺'
      const names = entry.rising.slice(0, 3).map(item => `“${clip(item.topic, 40)}”`)
      return {
        // 有商品记录的点进去是商品全景（评价与反馈页签在其中）；没有的按 店铺|ASIN 登记
        entityType: product ? 'ASIN' : 'REVIEW_ASIN',
        entityId: product?.id ?? key,
        sellerAccountId: entry.sellerAccountId,
        entityLabel: `${entry.asin}（${store}）`,
        title: `ASIN ${entry.asin} 有 ${entry.rising.length} 个负面评论主题上升：${names.join('、')}${entry.rising.length > 3 ? ' 等' : ''}`,
        suggestedAction: '到评价与反馈页的主题与改进建议查看这些负面主题与近期退货原因的对照；先阅读相关评论，确认是商品、详情页描述还是物流问题，再安排产品或供应链跟进',
        evidence: {
          asin: entry.asin,
          title: product?.title ?? null,
          storeName: store,
          lookbackDays,
          latestDate: entry.latestDay,
          previousDate: entry.previousDay,
          risingCount: entry.rising.length,
          topics: entry.rising.slice(0, TOP_TOPICS).map(item => ({ ...item, topic: clip(item.topic, 120), kindLabel: RISE_KIND_LABEL[item.kind] })),
        },
      }
    })
  },
}
