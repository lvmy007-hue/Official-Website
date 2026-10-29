import { AD_TERMS_GROUP_LIMIT, ADS_CONSOLE_CURRENCY, termKey, type AdsTotals } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere } from '../auth'
import { asDate } from '../overview'
import { num } from './ads-campaigns-common'
import type { AdsLoadContext } from './ads-overview-load'
import { campaignKey, type TargetGroup, type TermGroup, type Targeting } from './ad-terms-rows'

// 词级中心的数据读取（P3-10）：词级报表与投放实体表全部在数据库里按范围聚合，只取聚合结果；
// 租户条件与数据范围显式带上，行级安全同时生效。金额只取美元，不同币种不折算也不相加；花费为空的报表行不读（那是来源没给，不当 0）。
// 分组按花费从高到低最多读 AD_TERMS_GROUP_LIMIT 个，多读一行判断是否截断。

const LIMIT = AD_TERMS_GROUP_LIMIT

type Sums = { impressions: number | null; clicks: number | null; cost: { toString(): string } | null; sales: { toString(): string } | null; purchases: number | null }
const totalsOf = (sums: Sums): AdsTotals => ({ impressions: sums.impressions ?? 0, clicks: sums.clicks ?? 0, spend: num(sums.cost), sales: num(sums.sales), orders: sums.purchases ?? 0 })

export const termWhere = (ctx: AdsLoadContext, from: string, to: string, level: 'SEARCH_TERM' | 'KEYWORD') => ({
  tenantId: ctx.tenantId,
  ...adsRelationWhere(ctx.scope),
  level,
  currency: ADS_CONSOLE_CURRENCY,
  reportDate: { gte: asDate(from), lte: asDate(to) },
})

/** 搜索词层：按“档案 × 活动 × 搜索词”的合计（亚马逊合并成“其他”的行不在内，见 undisclosedSpend）。关键字在库里按“包含、不分大小写”过滤。 */
export async function termGroups(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string, needle?: string): Promise<{ groups: TermGroup[]; truncated: boolean }> {
  const found = await prisma.adsTermMetric.groupBy({
    by: ['adsProfileId', 'externalCampaignId', 'searchTerm'],
    where: { ...termWhere(ctx, from, to, 'SEARCH_TERM'), otherBucket: false, cost: { not: null }, searchTerm: needle ? { contains: needle, mode: 'insensitive' } : { not: null } },
    _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    orderBy: [{ _sum: { cost: 'desc' } }, { searchTerm: 'asc' }, { adsProfileId: 'asc' }, { externalCampaignId: 'asc' }],
    take: LIMIT + 1,
  })
  const groups = found
    .slice(0, LIMIT)
    .flatMap((group): TermGroup[] =>
      group.searchTerm && termKey(group.searchTerm) ? [{ adsProfileId: group.adsProfileId, campaignId: group.externalCampaignId ?? '', term: group.searchTerm, totals: totalsOf(group._sum) }] : [],
    )
  return { groups, truncated: found.length > LIMIT }
}

/** 被亚马逊合并成“其他”（低于披露阈值）的搜索词的花费合计；范围内没有这类行为 null。 */
export async function undisclosedSpend(prisma: PrismaService, ctx: AdsLoadContext, from: string, to: string): Promise<number | null> {
  const found = await prisma.adsTermMetric.aggregate({ where: { ...termWhere(ctx, from, to, 'SEARCH_TERM'), otherBucket: true }, _sum: { cost: true } })
  return num(found._sum.cost)
}

/** 投放层：按“档案 × 活动 × 广告组 × 投放词 × 匹配方式”的合计；关键字与匹配方式在库里过滤。 */
export async function targetGroups(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  from: string,
  to: string,
  filter: { needle?: string; matchType?: string },
): Promise<{ groups: TargetGroup[]; truncated: boolean }> {
  const found = await prisma.adsTermMetric.groupBy({
    by: ['adsProfileId', 'externalCampaignId', 'adGroupId', 'targetId', 'keywordText', 'matchType'],
    where: {
      ...termWhere(ctx, from, to, 'KEYWORD'),
      cost: { not: null },
      keywordText: filter.needle ? { contains: filter.needle, mode: 'insensitive' } : { not: null },
      ...(filter.matchType ? { matchType: { equals: filter.matchType, mode: 'insensitive' } } : {}),
    },
    _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    _max: { campaignName: true, adGroupName: true },
    orderBy: [{ _sum: { cost: 'desc' } }, { keywordText: 'asc' }, { adsProfileId: 'asc' }, { externalCampaignId: 'asc' }, { adGroupId: 'asc' }, { targetId: 'asc' }, { matchType: 'asc' }],
    take: LIMIT + 1,
  })
  const groups = found.slice(0, LIMIT).flatMap((group): TargetGroup[] =>
    group.keywordText
      ? [
          {
            adsProfileId: group.adsProfileId,
            campaignId: group.externalCampaignId ?? '',
            adGroupId: group.adGroupId,
            targetId: group.targetId,
            expression: group.keywordText,
            matchType: group.matchType,
            campaignName: group._max.campaignName,
            adGroupName: group._max.adGroupName,
            totals: totalsOf(group._sum),
          },
        ]
      : [],
  )
  return { groups, truncated: found.length > LIMIT }
}

