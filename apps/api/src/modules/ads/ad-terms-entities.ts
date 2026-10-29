import { AD_TERM_DETAIL_LIMIT, type AdTermNegativeRow } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere } from '../auth'
import { num } from './ads-campaigns-common'
import type { AdsLoadContext } from './ads-overview-load'
import { profileInfo } from './ad-terms-data'

// 词级中心里要查实体表的几处（P3-10）：否定词库分页、当前页行的名称与竞价状态、词级分析页的投放与否定记录。
// 都只查“当前页或一个词”涉及的行，不为全部分组去查。

export interface EntityRefs {
  adsProfileId: string
  campaignId?: string | null
  adGroupId?: string | null
}

/** 活动与广告组的名称（键是 `档案|外部编号`）；没同步到的不在结果里。 */
export async function entityNames(prisma: PrismaService, ctx: AdsLoadContext, refs: readonly EntityRefs[]): Promise<{ campaigns: Map<string, string>; groups: Map<string, string> }> {
  const profiles = [...new Set(refs.map(ref => ref.adsProfileId))]
  const campaignIds = [...new Set(refs.flatMap(ref => (ref.campaignId ? [ref.campaignId] : [])))]
  const groupIds = [...new Set(refs.flatMap(ref => (ref.adGroupId ? [ref.adGroupId] : [])))]
  const base = { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), adsProfileId: { in: profiles } }
  const [campaigns, groups] = await Promise.all([
    campaignIds.length === 0
      ? Promise.resolve([])
      : prisma.adsCampaign.findMany({
          where: { ...base, externalCampaignId: { in: campaignIds } },
          select: { adsProfileId: true, externalCampaignId: true, name: true },
          orderBy: [{ id: 'asc' }],
          take: 2000,
        }),
    groupIds.length === 0
      ? Promise.resolve([])
      : prisma.adsAdGroup.findMany({ where: { ...base, adGroupId: { in: groupIds } }, select: { adsProfileId: true, adGroupId: true, name: true }, orderBy: [{ id: 'asc' }], take: 2000 }),
  ])
  const campaignNames = new Map<string, string>()
  for (const row of campaigns) if (!campaignNames.has(`${row.adsProfileId}|${row.externalCampaignId}`)) campaignNames.set(`${row.adsProfileId}|${row.externalCampaignId}`, row.name)
  return { campaigns: campaignNames, groups: new Map(groups.map(row => [`${row.adsProfileId}|${row.adGroupId}`, row.name])) }
}

export interface TargetFact {
  id: string
  bid: number | null
  state: string
}
/** 这些投放编号已同步的竞价与状态（关键词表优先，其次投放表；键是 `档案|编号`）。 */
export async function targetFacts(prisma: PrismaService, ctx: AdsLoadContext, refs: ReadonlyArray<{ adsProfileId: string; targetId: string | null }>): Promise<Map<string, TargetFact>> {
  const wanted = refs.filter((ref): ref is { adsProfileId: string; targetId: string } => Boolean(ref.targetId))
  const facts = new Map<string, TargetFact>()
  if (wanted.length === 0) return facts
  const base = { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope), adsProfileId: { in: [...new Set(wanted.map(ref => ref.adsProfileId))] } }
  const ids = [...new Set(wanted.map(ref => ref.targetId))]
  const [keywords, targets] = await Promise.all([
    prisma.adsKeyword.findMany({ where: { ...base, keywordId: { in: ids } }, select: { id: true, adsProfileId: true, keywordId: true, bid: true, state: true }, orderBy: [{ id: 'asc' }], take: 2000 }),
    prisma.adsTarget.findMany({ where: { ...base, targetId: { in: ids } }, select: { id: true, adsProfileId: true, targetId: true, bid: true, state: true }, orderBy: [{ id: 'asc' }], take: 2000 }),
  ])
  for (const row of targets) facts.set(`${row.adsProfileId}|${row.targetId}`, { id: row.id, bid: num(row.bid), state: row.state })
  for (const row of keywords) facts.set(`${row.adsProfileId}|${row.keywordId}`, { id: row.id, bid: num(row.bid), state: row.state })
  return facts
}

