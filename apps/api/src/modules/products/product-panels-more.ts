import {
  ASIN360_CATEGORY_TOPIC_LIMIT,
  type Asin360AplusItem,
  type Asin360CategoryTopicRow,
  type Asin360ContentResponse,
  type Asin360RatingPoint,
  type Asin360ReviewsResponse,
  type Asin360ReviewTopic,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { dateText } from '../overview'
import type { ResolvedProduct } from './product-access.service'

// ASIN 360 评价与内容页签接入已有数据（P6-21，16 章 3.1“接入已有数据”）：评分与评论主题（P4-13）、A+ 内容（P4-14）。
// 都按商品所在店铺与 ASIN 取，权限与数据范围由调用方（页签接口）先校验。

const RATING_POINTS = 12
const TOPIC_ROWS = 40
const APLUS_LIMIT = 20
const num = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))

/** JSON 里的星级分布只认键 1 到 5、值是不小于 0 的整数，其余当作没有。 */
export function distributionOf(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, number> = {}
  for (const star of ['1', '2', '3', '4', '5']) {
    const item = (value as Record<string, unknown>)[star]
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0) out[star] = item
  }
  return Object.keys(out).length > 0 ? out : null
}

interface TopicInput {
  topicKey: string
  sentiment: string
  rank: number
}
interface TrendInput {
  month: string
  scope: string
  topicKey: string
  sentiment: string
  rate: number
}

/** 类目对比：本商品的每个主题取最近一个月与上一个月的类目占比（全部商品、前 25% 商品各一列）；类目里没有这个主题的月份是空，不当 0。 */
export function categoryRows(topics: readonly TopicInput[], trends: readonly TrendInput[], month: string | null, previous: string | null): Asin360CategoryTopicRow[] {
  const rate = (topicKey: string, sentiment: string, scope: string, at: string | null) => {
    if (!at) return null
    return trends.find(row => row.month === at && row.scope === scope && row.topicKey === topicKey && row.sentiment === sentiment)?.rate ?? null
  }
  return [...topics]
    .sort((a, b) => (a.sentiment === b.sentiment ? a.rank - b.rank : a.sentiment === 'POSITIVE' ? -1 : 1))
    .slice(0, ASIN360_CATEGORY_TOPIC_LIMIT)
    .map(topic => ({
      topicKey: topic.topicKey,
      sentiment: topic.sentiment === 'POSITIVE' ? 'POSITIVE' : 'NEGATIVE',
      productRank: topic.rank,
      allRate: rate(topic.topicKey, topic.sentiment, 'ALL', month),
      allPrevious: rate(topic.topicKey, topic.sentiment, 'ALL', previous),
      top25Rate: rate(topic.topicKey, topic.sentiment, 'TOP25', month),
      top25Previous: rate(topic.topicKey, topic.sentiment, 'TOP25', previous),
    }))
}

