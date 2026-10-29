import { ADS_CAMPAIGN_TAB_ROW_LIMIT, ADS_WRITE_PENDING, termKey, termStatus, type AdsCampaignTabQuery, type AdsSearchTermRow, type AdsTermList, type DashPeriod } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { asDate } from '../overview'
import { num } from './ads-campaigns-common'
import { anyRowInScope, campaignAdGroups } from './ads-campaigns-load'
import type { AdsLoadContext } from './ads-overview-load'
import { pageOf } from './ads-page'

// 搜索词列表（P3-07 活动页签、P3-08 广告组页签共用）：词级报表按搜索词汇总，并标出是否已被投放或已被否定。
// 范围是“活动”或“活动 × 广告组”：广告组范围只看这个广告组的投放词，否定词看活动级与这个广告组的广告组级。

export const MATCH_BASIS = '“已投放”“已否定”按搜索词与投放词、否定词完全相同判断（不分大小写、合并多余空格）；广泛、词组、否定词组匹配的命中不在其内，这类搜索词仍显示“未投放”'
const NOTE_NEVER = '搜索词报表还没有同步（需要广告报表的“搜索词”报告），暂无法列出搜索词'
const NOTE_EMPTY = '所选范围内没有搜索词报表行'
const NOTE_NO_TARGETS = '没有同步到投放词与否定词记录，所以所有搜索词都显示“未投放”，不代表真的没有投放'

export interface TermScope {
  adsProfileId: string
  /** 上级活动还没有同步时为 null，不按广告产品过滤。 */
  adProduct: string | null
  currency: string
  externalCampaignId: string
  /** 只看这个广告组（外部编号）；不给就是整个活动。 */
  adGroupId?: string
}
export interface TermTab {
  period: DashPeriod
  query: AdsCampaignTabQuery
  binding: string
  offset: number
}

export async function loadSearchTerms(prisma: PrismaService, ctx: AdsLoadContext, scope: TermScope, tab: TermTab): Promise<AdsTermList> {
  const { period, query } = tab
  const limit = ADS_CAMPAIGN_TAB_ROW_LIMIT
  const groups = await prisma.adsTermMetric.groupBy({
    by: ['searchTerm'],
    where: {
      tenantId: ctx.tenantId,
      adsProfileId: scope.adsProfileId,
      ...(scope.adProduct ? { adProduct: scope.adProduct } : {}),
      externalCampaignId: scope.externalCampaignId,
      ...(scope.adGroupId ? { adGroupId: scope.adGroupId } : {}),
      level: 'SEARCH_TERM',
      currency: scope.currency,
      reportDate: { gte: asDate(period.from), lte: asDate(period.to) },
      searchTerm: query.q ? { contains: query.q, mode: 'insensitive' } : { not: null },
    },
    _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    orderBy: [{ _sum: { cost: 'desc' } }, { searchTerm: 'asc' }],
    take: limit + 1,
  })
  const base = { period, matchBasis: MATCH_BASIS, write: ADS_WRITE_PENDING }
  if (groups.length === 0) {
    const ever = await anyRowInScope(prisma, ctx, 'adsTermMetric')
    return {
      ...base,
      state: ever ? 'NO_DATA' : 'NOT_CONNECTED',
      note: ever ? NOTE_EMPTY : NOTE_NEVER,
      items: [],
      pageInfo: { pageSize: query.pageSize, nextCursor: null, hasMore: false, approxTotal: 0 },
      truncated: false,
    }
  }

  const adGroupIds = scope.adGroupId
    ? [scope.adGroupId]
    : (await campaignAdGroups(prisma, ctx, { adsProfileId: scope.adsProfileId, adProduct: scope.adProduct ?? '', externalCampaignId: scope.externalCampaignId, currency: scope.currency }, limit)).map(
        group => group.adGroupId,
      )
  const [keywords, targets, negatives] = await Promise.all([
    prisma.adsKeyword.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: scope.adsProfileId, campaignId: scope.externalCampaignId, ...(scope.adGroupId ? { adGroupId: scope.adGroupId } : {}) },
      select: { text: true },
      orderBy: [{ keywordId: 'asc' }],
      take: 5000,
    }),
    adGroupIds.length === 0
      ? Promise.resolve([])
      : prisma.adsTarget.findMany({
          where: { tenantId: ctx.tenantId, adsProfileId: scope.adsProfileId, adGroupId: { in: adGroupIds } },
          select: { expression: true },
          orderBy: [{ targetId: 'asc' }],
          take: 5000,
        }),
    prisma.adsNegativeTarget.findMany({
      where: {
        tenantId: ctx.tenantId,
        adsProfileId: scope.adsProfileId,
        campaignId: scope.externalCampaignId,
        ...(scope.adGroupId ? { OR: [{ level: 'CAMPAIGN' }, { adGroupId: scope.adGroupId }] } : {}),
      },
      select: { expression: true },
      orderBy: [{ negativeId: 'asc' }],
      take: 5000,
    }),
  ])
  const targeted = new Set([...keywords.map(row => termKey(row.text)), ...targets.map(row => termKey(row.expression))])
  const negated = new Set(negatives.map(row => termKey(row.expression)))

  const rows = groups.slice(0, limit).flatMap((group): AdsSearchTermRow[] => {
    if (!group.searchTerm) return []
    return [
      {
        searchTerm: group.searchTerm,
        status: termStatus(group.searchTerm, targeted, negated),
        metrics: { impressions: group._sum.impressions ?? 0, clicks: group._sum.clicks ?? 0, spend: num(group._sum.cost), sales: num(group._sum.sales), orders: group._sum.purchases ?? 0 },
      },
    ]
  })
  const filtered = query.status ? rows.filter(row => row.status === query.status) : rows
  const { page, pageInfo } = pageOf(filtered, tab.offset, query.pageSize, tab.binding)
  const notes = [targeted.size === 0 && negated.size === 0 ? NOTE_NO_TARGETS : null, groups.length > limit ? `搜索词很多，只列花费最高的 ${limit} 个` : null].filter(
    (note): note is string => note !== null,
  )
  return { ...base, state: 'OK', note: notes.length ? notes.join('；') : null, items: page, pageInfo, truncated: groups.length > limit }
}
