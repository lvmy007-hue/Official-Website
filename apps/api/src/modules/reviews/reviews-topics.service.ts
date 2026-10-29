import { Injectable } from '@nestjs/common'
import {
  FEEDBACK_FRESHNESS_KEY,
  REVIEWS_LIMITS,
  REVIEWS_TOPICS_BASIS,
  REVIEW_TREND_SCOPES,
  lastMonths,
  normalizeReviewAsin,
  type ReviewSentiment,
  type ReviewTrendScope,
  type TopicAsinOption,
  type TopicRow,
  type TopicsSelected,
  type TopicsTabResponse,
  type TrendSeries,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { sourceFreshness } from '../inventory'
import { keyOf, num, titlesOf, ymd, type ReviewsTabInput } from './reviews-common'
import { emptyFeedbackState, noBrandStores } from './reviews-feedback'

const NOTE_NO_TOPICS = '这个商品没有评论主题记录；品牌分析接口只返回有足够评论的商品，下一次每周同步后再看'
const NOTE_NO_NODE = '这个商品没有类目（浏览节点）信息，无法与类目对比'
const NOTE_NO_TREND = '还没有同步到这个类目的主题趋势，需要等下一次每周同步'

type Slot = { storeId: string; asin: string; date: Date }
const sentimentOf = (value: string): ReviewSentiment => (value === 'POSITIVE' ? 'POSITIVE' : 'NEGATIVE')

/** 评论主题（05 章 5.7）：一个商品最近一次同步的前 10 个正面与负面主题，与所在类目（浏览节点）最近一个月的主题占比对比，并给出近 6 个月趋势。 */
@Injectable()
export class ReviewsTopicsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 每个（店铺，ASIN）最近一次快照，最近同步的排前面。 */
  private async slots(tenantId: string, storeIds: readonly string[]): Promise<Slot[]> {
    const groups = await this.prisma.reviewTopic.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: { tenantId, sellerAccountId: { in: [...storeIds] } },
      _max: { snapshotDate: true },
      orderBy: [{ _max: { snapshotDate: 'desc' } }, { sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: REVIEWS_LIMITS.optionsMax,
    })
    return groups.flatMap(group => (group._max.snapshotDate ? [{ storeId: group.sellerAccountId, asin: group.asin, date: group._max.snapshotDate }] : []))
  }

  private async latestSlot(tenantId: string, storeId: string, asin: string): Promise<Slot | null> {
    const latest = await this.prisma.reviewTopic.aggregate({ where: { tenantId, sellerAccountId: storeId, asin }, _max: { snapshotDate: true } })
    return latest._max.snapshotDate ? { storeId, asin, date: latest._max.snapshotDate } : null
  }

  private async selected(tenantId: string, slot: Slot, storeName: string, title: string | null): Promise<TopicsSelected> {
    const rows = await this.prisma.reviewTopic.findMany({
      where: { tenantId, sellerAccountId: slot.storeId, asin: slot.asin, snapshotDate: slot.date },
      orderBy: [{ sentiment: 'asc' }, { rank: 'asc' }, { topicKey: 'asc' }],
      take: REVIEWS_LIMITS.topicsPerSentiment * 2 + 20,
    })
    const nodeRow = rows.find(row => row.browseNodeId)
    const nodeId = nodeRow?.browseNodeId ?? null
    const trendRows = nodeId
      ? await this.prisma.browseNodeReviewTrend.findMany({
          where: { tenantId, sellerAccountId: slot.storeId, browseNodeId: nodeId, topicKey: { in: [...new Set(rows.map(row => row.topicKey))] } },
          select: { scope: true, month: true, topicKey: true, sentiment: true, rate: true, browseNodeName: true },
          orderBy: [{ month: 'desc' }, { topicKey: 'asc' }, { scope: 'asc' }],
          take: 5000,
        })
      : []
    const months = lastMonths(trendRows.map(row => ymd(row.month)))
    const latestMonth = months.length > 0 ? months[months.length - 1] : null
    const rate = new Map(trendRows.map(row => [`${row.topicKey}|${row.sentiment}|${row.scope}|${ymd(row.month)}`, num(row.rate)]))
    const rateOf = (topic: string, sentiment: string, scope: ReviewTrendScope, month: string | null): number | null => (month ? (rate.get(`${topic}|${sentiment}|${scope}|${month}`) ?? null) : null)
    const rowOf = (row: (typeof rows)[number]): TopicRow => ({
      rank: row.rank,
      topic: row.topicKey,
      sentiment: sentimentOf(row.sentiment),
      mentionRange: row.mentionRange,
      reviewCountBucket: row.reviewCountBucket,
      categoryAll: rateOf(row.topicKey, row.sentiment, 'ALL', latestMonth),
      categoryTop: rateOf(row.topicKey, row.sentiment, 'TOP25', latestMonth),
    })
    const bySentiment = (sentiment: ReviewSentiment) =>
      rows
        .filter(row => row.sentiment === sentiment)
        .slice(0, REVIEWS_LIMITS.topicsPerSentiment)
        .map(rowOf)
    const positive = bySentiment('POSITIVE')
    const negative = bySentiment('NEGATIVE')
    const trend: TrendSeries[] = []
    for (const topic of [...positive, ...negative])
      for (const scope of REVIEW_TREND_SCOPES) {
        const points = months.map(month => ({ month, rate: rateOf(topic.topic, topic.sentiment, scope, month) }))
        if (points.some(point => point.rate !== null)) trend.push({ topic: topic.topic, sentiment: topic.sentiment, scope, points })
      }
    return {
      storeId: slot.storeId,
      storeName,
      asin: slot.asin,
      title,
      snapshotDate: ymd(slot.date),
      browseNodeId: nodeId,
      browseNodeName: nodeRow?.browseNodeName ?? trendRows.find(row => row.browseNodeName)?.browseNodeName ?? null,
      positive,
      negative,
      trend,
      trendMonths: months,
      categoryNote: !nodeId ? NOTE_NO_NODE : trendRows.length === 0 ? NOTE_NO_TREND : null,
    }
  }

  async tab(input: ReviewsTabInput): Promise<TopicsTabResponse> {
    const { tenantId, scope, query, stores, now } = input
    const storeIds = stores.map(store => store.id)
    const names = new Map(stores.map(store => [store.id, store.name]))
    const base = { tab: 'topics' as const, stores, basis: REVIEWS_TOPICS_BASIS }
    const freshness = await sourceFreshness(this.prisma, tenantId, scope, [FEEDBACK_FRESHNESS_KEY], now)
    const slots = storeIds.length > 0 ? await this.slots(tenantId, storeIds) : []
    const asin = query.asin ? normalizeReviewAsin(query.asin) : undefined
    const titles = await titlesOf(
      this.prisma,
      tenantId,
      storeIds,
      slots.map(slot => slot.asin),
    )
    const options = slots.map((slot): TopicAsinOption => ({
      storeId: slot.storeId,
      storeName: names.get(slot.storeId) ?? '',
      asin: slot.asin,
      title: titles.get(keyOf(slot.storeId, slot.asin)) ?? null,
      snapshotDate: ymd(slot.date),
    }))
    const noBrand = await noBrandStores(this.prisma, tenantId, storeIds)
    if (options.length === 0) return { ...base, ...emptyFeedbackState(storeIds, noBrand, query.storeId), options, selected: null, freshness }

    const wanted = slots.find(slot => (!query.storeId || slot.storeId === query.storeId) && (!asin || slot.asin === asin))
    // 指定的商品不在最近 200 个里时直接按店铺与 ASIN 查
    const slot = wanted ?? (query.storeId && asin ? await this.latestSlot(tenantId, query.storeId, asin) : null)
    if (!slot) {
      const blocked = query.storeId ? noBrand.has(query.storeId) : false
      return { ...base, ...(blocked ? emptyFeedbackState(storeIds, noBrand, query.storeId) : { state: 'NO_DATA' as const, note: NOTE_NO_TOPICS }), options, selected: null, freshness }
    }
    const title = titles.get(keyOf(slot.storeId, slot.asin)) ?? (await titlesOf(this.prisma, tenantId, [slot.storeId], [slot.asin])).get(keyOf(slot.storeId, slot.asin)) ?? null
    const selected = await this.selected(tenantId, slot, names.get(slot.storeId) ?? '', title)
    return { ...base, state: 'OK', note: null, options, selected, freshness }
  }
}
