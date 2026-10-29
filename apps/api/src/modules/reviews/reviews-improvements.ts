import {
  REVIEWS_LIMITS,
  UNSPECIFIED_REASON,
  improvementSuggestion,
  normalizeReason,
  returnReasonLabel,
  topicMatchesReason,
  type ImprovementRow,
  type ReviewStoreRef,
  type ReturnsTabResponse,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { DAY_MS, SEP, chunk, keyOf, textCompare, titlesOf, ymd } from './reviews-common'

// 改进清单（05 章 5.7）：把商品最新的负面评论主题与近 90 天的退货原因放在一起，按退货件数排序。只列有退货的商品；文字有重合才标“可能相关”，不做语义判断。
// 只用评论主题与退货记录里的商品、数量、原因代码，不读订单与买家信息。

type Improvements = ReturnsTabResponse['improvements']
const days = REVIEWS_LIMITS.returnReasonDays
const reasonLabelOf = (code: string): string => (code === UNSPECIFIED_REASON ? '未提供原因' : (returnReasonLabel(code) ?? code))
const NOTE_NONE = `近 ${days} 天里，有最新负面评论主题的商品没有退货记录；评论主题与退货记录都要有数据才会列出`
const NOTE_RESTRICTED = '改进清单要用到退货数据，需要“退货”查看权限'
const NOTE_TRUNCATED = '退货记录很多，只统计了其中一部分，件数可能偏低'

export const restrictedImprovements = (): Improvements => ({ state: 'RESTRICTED', note: NOTE_RESTRICTED, rows: [], days })
export const emptyImprovements = (state: Improvements['state'], note: string): Improvements => ({ state, note, rows: [], days })

export async function loadImprovements(prisma: PrismaService, tenantId: string, stores: readonly ReviewStoreRef[], now: Date): Promise<Improvements> {
  const storeIds = stores.map(store => store.id)
  const names = new Map(stores.map(store => [store.id, store.name]))
  const returns = await prisma.fbaReturnCase.groupBy({
    by: ['sellerAccountId', 'asin', 'reason'],
    where: { tenantId, sellerAccountId: { in: storeIds }, returnDate: { gte: new Date(now.getTime() - days * DAY_MS), lte: now } },
    _sum: { quantity: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { reason: 'asc' }],
    take: 20_000,
  })
  const truncated = returns.length > REVIEWS_LIMITS.ratingRowsMax
  const byAsin = new Map<string, Map<string, number>>()
  for (const row of returns.slice(0, REVIEWS_LIMITS.ratingRowsMax)) {
    const key = keyOf(row.sellerAccountId, row.asin)
    const reasons = byAsin.get(key) ?? new Map<string, number>()
    const code = normalizeReason(row.reason)
    reasons.set(code, (reasons.get(code) ?? 0) + (row._sum.quantity ?? 0))
    byAsin.set(key, reasons)
  }
  const candidates = [...byAsin.keys()].map(key => ({ key, storeId: key.split(SEP)[0], asin: key.split(SEP)[1] }))
  // 每个候选商品最近一次评论主题快照里的负面主题
  const negatives = new Map<string, Array<{ topic: string; mentionRange: string | null; rank: number }>>()
  const snapshotDates = new Map<string, Date>()
  for (const part of chunk(candidates, 500)) {
    const asins = [...new Set(part.map(item => item.asin))]
    const latest = await prisma.reviewTopic.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: { tenantId, sellerAccountId: { in: storeIds }, asin: { in: asins } },
      _max: { snapshotDate: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: 19_999,
    })
    for (const row of latest) if (row._max.snapshotDate && byAsin.has(keyOf(row.sellerAccountId, row.asin))) snapshotDates.set(keyOf(row.sellerAccountId, row.asin), row._max.snapshotDate)
    const dates = [...new Set([...snapshotDates.values()].map(date => date.getTime()))].map(time => new Date(time))
    if (dates.length === 0) continue
    const topics = await prisma.reviewTopic.findMany({
      where: { tenantId, sellerAccountId: { in: storeIds }, asin: { in: asins }, sentiment: 'NEGATIVE', snapshotDate: { in: dates } },
      select: { sellerAccountId: true, asin: true, topicKey: true, mentionRange: true, rank: true, snapshotDate: true },
      orderBy: [{ rank: 'asc' }, { topicKey: 'asc' }],
      take: 19_999,
    })
    for (const topic of topics) {
      const key = keyOf(topic.sellerAccountId, topic.asin)
      if (snapshotDates.get(key)?.getTime() !== topic.snapshotDate.getTime()) continue
      negatives.set(key, [...(negatives.get(key) ?? []), { topic: topic.topicKey, mentionRange: topic.mentionRange, rank: topic.rank }])
    }
  }
  const ranked = candidates
    .filter(item => (negatives.get(item.key)?.length ?? 0) > 0)
    .map(item => ({ ...item, units: [...(byAsin.get(item.key)?.values() ?? [])].reduce((sum, value) => sum + value, 0) }))
    .filter(item => item.units > 0)
    .sort((a, b) => b.units - a.units || textCompare(a.asin, b.asin) || textCompare(a.storeId, b.storeId))
    .slice(0, REVIEWS_LIMITS.improvementsMax)
  if (ranked.length === 0) return { state: 'NO_DATA', note: NOTE_NONE, rows: [], days }
  const titles = await titlesOf(
    prisma,
    tenantId,
    storeIds,
    ranked.map(item => item.asin),
  )
  const rows = ranked.map((item): ImprovementRow => {
    const topics = (negatives.get(item.key) ?? []).slice(0, REVIEWS_LIMITS.improvementTopics)
    const reasons = [...(byAsin.get(item.key)?.entries() ?? [])]
      .sort((a, b) => b[1] - a[1] || textCompare(a[0], b[0]))
      .slice(0, REVIEWS_LIMITS.improvementReasons)
      .map(([code, units]) => ({ code, label: reasonLabelOf(code), units, share: Math.round((units / item.units) * 10_000) / 10_000 }))
    const related = topics.some(topic => reasons.some(reason => topicMatchesReason(topic.topic, reason.code) || topicMatchesReason(topic.topic, reason.label)))
    const top = reasons[0]
    return {
      storeId: item.storeId,
      storeName: names.get(item.storeId) ?? '',
      asin: item.asin,
      title: titles.get(item.key) ?? null,
      negativeTopics: topics.map(topic => ({ topic: topic.topic, mentionRange: topic.mentionRange })),
      returnUnits: item.units,
      returnReasons: reasons,
      possiblyRelated: related,
      snapshotDate: ymd(snapshotDates.get(item.key) as Date),
      suggestion: improvementSuggestion({ topic: topics[0]?.topic ?? null, reasonLabel: top && top.code !== UNSPECIFIED_REASON ? top.label : null, possiblyRelated: related }),
    }
  })
  return { state: 'OK', note: truncated ? NOTE_TRUNCATED : null, rows, days }
}