export interface TargetingLoad {
  targeting: Targeting
  /** 关键词、投放、否定三张表在可见范围内是否有过任何记录；全没有时“未投放”不代表真的没有投放。 */
  present: boolean
  truncated: boolean
}

/** 每个活动里已投放的词（关键词表 + 投放表的表达式）与已否定的词（否定投放表，活动级与广告组级都算该活动已否定）。 */
export async function loadTargeting(prisma: PrismaService, ctx: AdsLoadContext): Promise<TargetingLoad> {
  const base = { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope) }
  const [keywords, targets, groups, negatives] = await Promise.all([
    prisma.adsKeyword.findMany({ where: base, select: { adsProfileId: true, campaignId: true, text: true }, orderBy: [{ id: 'asc' }], take: LIMIT + 1 }),
    prisma.adsTarget.findMany({ where: base, select: { adsProfileId: true, adGroupId: true, expression: true }, orderBy: [{ id: 'asc' }], take: LIMIT + 1 }),
    prisma.adsAdGroup.findMany({ where: base, select: { adsProfileId: true, adGroupId: true, campaignId: true }, orderBy: [{ id: 'asc' }], take: LIMIT + 1 }),
    prisma.adsNegativeTarget.findMany({ where: base, select: { adsProfileId: true, campaignId: true, expression: true }, orderBy: [{ id: 'asc' }], take: LIMIT + 1 }),
  ])
  const targeted = new Map<string, Set<string>>()
  const negated = new Map<string, Set<string>>()
  const add = (into: Map<string, Set<string>>, adsProfileId: string, campaignId: string, text: string) => {
    const key = campaignKey(adsProfileId, campaignId)
    const held = into.get(key) ?? new Set<string>()
    held.add(termKey(text))
    into.set(key, held)
  }
  for (const row of keywords.slice(0, LIMIT)) add(targeted, row.adsProfileId, row.campaignId, row.text)
  const campaignOfGroup = new Map(groups.slice(0, LIMIT).map(group => [`${group.adsProfileId}|${group.adGroupId}`, group.campaignId]))
  for (const row of targets.slice(0, LIMIT)) {
    const campaignId = campaignOfGroup.get(`${row.adsProfileId}|${row.adGroupId}`)
    if (campaignId) add(targeted, row.adsProfileId, campaignId, row.expression)
  }
  for (const row of negatives.slice(0, LIMIT)) add(negated, row.adsProfileId, row.campaignId, row.expression)
  return {
    targeting: { targeted, negated },
    present: keywords.length + targets.length + negatives.length > 0,
    truncated: [keywords, targets, groups, negatives].some(rows => rows.length > LIMIT),
  }
}

export interface ProfileInfo {
  storeId: string | null
  storeName: string | null
  accountName: string
}
/** 广告档案对应的店铺与账户名（没有绑定店铺为空）；只取可见范围内的档案。 */
export async function profileInfo(prisma: PrismaService, ctx: AdsLoadContext, profileIds: readonly string[]): Promise<Map<string, ProfileInfo>> {
  if (profileIds.length === 0) return new Map()
  const found = await prisma.adsProfile.findMany({
    where: { tenantId: ctx.tenantId, ...(ctx.scope.unrestricted ? {} : { sellerAccountId: { in: ctx.scope.sellerAccountIds } }), id: { in: [...new Set(profileIds)] } },
    select: { id: true, profileId: true, displayName: true, sellerAccountId: true, sellerAccount: { select: { displayName: true } } },
    orderBy: { id: 'asc' },
    take: 2000,
  })
  return new Map(found.map(row => [row.id, { storeId: row.sellerAccountId, storeName: row.sellerAccount?.displayName ?? null, accountName: row.displayName ?? row.profileId }]))
}
