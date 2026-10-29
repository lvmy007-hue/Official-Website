import { FEEDBACK_NO_BRAND_ACCESS, REVIEWS_LIMITS, REVIEWS_MARKETPLACE_ID, REVIEW_ASIN_PATTERN, normalizeReviewAsin } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { isFeedbackForbidden, isFeedbackNoData, type FeedbackApi } from '../../connectors/feedback-api'
import type { ImportContext } from '../../types'
import { parseBrowseNode, parseItemTopics, parseTrends, type ParsedBrowseNode } from './parse'

// 客户反馈同步器（importers.md I-15，P4-13）：每日一次，每次轮转一批商品，读商品评论主题（前 10 正面、前 10 负面）、所在类目的评论主题趋势与退货主题趋势。只读、固定美国站。
// 规则：
//   - 商品取自目录（FbaProduct，店铺内去重的 ASIN）；没有目录就以“不适用”结束；
//   - 每次最多处理 REVIEWS_LIMITS.syncAsinsMax 个：距上次快照不足 REVIEWS_LIMITS.syncSkipFreshDays 天的跳过；其余里，最近一次快照最旧的先做，从没有快照的也先做，
//     但为防止“接口一直没有数据的商品”永远排在最前面饿死其他商品，没有快照的商品最多占一半名额（另一半没人用时让出来），并按日期轮转着取；
//   - 一个商品的流程：取浏览节点 →（本次第一次遇到这个节点才）取并写入类目评论趋势与退货趋势 → 取主题并写入。主题最后写，所以中途被限速打断时，这个商品还没有今天的快照，重试会接着做；
//   - 同一天重跑：先删后写该商品当天的主题（避免旧主题残留）；类目趋势先删后写该节点该店铺的旧数据，都在同一事务里；接口这次没给数据（空）就不动已有数据；
//   - 单个商品或节点 400 / 404（没有数据、不支持）只跳过并计数；429、5xx 与网络错误原样抛出，由任务重试；403（没有品牌分析权限）以不可重试的失败码结束；
//   - ASIN 之间串行；日志与返回值里不放亚马逊的响应原文。

export interface FeedbackScope {
  tenantId: string
  sellerAccountId: string
}
export interface FeedbackSyncOptions {
  /** 本次同步的时间（轮转按它取日期槽）；测试注入，缺省取当前时间。 */
  now?: Date
  /** 企业数据口径的“今天”（UTC 零点的日期）：主题快照的日期；缺省取 now 的 UTC 日期。 */
  today?: Date
  maxAsins?: number
}
export type FeedbackSyncResult =
  | { notApplicable: true; reason: 'NO_CATALOG'; imported: 0 }
  | {
      notApplicable: false
      imported: number
      candidates: number
      processed: number
      topicRows: number
      trendRows: number
      nodes: number
      asinsWithoutData: number
      nodesWithoutData: number
      skippedFresh: number
      skippedEntries: number
      outOfRange: number
      incomplete: boolean
    }

/** 目录里最多读这么多个 ASIN（Prisma take 上限 20000，留余量）。 */
const CATALOG_READ_MAX = REVIEWS_LIMITS.optionsMax * 50
const GROUP_READ_MAX = 20_000
const DAY_MS = 86_400_000

export interface AsinRotationItem {
  asin: string
  /** 最近一次主题快照日期；从没有为 null。 */
  last: Date | null
}

const byAsin = (a: AsinRotationItem, b: AsinRotationItem) => (a.asin < b.asin ? -1 : a.asin > b.asin ? 1 : 0)

/** 挑出本次要处理的商品（纯函数）：返回选中的 ASIN、因为“还新鲜”被跳过的个数、需要处理的候选总数。 */
export function pickAsins(items: readonly AsinRotationItem[], now: Date, today: Date, limit: number): { chosen: string[]; skippedFresh: number; candidates: number } {
  const due = items.filter(item => !item.last || (today.getTime() - item.last.getTime()) / DAY_MS >= REVIEWS_LIMITS.syncSkipFreshDays)
  const stale = due.filter(item => item.last).sort((a, b) => a.last!.getTime() - b.last!.getTime() || byAsin(a, b))
  const fresh = due.filter(item => !item.last).sort(byAsin)
  const cap = Math.max(0, Math.floor(limit))
  const takeFresh = Math.min(fresh.length, cap - Math.min(stale.length, Math.floor(cap / 2)))
  const takeStale = Math.min(stale.length, cap - takeFresh)
  // 没有快照的商品按日期槽轮转：每天从上一天取到的位置接着往后取，窗口刚好首尾相接
  const offset = fresh.length > 0 && takeFresh > 0 ? (Math.floor(now.getTime() / DAY_MS) * takeFresh) % fresh.length : 0
  const rotated = [...fresh.slice(offset), ...fresh.slice(0, offset)]
  const chosen = [...rotated.slice(0, takeFresh), ...stale.slice(0, takeStale)].map(item => item.asin)
  return { chosen, skippedFresh: items.length - due.length, candidates: due.length }
}

async function guarded<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (isFeedbackForbidden(error)) throw new NonRetryableError(FEEDBACK_NO_BRAND_ACCESS, '店铺没有品牌分析权限（需要品牌备案并授予“品牌分析”角色），客户反馈数据无法同步')
    throw error
  }
}
/** 400 / 404 当作“没有数据”返回 null；其余错误原样抛出。 */
async function optional(task: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
  try {
    return await guarded(task)
  } catch (error) {
    if (isFeedbackNoData(error)) return null
    throw error
  }
}