/** 否定词库一页：数据库里排序与跳过；默认按词 A→Z，选“词”排序时按给定方向。 */
export async function negativesPage(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  filter: { level?: string; matchType?: string; needle?: string },
  page: { offset: number; pageSize: number; dir: 'asc' | 'desc' },
): Promise<{ items: AdTermNegativeRow[]; total: number }> {
  const where = {
    tenantId: ctx.tenantId,
    ...adsRelationWhere(ctx.scope),
    ...(filter.level ? { level: filter.level } : {}),
    ...(filter.matchType ? { matchType: { equals: filter.matchType, mode: 'insensitive' as const } } : {}),
    ...(filter.needle ? { expression: { contains: filter.needle, mode: 'insensitive' as const } } : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.adsNegativeTarget.count({ where }),
    prisma.adsNegativeTarget.findMany({
      where,
      select: { id: true, adsProfileId: true, expression: true, matchType: true, level: true, campaignId: true, adGroupId: true, syncedAt: true },
      orderBy: [{ expression: page.dir }, { id: 'asc' }],
      skip: page.offset,
      take: page.pageSize,
    }),
  ])
  const refs = rows.map(row => ({ adsProfileId: row.adsProfileId, campaignId: row.campaignId, adGroupId: row.adGroupId }))
  const [names, profiles] = await Promise.all([
    entityNames(prisma, ctx, refs),
    profileInfo(
      prisma,
      ctx,
      rows.map(row => row.adsProfileId),
    ),
  ])
  const items = rows.map((row): AdTermNegativeRow => {
    const profile = profiles.get(row.adsProfileId)
    return {
      id: row.id,
      expression: row.expression,
      matchType: row.matchType,
      level: row.level,
      externalCampaignId: row.campaignId,
      campaignName: names.campaigns.get(`${row.adsProfileId}|${row.campaignId}`) ?? null,
      adGroupId: row.adGroupId,
      adGroupName: row.adGroupId ? (names.groups.get(`${row.adsProfileId}|${row.adGroupId}`) ?? null) : null,
      storeName: profile?.storeName ?? null,
      accountName: profile?.accountName ?? '',
      syncedAt: row.syncedAt.toISOString(),
    }
  })
  return { items, total }
}

export interface TermEntity {
  id: string
  adsProfileId: string
  kind: 'KEYWORD' | 'TARGET' | 'NEGATIVE'
  expression: string
  matchType: string | null
  bid: number | null
  state: string | null
  campaignId: string | null
  adGroupId: string | null
  targetId: string | null
}

/** 与这个词文字完全相同（不分大小写）的关键词、投放表达式与否定词记录；每类最多 AD_TERM_DETAIL_LIMIT 条，多读一条判断是否截断。 */
export async function termEntities(prisma: PrismaService, ctx: AdsLoadContext, term: string): Promise<{ items: TermEntity[]; truncated: boolean; present: boolean }> {
  const base = { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope) }
  const limit = AD_TERM_DETAIL_LIMIT
  const [keywords, targets, negatives, groups, anyRow] = await Promise.all([
    prisma.adsKeyword.findMany({ where: { ...base, text: { equals: term, mode: 'insensitive' } }, orderBy: [{ id: 'asc' }], take: limit + 1 }),
    prisma.adsTarget.findMany({ where: { ...base, expression: { equals: term, mode: 'insensitive' } }, orderBy: [{ id: 'asc' }], take: limit + 1 }),
    prisma.adsNegativeTarget.findMany({ where: { ...base, expression: { equals: term, mode: 'insensitive' } }, orderBy: [{ id: 'asc' }], take: limit + 1 }),
    prisma.adsAdGroup.findMany({ where: base, select: { adsProfileId: true, adGroupId: true, campaignId: true }, orderBy: [{ id: 'asc' }], take: 20_000 }),
    Promise.all([
      prisma.adsKeyword.findFirst({ where: base, select: { id: true } }),
      prisma.adsTarget.findFirst({ where: base, select: { id: true } }),
      prisma.adsNegativeTarget.findFirst({ where: base, select: { id: true } }),
    ]),
  ])
  const campaignOfGroup = new Map(groups.map(group => [`${group.adsProfileId}|${group.adGroupId}`, group.campaignId]))
  const items: TermEntity[] = [
    ...keywords.slice(0, limit).map((row): TermEntity => ({
      id: row.id,
      adsProfileId: row.adsProfileId,
      kind: 'KEYWORD',
      expression: row.text,
      matchType: row.matchType,
      bid: num(row.bid),
      state: row.state,
      campaignId: row.campaignId,
      adGroupId: row.adGroupId,
      targetId: row.keywordId,
    })),
    ...targets.slice(0, limit).map((row): TermEntity => ({
      id: row.id,
      adsProfileId: row.adsProfileId,
      kind: 'TARGET',
      expression: row.expression,
      matchType: row.matchType,
      bid: num(row.bid),
      state: row.state,
      campaignId: campaignOfGroup.get(`${row.adsProfileId}|${row.adGroupId}`) ?? null,
      adGroupId: row.adGroupId,
      targetId: row.targetId,
    })),
    ...negatives.slice(0, limit).map((row): TermEntity => ({
      id: row.id,
      adsProfileId: row.adsProfileId,
      kind: 'NEGATIVE',
      expression: row.expression,
      matchType: row.matchType,
      bid: null,
      state: null,
      campaignId: row.campaignId,
      adGroupId: row.adGroupId,
      targetId: null,
    })),
  ]
  return { items, truncated: [keywords, targets, negatives].some(rows => rows.length > limit), present: anyRow.some(Boolean) }
}