export async function loadReviews(prisma: PrismaService, product: ResolvedProduct): Promise<Omit<Asin360ReviewsResponse, 'pending' | 'basis'>> {
  const base = { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, asin: product.asin }
  const [ratingRows, latestTopic] = await Promise.all([
    prisma.reviewMetricSnapshot.findMany({
      where: base,
      select: { avgRating: true, ratingCount: true, distributionJson: true, captureDate: true, sourceFileName: true },
      orderBy: [{ captureDate: 'desc' }, { id: 'asc' }],
      take: RATING_POINTS,
    }),
    prisma.reviewTopic.aggregate({ where: base, _max: { snapshotDate: true } }),
  ])
  const points: Asin360RatingPoint[] = [...ratingRows].reverse().map(row => ({ date: dateText(row.captureDate), avgRating: num(row.avgRating), ratingCount: row.ratingCount }))
  const newest = ratingRows[0]
  const rating: Asin360ReviewsResponse['rating'] = {
    state: newest ? 'OK' : 'NO_DATA',
    note: newest ? null : '还没有这个商品的评分记录：评分与评分数来自评分文件导入（亚马逊没有这两项的官方接口），导入后显示',
    sourceLabel: '文件导入',
    latest: newest
      ? {
          date: dateText(newest.captureDate),
          avgRating: num(newest.avgRating),
          ratingCount: newest.ratingCount,
          distribution: distributionOf(newest.distributionJson),
          sourceFileName: newest.sourceFileName,
        }
      : null,
    points,
  }

  const snapshot = latestTopic._max.snapshotDate
  const topicRows = snapshot
    ? await prisma.reviewTopic.findMany({
        where: { ...base, snapshotDate: snapshot },
        select: { topicKey: true, sentiment: true, rank: true, mentionRange: true, reviewCountBucket: true, browseNodeId: true, browseNodeName: true },
        orderBy: [{ sentiment: 'asc' }, { rank: 'asc' }, { id: 'asc' }],
        take: TOPIC_ROWS,
      })
    : []
  const topicOf = (row: (typeof topicRows)[number]): Asin360ReviewTopic => ({ rank: row.rank, topicKey: row.topicKey, mentionRange: row.mentionRange, reviewCountBucket: row.reviewCountBucket })
  const topics: Asin360ReviewsResponse['topics'] = {
    state: topicRows.length > 0 ? 'OK' : 'NO_DATA',
    note: topicRows.length > 0 ? null : '还没有这个商品的评论主题：评论主题来自亚马逊客户反馈接口，需要品牌注册并完成同步后显示',
    snapshotDate: snapshot ? dateText(snapshot) : null,
    positive: topicRows.filter(row => row.sentiment === 'POSITIVE').map(topicOf),
    negative: topicRows.filter(row => row.sentiment === 'NEGATIVE').map(topicOf),
  }

  const node = topicRows.find(row => row.browseNodeId)
  const empty = (note: string): Asin360ReviewsResponse['category'] => ({ state: 'NO_DATA', note, browseNodeName: node?.browseNodeName ?? null, month: null, previousMonth: null, rows: [] })
  if (topicRows.length === 0) return { rating, topics, category: empty('需要先有这个商品的评论主题，才能和类目对比') }
  if (!node?.browseNodeId) return { rating, topics, category: empty('评论主题里没有给出这个商品所在的类目，无法和类目对比') }
  const months = await prisma.browseNodeReviewTrend.findMany({
    where: { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, browseNodeId: node.browseNodeId },
    select: { month: true },
    distinct: ['month'],
    orderBy: { month: 'desc' },
    take: 2,
  })
  if (months.length === 0) return { rating, topics, category: empty('这个类目还没有同步到主题占比（类目数据按月同步）') }
  const [current, before] = months
  const trends = await prisma.browseNodeReviewTrend.findMany({
    where: {
      tenantId: product.tenantId,
      sellerAccountId: product.sellerAccountId,
      browseNodeId: node.browseNodeId,
      month: { in: months.map(row => row.month) },
      topicKey: { in: topicRows.map(row => row.topicKey) },
    },
    select: { month: true, scope: true, topicKey: true, sentiment: true, rate: true },
    take: 400,
  })
  const category: Asin360ReviewsResponse['category'] = {
    state: 'OK',
    note: null,
    browseNodeName: node.browseNodeName,
    month: dateText(current!.month),
    previousMonth: before ? dateText(before.month) : null,
    rows: categoryRows(
      topicRows,
      trends.map(row => ({ month: dateText(row.month), scope: row.scope, topicKey: row.topicKey, sentiment: row.sentiment, rate: Number(row.rate.toString()) })),
      dateText(current!.month),
      before ? dateText(before.month) : null,
    ),
  }
  return { rating, topics, category }
}

export async function loadAplus(prisma: PrismaService, product: ResolvedProduct): Promise<Asin360ContentResponse['aplus']> {
  const rows = await prisma.aplusAsinRelation.findMany({
    where: { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, asin: product.asin },
    select: { publishedAt: true, content: { select: { id: true, name: true, status: true, locale: true, amazonUpdatedAt: true, rejectionReason: true } } },
    orderBy: [{ content: { updatedAt: 'desc' } }, { id: 'asc' }],
    take: APLUS_LIMIT + 1,
  })
  const items: Asin360AplusItem[] = rows.slice(0, APLUS_LIMIT).map(row => ({
    contentId: row.content.id,
    name: row.content.name,
    status: row.content.status,
    locale: row.content.locale,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    amazonUpdatedAt: row.content.amazonUpdatedAt?.toISOString() ?? null,
    rejectionReason: row.content.rejectionReason,
  }))
  return {
    state: items.length > 0 ? 'OK' : 'NO_DATA',
    note: items.length > 0 ? null : '没有关联到这个 ASIN 的 A+ 内容：在“A+ 内容管理”里创建并关联，或同步亚马逊上已有的 A+ 内容后显示',
    items,
    truncated: rows.length > APLUS_LIMIT,
  }
}
