import { ADS_CONSOLE_CURRENCY, termKey, termStatus, type AdsSearchTermRow, type AdsTargetRow } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { asDate } from '../overview'
import { num } from './ads-campaigns-common'
import type { AdsLoadContext } from './ads-overview-load'
import { loadTargetRows } from './ads-target-rows'
import type { AdGroupRecord } from './ads-asin-tab-math'

// ASIN 360 广告页签里的投放对象与搜索词（P3-19）：按“关联这个 ASIN 的广告组”取数，每个广告档案各取一遍再由调用方合并。
// 指标是投放对象、搜索词自己的合计，亚马逊没有按 ASIN 拆开，页面与响应里都写明了这一点。

export interface ProfileGroups {
  adsProfileId: string
  groups: readonly AdGroupRecord[]
}

/** 把广告组记录按档案分组。 */
export function groupsByProfile(records: readonly AdGroupRecord[]): ProfileGroups[] {
  const map = new Map<string, AdGroupRecord[]>()
  for (const record of records) map.set(record.adsProfileId, [...(map.get(record.adsProfileId) ?? []), record])
  // 档案按编号排序：跨档案合并搜索词时“状态以第一个出现的为准”，顺序必须固定
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([adsProfileId, groups]) => ({ adsProfileId, groups }))
}

/** 一个档案下这些广告组的投放对象（关键词表加投放表），按花费排序；limit 之外的标记截断。 */
export async function profileTargets(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  input: ProfileGroups & { from: string; to: string; limit: number },
): Promise<{ rows: AdsTargetRow[]; truncated: boolean }> {
  const ids = input.groups.map(group => group.adGroupId)
  return loadTargetRows(prisma, ctx, {
    adsProfileId: input.adsProfileId,
    ref: { adsProfileId: input.adsProfileId, currency: ADS_CONSOLE_CURRENCY, adProduct: null },
    keywordScope: { adGroupId: { in: ids } },
    targetGroupIds: ids,
    excludeAudience: false,
    groupNames: new Map(input.groups.map(group => [group.adGroupId, group.name])),
    from: input.from,
    to: input.to,
    needle: undefined,
    limit: input.limit,
  })
}

/**
 * 一个档案下这些广告组的搜索词（词级报表按搜索词汇总，花费从高到低），并标出是否已被投放或已否定。
 * “已投放”“已否定”按完全相同判断（不分大小写、合并多余空格）；否定词看这些广告组所属活动的活动级与这些广告组自己的广告组级。
 */
export async function profileTerms(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  input: ProfileGroups & { from: string; to: string; limit: number },
): Promise<{ rows: AdsSearchTermRow[]; truncated: boolean }> {
  const adGroupIds = input.groups.map(group => group.adGroupId)
  const campaignIds = [...new Set(input.groups.map(group => group.campaignId))]
  const found = await prisma.adsTermMetric.groupBy({
    by: ['searchTerm'],
    where: {
      tenantId: ctx.tenantId,
      adsProfileId: input.adsProfileId,
      adGroupId: { in: adGroupIds },
      level: 'SEARCH_TERM',
      currency: ADS_CONSOLE_CURRENCY,
      reportDate: { gte: asDate(input.from), lte: asDate(input.to) },
      searchTerm: { not: null },
    },
    _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    orderBy: [{ _sum: { cost: 'desc' } }, { searchTerm: 'asc' }],
    take: input.limit + 1,
  })
  if (found.length === 0) return { rows: [], truncated: false }
  const [keywords, targets, negatives] = await Promise.all([
    prisma.adsKeyword.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: input.adsProfileId, adGroupId: { in: adGroupIds } },
      select: { text: true },
      orderBy: [{ keywordId: 'asc' }],
      take: 5000,
    }),
    prisma.adsTarget.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: input.adsProfileId, adGroupId: { in: adGroupIds } },
      select: { expression: true },
      orderBy: [{ targetId: 'asc' }],
      take: 5000,
    }),
    prisma.adsNegativeTarget.findMany({
      where: {
        tenantId: ctx.tenantId,
        adsProfileId: input.adsProfileId,
        OR: [{ level: 'CAMPAIGN', campaignId: { in: campaignIds } }, { adGroupId: { in: adGroupIds } }],
      },
      select: { expression: true },
      orderBy: [{ negativeId: 'asc' }],
      take: 5000,
    }),
  ])
  const targeted = new Set([...keywords.map(row => termKey(row.text)), ...targets.map(row => termKey(row.expression))])
  const negated = new Set(negatives.map(row => termKey(row.expression)))
  const rows = found.slice(0, input.limit).flatMap((group): AdsSearchTermRow[] =>
    group.searchTerm
      ? [
          {
            searchTerm: group.searchTerm,
            status: termStatus(group.searchTerm, targeted, negated),
            metrics: { impressions: group._sum.impressions ?? 0, clicks: group._sum.clicks ?? 0, spend: num(group._sum.cost), sales: num(group._sum.sales), orders: group._sum.purchases ?? 0 },
          },
        ]
      : [],
  )
  return { rows, truncated: found.length > input.limit }
}

/** 这些档案的投放表或关键词表、词级报表是否出现过任何行：区分“尚未同步”与“这些广告组里没有”。 */
export async function entityEver(prisma: PrismaService, ctx: AdsLoadContext, adsProfileIds: readonly string[]): Promise<{ targets: boolean; terms: boolean }> {
  const where = { tenantId: ctx.tenantId, adsProfileId: { in: [...adsProfileIds] } }
  const [target, keyword, term] = await Promise.all([
    prisma.adsTarget.findFirst({ where, select: { id: true } }),
    prisma.adsKeyword.findFirst({ where, select: { id: true } }),
    prisma.adsTermMetric.findFirst({ where, select: { id: true } }),
  ])
  return { targets: target !== null || keyword !== null, terms: term !== null }
}
