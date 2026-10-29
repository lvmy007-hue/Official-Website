import { payloadNumber, type AdsTargetRow } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { num } from './ads-campaigns-common'
import { anyRowInScope, entityMetricMap, type MetricRef } from './ads-campaigns-load'
import { compareText } from './ads-page'
import type { AdsLoadContext } from './ads-overview-load'

// 投放对象行的装配（P3-07 活动页签与 P3-08 广告组页签共用）：关键词表与投放表合并、指标与官方建议竞价、按花费排序。
// 同一个关键词若同时出现在关键词表与投放表，两边都列（编号不同），不去重。

export interface TargetRowsInput {
  adsProfileId: string
  ref: MetricRef
  /** 关键词限定到活动（外部编号）或广告组（外部编号）。 */
  keywordScope: { campaignId: string } | { adGroupId: string | { in: string[] } }
  /** 投放表限定到这些广告组（外部编号）；空数组不查投放表。 */
  targetGroupIds: readonly string[]
  /** 活动页签把受众单独放一个页签，所以排除；广告组页签没有受众页签，要列出来。 */
  excludeAudience: boolean
  groupNames: ReadonlyMap<string, string>
  from: string
  to: string
  needle: string | undefined
  limit: number
}

export async function loadTargetRows(prisma: PrismaService, ctx: AdsLoadContext, input: TargetRowsInput): Promise<{ rows: AdsTargetRow[]; truncated: boolean }> {
  const { limit } = input
  const [targets, keywords] = await Promise.all([
    input.targetGroupIds.length === 0
      ? Promise.resolve([])
      : prisma.adsTarget.findMany({
          where: {
            tenantId: ctx.tenantId,
            adsProfileId: input.adsProfileId,
            adGroupId: { in: [...input.targetGroupIds] },
            ...(input.excludeAudience ? { kind: { not: 'AUDIENCE' } } : {}),
          },
          select: { id: true, targetId: true, kind: true, expression: true, matchType: true, bid: true, state: true, adGroupId: true },
          orderBy: [{ targetId: 'asc' }],
          take: limit + 1,
        }),
    prisma.adsKeyword.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: input.adsProfileId, ...input.keywordScope },
      select: { id: true, keywordId: true, text: true, matchType: true, bid: true, state: true, adGroupId: true },
      orderBy: [{ keywordId: 'asc' }],
      take: limit + 1,
    }),
  ])
  const entries = [
    ...keywords.slice(0, limit).map(row => ({
      id: row.id,
      targetId: row.keywordId,
      kind: 'KEYWORD',
      expression: row.text,
      matchType: row.matchType as string | null,
      bid: row.bid,
      state: row.state,
      adGroupId: row.adGroupId,
    })),
    ...targets
      .slice(0, limit)
      .map(row => ({ id: row.id, targetId: row.targetId, kind: row.kind, expression: row.expression, matchType: row.matchType, bid: row.bid, state: row.state, adGroupId: row.adGroupId })),
  ]
  const ids = entries.map(entry => entry.targetId)
  const [metrics, recommendations] = await Promise.all([
    entityMetricMap(prisma, ctx, { ref: input.ref, entityTypes: ['TARGET', 'KEYWORD'], entityIds: ids, from: input.from, to: input.to }),
    ids.length === 0
      ? Promise.resolve([])
      : prisma.adsRecommendation.findMany({
          where: { tenantId: ctx.tenantId, adsProfileId: input.adsProfileId, entityId: { in: ids }, status: 'NEW' },
          select: { entityId: true, payloadJson: true },
          orderBy: [{ receivedAt: 'desc' }],
          take: 2000,
        }),
  ])
  const suggested = new Map<string, number>()
  for (const recommendation of recommendations) {
    const value = payloadNumber(recommendation.payloadJson, ['suggestedBid', 'recommendedBid'])
    if (value !== null && !suggested.has(recommendation.entityId)) suggested.set(recommendation.entityId, value)
  }
  const needle = input.needle?.toLowerCase()
  const rows = entries
    .filter(entry => !needle || entry.expression.toLowerCase().includes(needle))
    .map((entry): AdsTargetRow => ({
      id: entry.id,
      key: `${entry.kind}:${entry.targetId}`,
      targetId: entry.targetId,
      kind: entry.kind,
      expression: entry.expression,
      matchType: entry.matchType,
      bid: num(entry.bid),
      state: entry.state,
      adGroupId: entry.adGroupId,
      adGroupName: input.groupNames.get(entry.adGroupId) ?? null,
      suggestedBid: suggested.get(entry.targetId) ?? null,
      metrics: metrics.get(entry.targetId) ?? null,
    }))
    .sort((a, b) => {
      // 花费高的在前；没有指标的排最后，再按表达式与编号保证翻页顺序稳定
      const left = a.metrics?.spend ?? null
      const right = b.metrics?.spend ?? null
      if (left === null && right !== null) return 1
      if (left !== null && right === null) return -1
      if (left !== null && right !== null && left !== right) return right - left
      return compareText(a.expression.toLowerCase(), b.expression.toLowerCase()) || compareText(a.key, b.key)
    })
  return { rows, truncated: targets.length > limit || keywords.length > limit }
}

/** 可见范围内关键词表或投放表是否出现过任何行：区分“同步器尚未接入”与“这里没有”。 */
export async function targetSourcesExist(prisma: PrismaService, ctx: AdsLoadContext): Promise<boolean> {
  const found = await Promise.all([anyRowInScope(prisma, ctx, 'adsTarget'), anyRowInScope(prisma, ctx, 'adsKeyword')])
  return found.some(Boolean)
}
