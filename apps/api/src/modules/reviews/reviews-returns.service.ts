import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import { FEEDBACK_FRESHNESS_KEY, REVIEWS_LIMITS, REVIEWS_RETURNS_BASIS, RETURNS_PERMISSION, lastMonths, type ReturnNodeOption, type ReturnTopicRow, type ReturnsTabResponse } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { sourceFreshness } from '../inventory'
import { keyOf, num, textCompare, ymd, type ReviewsTabInput } from './reviews-common'
import { emptyFeedbackState, noBrandStores } from './reviews-feedback'
import { emptyImprovements, loadImprovements, restrictedImprovements } from './reviews-improvements'

type Selected = NonNullable<ReturnsTabResponse['selectedNode']>

/** 退货主题（05 章 5.7）：只到类目（浏览节点）级，近 6 个月的退货主题占比，分“全部商品”“前 25% 商品”两档；改进清单把负面评论主题与近期退货原因并排。 */
@Injectable()
export class ReviewsReturnsService {
  constructor(private readonly prisma: PrismaService) {}

  private async nodes(tenantId: string, stores: ReviewsTabInput['stores']): Promise<ReturnNodeOption[]> {
    const storeIds = stores.map(store => store.id)
    const groups = await this.prisma.browseNodeReturnTrend.groupBy({
      by: ['sellerAccountId', 'browseNodeId'],
      where: { tenantId, sellerAccountId: { in: storeIds } },
      _max: { browseNodeName: true },
      orderBy: [{ sellerAccountId: 'asc' }, { browseNodeId: 'asc' }],
      take: REVIEWS_LIMITS.optionsMax,
    })
    if (groups.length === 0) return []
    const asinGroups = await this.prisma.reviewTopic.groupBy({
      by: ['sellerAccountId', 'browseNodeId', 'asin'],
      where: { tenantId, sellerAccountId: { in: storeIds }, browseNodeId: { in: [...new Set(groups.map(group => group.browseNodeId))] } },
      orderBy: [{ sellerAccountId: 'asc' }, { browseNodeId: 'asc' }, { asin: 'asc' }],
      take: REVIEWS_LIMITS.ratingRowsMax,
    })
    const counts = new Map<string, number>()
    for (const row of asinGroups) if (row.browseNodeId) counts.set(keyOf(row.sellerAccountId, row.browseNodeId), (counts.get(keyOf(row.sellerAccountId, row.browseNodeId)) ?? 0) + 1)
    const names = new Map(stores.map(store => [store.id, store.name]))
    return groups
      .map((group): ReturnNodeOption => ({
        storeId: group.sellerAccountId,
        storeName: names.get(group.sellerAccountId) ?? '',
        browseNodeId: group.browseNodeId,
        browseNodeName: group._max.browseNodeName,
        asinCount: counts.get(keyOf(group.sellerAccountId, group.browseNodeId)) ?? 0,
      }))
      .sort((a, b) => textCompare(a.storeName, b.storeName) || textCompare(a.browseNodeName ?? a.browseNodeId, b.browseNodeName ?? b.browseNodeId) || textCompare(a.browseNodeId, b.browseNodeId))
  }

  private async selected(tenantId: string, node: ReturnNodeOption): Promise<Selected> {
    const rows = await this.prisma.browseNodeReturnTrend.findMany({
      where: { tenantId, sellerAccountId: node.storeId, browseNodeId: node.browseNodeId },
      select: { scope: true, month: true, returnTopicKey: true, rate: true },
      orderBy: [{ month: 'desc' }, { returnTopicKey: 'asc' }, { scope: 'asc' }],
      take: 5000,
    })
    const months = lastMonths(rows.map(row => ymd(row.month)))
    const rate = new Map(rows.map(row => [`${row.returnTopicKey}|${row.scope}|${ymd(row.month)}`, num(row.rate)]))
    const rateOf = (topic: string, scope: 'ALL' | 'TOP25', month: string): number | null => rate.get(`${topic}|${scope}|${month}`) ?? null
    const topics = [...new Set(rows.filter(row => months.includes(ymd(row.month))).map(row => row.returnTopicKey))].map((topic): ReturnTopicRow => {
      const own = months.filter(month => rate.has(`${topic}|ALL|${month}`) || rate.has(`${topic}|TOP25|${month}`))
      const latestMonth = own[own.length - 1]
      return {
        topic,
        rateAll: rateOf(topic, 'ALL', latestMonth),
        rateTop: rateOf(topic, 'TOP25', latestMonth),
        latestMonth,
        series: months.map(month => ({ month, all: rateOf(topic, 'ALL', month), top: rateOf(topic, 'TOP25', month) })),
      }
    })
    topics.sort((a, b) => (b.rateAll ?? -1) - (a.rateAll ?? -1) || (b.rateTop ?? -1) - (a.rateTop ?? -1) || textCompare(a.topic, b.topic))
    return { storeId: node.storeId, storeName: node.storeName, browseNodeId: node.browseNodeId, browseNodeName: node.browseNodeName, months, topics }
  }

  async tab(input: ReviewsTabInput): Promise<ReturnsTabResponse> {
    const { tenantId, scope, query, stores, permissions, now } = input
    const storeIds = stores.map(store => store.id)
    const freshness = await sourceFreshness(this.prisma, tenantId, scope, [FEEDBACK_FRESHNESS_KEY], now)
    const nodes = storeIds.length > 0 ? await this.nodes(tenantId, stores) : []
    const noBrand = await noBrandStores(this.prisma, tenantId, storeIds)
    const empty = emptyFeedbackState(storeIds, noBrand, query.storeId)
    const canReturns = hasPermission([...permissions], RETURNS_PERMISSION)
    const base = { tab: 'returns' as const, stores, freshness, basis: REVIEWS_RETURNS_BASIS }
    // 改进清单只依赖评论主题与退货记录，不依赖类目趋势；没有退货权限时返回“无权限”而不是 403
    const topicsExist = storeIds.length > 0 && (await this.prisma.reviewTopic.count({ where: { tenantId, sellerAccountId: { in: storeIds } } })) > 0
    const improvements = !canReturns ? restrictedImprovements() : topicsExist ? await loadImprovements(this.prisma, tenantId, stores, now) : emptyImprovements(empty.state, empty.note)
    if (nodes.length === 0) return { ...base, ...empty, nodes, selectedNode: null, improvements }
    const node = nodes.find(item => (!query.storeId || item.storeId === query.storeId) && (!query.nodeId || item.browseNodeId === query.nodeId))
    if (!node) return { ...base, state: 'NO_DATA', note: '没有找到这个类目的退货主题；可能还没有同步到，或不在你的数据范围内', nodes, selectedNode: null, improvements }
    return { ...base, state: 'OK', note: null, nodes, selectedNode: await this.selected(tenantId, node), improvements }
  }
}