const monthDate = (month: string) => new Date(`${month}T00:00:00.000Z`)

interface Counts {
  topicRows: number
  trendRows: number
  nodes: number
  asinsWithoutData: number
  nodesWithoutData: number
  skippedEntries: number
  outOfRange: number
  processed: number
}

/** 一个浏览节点：取评论趋势与退货趋势并整体替换这个店铺该节点的旧数据；哪一种这次没给数据就不动哪一种。 */
async function syncNode(ctx: ImportContext, api: FeedbackApi, scope: FeedbackScope, node: ParsedBrowseNode & { browseNodeId: string }, counts: Counts) {
  const reviewBody = await optional(() => api.getBrowseNodeReviewTrends(node.browseNodeId))
  const returnBody = await optional(() => api.getBrowseNodeReturnTrends(node.browseNodeId))
  counts.nodes += 1
  if (reviewBody === null && returnBody === null) counts.nodesWithoutData += 1
  const review = parseTrends(reviewBody, 'review')
  const returns = parseTrends(returnBody, 'return')
  counts.skippedEntries += review.skipped + returns.skipped
  counts.outOfRange += review.outOfRange + returns.outOfRange
  const base = { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, browseNodeId: node.browseNodeId, browseNodeName: node.browseNodeName }
  const where = { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, browseNodeId: node.browseNodeId }
  const reviewData = review.rows.flatMap(row => (row.sentiment ? [{ ...base, scope: row.scope, month: monthDate(row.month), topicKey: row.topicKey, sentiment: row.sentiment, rate: row.rate }] : []))
  const returnData = returns.rows.map(row => ({ ...base, scope: row.scope, month: monthDate(row.month), returnTopicKey: row.topicKey, rate: row.rate }))
  if (reviewData.length === 0 && returnData.length === 0) return
  await ctx.prisma.$transaction(async tx => {
    if (reviewData.length > 0) {
      await tx.browseNodeReviewTrend.deleteMany({ where })
      counts.trendRows += (await tx.browseNodeReviewTrend.createMany({ data: reviewData, skipDuplicates: true })).count
    }
    if (returnData.length > 0) {
      await tx.browseNodeReturnTrend.deleteMany({ where })
      counts.trendRows += (await tx.browseNodeReturnTrend.createMany({ data: returnData, skipDuplicates: true })).count
    }
  })
}

export async function syncFeedback(ctx: ImportContext, api: FeedbackApi, scope: FeedbackScope, options: FeedbackSyncOptions = {}): Promise<FeedbackSyncResult> {
  const now = options.now ?? new Date()
  const today = options.today ?? new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  const products = await ctx.prisma.fbaProduct.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, marketplaceId: REVIEWS_MARKETPLACE_ID },
    distinct: ['asin'],
    select: { asin: true },
    orderBy: { asin: 'asc' },
    take: CATALOG_READ_MAX,
  })
  const asins = [...new Set(products.map(row => normalizeReviewAsin(row.asin)).filter(asin => REVIEW_ASIN_PATTERN.test(asin)))]
  if (asins.length === 0) return { notApplicable: true, reason: 'NO_CATALOG', imported: 0 }

  const groups = await ctx.prisma.reviewTopic.groupBy({
    by: ['asin'],
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId },
    _max: { snapshotDate: true },
    orderBy: { asin: 'asc' },
    take: GROUP_READ_MAX,
  })
  const lastOf = new Map(groups.map(group => [group.asin, group._max.snapshotDate]))
  const { chosen, skippedFresh, candidates } = pickAsins(
    asins.map(asin => ({ asin, last: lastOf.get(asin) ?? null })),
    now,
    today,
    options.maxAsins ?? REVIEWS_LIMITS.syncAsinsMax,
  )

  const counts: Counts = { topicRows: 0, trendRows: 0, nodes: 0, asinsWithoutData: 0, nodesWithoutData: 0, skippedEntries: 0, outOfRange: 0, processed: 0 }
  const nodesDone = new Set<string>()
  for (const asin of chosen) {
    const node = parseBrowseNode(await optional(() => api.getItemBrowseNode(asin)))
    if (node.browseNodeId && !nodesDone.has(node.browseNodeId)) {
      nodesDone.add(node.browseNodeId)
      await syncNode(ctx, api, scope, { ...node, browseNodeId: node.browseNodeId }, counts)
    }
    const body = await optional(() => api.getItemReviewTopics(asin))
    const topics = parseItemTopics(body)
    counts.skippedEntries += topics.skipped
    counts.processed += 1
    if (topics.rows.length === 0) {
      counts.asinsWithoutData += 1
      continue
    }
    await ctx.prisma.$transaction(async tx => {
      await tx.reviewTopic.deleteMany({ where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, asin, snapshotDate: today } })
      const created = await tx.reviewTopic.createMany({
        data: topics.rows.map(row => ({
          tenantId: scope.tenantId,
          sellerAccountId: scope.sellerAccountId,
          asin,
          browseNodeId: node.browseNodeId,
          browseNodeName: node.browseNodeName,
          topicKey: row.topicKey,
          sentiment: row.sentiment,
          rank: row.rank,
          mentionRange: row.mentionRange,
          reviewCountBucket: row.reviewCountBucket,
          snapshotDate: today,
        })),
        skipDuplicates: true,
      })
      counts.topicRows += created.count
    })
  }
  const { processed, ...rest } = counts
  return { notApplicable: false, imported: counts.topicRows + counts.trendRows, candidates, processed, ...rest, skippedFresh, incomplete: candidates > chosen.length }
}
