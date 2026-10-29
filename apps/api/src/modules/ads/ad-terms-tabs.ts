import {
  AD_TERM_MATCH_BASIS,
  AD_TERM_AGGREGATE_BASIS,
  AD_TERM_NEGATIVES_BASIS,
  AD_TERM_QUADRANT_BASIS,
  AD_TERM_TARGETS_BASIS,
  AD_TERMS_QUADRANT_LIMIT,
  ADS_WRITE_PENDING,
  buildTermQuadrant,
  hasRangeFilter,
  inAdsRanges,
  inBucket,
  summarizeTerms,
  type AdTermListQuery,
  type AdTermListShell,
  type AdTermNegativesResponse,
  type AdTermQuadrantResponse,
  type AdTermSearchResponse,
  type AdTermSort,
  type AdTermTargetsResponse,
  type AdsTotals,
  type DashPeriod,
} from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { anyRowInScope } from './ads-campaigns-load'
import type { AdsLoadContext } from './ads-overview-load'
import { pageInfoAt, pageOf } from './ads-page'
import { loadTargeting, profileInfo, targetGroups, termGroups, undisclosedSpend } from './ad-terms-data'
import { entityNames, negativesPage, targetFacts } from './ad-terms-entities'
import { aggregateTerms, searchAnomalies, searchRowOf, sortTermRows, targetPartsOf, targetRowOf } from './ad-terms-rows'

// 词级中心的四个列表页签（P3-10）：投放对象、搜索词、否定词库、四象限。数据库聚合 → 内存里合并、判断状态与异常分组、排序 → 偏移游标分页（游标签名并绑定全部查询条件）。
// 空值是 null，不是 0；没有记录写“尚无记录”，同步器未交付写“尚未接入”。

export interface TermCall {
  prisma: PrismaService
  ctx: AdsLoadContext
  period: DashPeriod
  defaulted: boolean
  query: AdTermListQuery
  binding: string
  offset: number
}

const NOTE_NEVER_TERMS = '搜索词报表还没有同步（需要广告报表的“搜索词”报告），暂无法列出搜索词'
const NOTE_EMPTY_TERMS = '所选范围内没有搜索词报表行'
const NOTE_NEVER_TARGETS = '投放层的词级报表还没有同步（需要广告报表的“关键词/投放”报告），暂无法列出投放对象'
const NOTE_EMPTY_TARGETS = '所选范围内没有投放层的词级报表行'
const NOTE_NEVER_NEGATIVES = '否定投放记录还没有同步（需要广告活动管理接口），暂无法列出否定词库'
const NOTE_EMPTY_NEGATIVES = '可见范围内没有否定投放记录'
const NOTE_FILTERED = '没有符合筛选条件的记录'
const NOTE_NO_TARGETING = '没有同步到关键词、投放对象与否定词记录，所以所有搜索词都显示“未投放”，不代表真的没有投放'
const NOTE_TARGETING_TRUNCATED = '关键词、投放或否定词记录很多，只读了一部分，部分词的状态可能不准'
const NOTE_TRUNCATED = '词级报表的分组很多，只读了花费最高的一部分；花费较低的词可能缺失'

const joinNotes = (notes: Array<string | null>): string | null => {
  const found = notes.filter((note): note is string => note !== null)
  return found.length ? found.join('；') : null
}

const shellOf = (call: TermCall, basis: string): Omit<AdTermListShell, 'state' | 'note' | 'pageInfo' | 'truncated'> => ({
  period: call.period,
  range: { from: call.period.from, to: call.period.to, defaulted: call.defaulted },
  currency: 'USD',
  basis,
  write: ADS_WRITE_PENDING,
})

const sortOf = (call: TermCall) => ({ field: call.query.sort.field as AdTermSort, dir: call.query.sort.dir })

/** 没有任何分组时区分“尚无记录”与“尚未接入”；有筛选条件时统一说没有符合条件的。 */
async function emptyState(
  call: TermCall,
  table: 'adsTermMetric' | 'adsNegativeTarget',
  notes: { never: string; empty: string },
  filtered: boolean,
): Promise<{ state: 'NO_DATA' | 'NOT_CONNECTED'; note: string }> {
  const ever = await anyRowInScope(call.prisma, call.ctx, table)
  if (!ever) return { state: 'NOT_CONNECTED', note: notes.never }
  return { state: 'NO_DATA', note: filtered ? NOTE_FILTERED : notes.empty }
}

const hasFilter = (query: AdTermListQuery) => Boolean(query.q || query.anomaly || query.status || query.level || query.matchType || query.bucket || hasRangeFilter(query))

/** 区间筛选与分类筛选（P6-23）：列表与分类计数共用；分类计数不带分类筛选。 */
const inRanges = (call: TermCall, totals: AdsTotals) => inAdsRanges(totals, call.query)
const inBuckets = (call: TermCall, totals: AdsTotals) => inBucket(totals, call.query.bucket)

async function loadSearchRows(call: TermCall) {
  const { prisma, ctx, period, query } = call
  const [{ groups, truncated }, loaded, undisclosed] = await Promise.all([
    termGroups(prisma, ctx, period.from, period.to, query.q),
    loadTargeting(prisma, ctx),
    undisclosedSpend(prisma, ctx, period.from, period.to),
  ])
  const profiles = await profileInfo(
    prisma,
    ctx,
    groups.map(group => group.adsProfileId),
  )
  const rows = aggregateTerms(groups, loaded.targeting, id => profiles.get(id)?.storeId ?? null).map(searchRowOf)
  return { groups, truncated, loaded, undisclosed, rows }
}

/** 搜索词分类计数：与列表同一套关键字、状态、区间筛选（不含分类与异常分组）。 */
export async function searchTermCounts(call: TermCall): Promise<TermCounted> {
  const { groups, truncated, rows } = await loadSearchRows(call)
  const kept = rows.filter(row => (!call.query.status || row.status === call.query.status) && inRanges(call, row.totals))
  return { totals: kept.map(row => row.totals), truncated, hasGroups: groups.length > 0 }
}

/** 投放对象分类计数：与列表同一套关键字、匹配方式、区间筛选（不含分类与异常分组）。 */
export async function targetCounts(call: TermCall): Promise<TermCounted> {
  const { prisma, ctx, period, query } = call
  const { groups, truncated } = await targetGroups(prisma, ctx, period.from, period.to, { needle: query.q, matchType: query.matchType })
  const kept = groups.map(targetPartsOf).filter(part => inRanges(call, part.totals))
  return { totals: kept.map(part => part.totals), truncated, hasGroups: groups.length > 0 }
}

export interface TermCounted {
  totals: AdsTotals[]
  truncated: boolean
  hasGroups: boolean
}

export async function searchTermsTab(call: TermCall): Promise<AdTermSearchResponse> {
  const { query } = call
  const { groups, truncated, loaded, undisclosed, rows } = await loadSearchRows(call)
  const byStatus = (query.status ? rows.filter(row => row.status === query.status) : rows).filter(row => inRanges(call, row.totals) && inBuckets(call, row.totals))
  const summary = summarizeTerms(byStatus)
  const filtered = query.anomaly ? byStatus.filter(row => row.anomalies.includes(query.anomaly!)) : byStatus
  const { field, dir } = sortOf(call)
  const sorted = sortTermRows(
    filtered,
    row => row.key,
    row => row.searchTerm,
    field,
    dir,
  )
  const { page, pageInfo } = pageOf(sorted, call.offset, query.pageSize, call.binding)
  const base = { ...shellOf(call, `${AD_TERM_AGGREGATE_BASIS}。${AD_TERM_MATCH_BASIS}`), summary, undisclosedSpend: undisclosed }
  const targetingNote = joinNotes([!loaded.present ? NOTE_NO_TARGETING : null, loaded.truncated ? NOTE_TARGETING_TRUNCATED : null])
  if (sorted.length === 0) {
    const empty =
      groups.length > 0 ? { state: 'NO_DATA' as const, note: NOTE_FILTERED } : await emptyState(call, 'adsTermMetric', { never: NOTE_NEVER_TERMS, empty: NOTE_EMPTY_TERMS }, hasFilter(query))
    return { ...base, ...empty, items: [], pageInfo, truncated, targetingNote }
  }
  return { ...base, state: 'OK', note: truncated ? NOTE_TRUNCATED : null, items: page, pageInfo, truncated, targetingNote }
}

export async function targetsTab(call: TermCall): Promise<AdTermTargetsResponse> {
  const { prisma, ctx, period, query } = call
  const { groups, truncated } = await targetGroups(prisma, ctx, period.from, period.to, { needle: query.q, matchType: query.matchType })
  const parts = groups.map(targetPartsOf).filter(part => inRanges(call, part.totals) && inBuckets(call, part.totals))
  const summary = summarizeTerms(parts)
  const filtered = query.anomaly ? parts.filter(part => part.anomalies.includes(query.anomaly!)) : parts
  const { field, dir } = sortOf(call)
  const sorted = sortTermRows(
    filtered,
    part => part.key,
    part => part.group.expression,
    field,
    dir,
  )
  const { page, pageInfo } = pageOf(sorted, call.offset, query.pageSize, call.binding)
  const base = { ...shellOf(call, AD_TERM_TARGETS_BASIS), summary, pageInfo, truncated }
  if (sorted.length === 0) {
    const empty =
      groups.length > 0 ? { state: 'NO_DATA' as const, note: NOTE_FILTERED } : await emptyState(call, 'adsTermMetric', { never: NOTE_NEVER_TARGETS, empty: NOTE_EMPTY_TARGETS }, hasFilter(query))
    return { ...base, ...empty, items: [] }
  }
  // 只给当前页的行查名称、竞价与状态
  const [facts, names, profiles] = await Promise.all([
    targetFacts(
      prisma,
      ctx,
      page.map(part => ({ adsProfileId: part.group.adsProfileId, targetId: part.group.targetId })),
    ),
    entityNames(
      prisma,
      ctx,
      page.map(part => ({ adsProfileId: part.group.adsProfileId, campaignId: part.group.campaignId, adGroupId: part.group.adGroupId })),
    ),
    profileInfo(
      prisma,
      ctx,
      page.map(part => part.group.adsProfileId),
    ),
  ])
  const items = page.map(part => {
    const { group } = part
    const fact = group.targetId ? facts.get(`${group.adsProfileId}|${group.targetId}`) : undefined
    return targetRowOf(part, {
      campaignName: names.campaigns.get(`${group.adsProfileId}|${group.campaignId}`) ?? null,
      adGroupName: group.adGroupId ? (names.groups.get(`${group.adsProfileId}|${group.adGroupId}`) ?? null) : null,
      storeName: profiles.get(group.adsProfileId)?.storeName ?? null,
      entityId: fact?.id ?? null,
      bid: fact?.bid ?? null,
      state: fact?.state ?? null,
    })
  })
  return { ...base, state: 'OK', note: truncated ? NOTE_TRUNCATED : null, items }
}

export async function negativesTab(call: TermCall): Promise<AdTermNegativesResponse> {
  const { prisma, ctx, query } = call
  const { items, total } = await negativesPage(
    prisma,
    ctx,
    { level: query.level, matchType: query.matchType, needle: query.q },
    { offset: call.offset, pageSize: query.pageSize, dir: query.sort.field === 'term' ? query.sort.dir : 'asc' },
  )
  const pageInfo = pageInfoAt(call.offset, items.length, total, query.pageSize, call.binding)
  const base = { ...shellOf(call, AD_TERM_NEGATIVES_BASIS), items, pageInfo, truncated: false, total }
  if (total === 0) return { ...base, ...(await emptyState(call, 'adsNegativeTarget', { never: NOTE_NEVER_NEGATIVES, empty: NOTE_EMPTY_NEGATIVES }, hasFilter(query))) }
  return { ...base, state: 'OK', note: null }
}

export async function quadrantTab(call: TermCall): Promise<AdTermQuadrantResponse> {
  const { prisma, ctx, period, query } = call
  const subject = query.subject ?? 'search-terms'
  const base = { period, range: { from: period.from, to: period.to, defaulted: call.defaulted }, currency: 'USD' as const, subject, basis: AD_TERM_QUADRANT_BASIS }
  const noPoints = { spendLine: null, acosLine: null, points: [], counts: { STAR: 0, WASTE: 0, POTENTIAL: 0, LOW: 0 }, withoutSales: { terms: 0, spend: null }, total: 0 }
  if (subject === 'targets') {
    const { groups, truncated } = await targetGroups(prisma, ctx, period.from, period.to, { needle: query.q })
    const parts = groups.map(targetPartsOf).filter(part => !query.anomaly || part.anomalies.includes(query.anomaly))
    if (groups.length === 0) return { ...base, ...noPoints, truncated, ...(await emptyState(call, 'adsTermMetric', { never: NOTE_NEVER_TARGETS, empty: NOTE_EMPTY_TARGETS }, hasFilter(query))) }
    const result = buildTermQuadrant(
      parts.map(part => ({ key: part.key, name: part.group.expression, totals: part.group.totals })),
      AD_TERMS_QUADRANT_LIMIT,
    )
    return { ...base, ...result, state: 'OK', note: truncated ? NOTE_TRUNCATED : null, truncated }
  }
  const [{ groups, truncated }, loaded] = await Promise.all([termGroups(prisma, ctx, period.from, period.to, query.q), loadTargeting(prisma, ctx)])
  if (groups.length === 0) return { ...base, ...noPoints, truncated, ...(await emptyState(call, 'adsTermMetric', { never: NOTE_NEVER_TERMS, empty: NOTE_EMPTY_TERMS }, hasFilter(query))) }
  const profiles = await profileInfo(
    prisma,
    ctx,
    groups.map(group => group.adsProfileId),
  )
  const aggregates = aggregateTerms(groups, loaded.targeting, id => profiles.get(id)?.storeId ?? null).filter(aggregate => !query.anomaly || searchAnomalies(aggregate).includes(query.anomaly))
  const result = buildTermQuadrant(
    aggregates.map(aggregate => ({ key: aggregate.key, name: aggregate.term, totals: aggregate.totals })),
    AD_TERMS_QUADRANT_LIMIT,
  )
  return { ...base, ...result, state: 'OK', note: joinNotes([truncated ? NOTE_TRUNCATED : null, loaded.truncated ? NOTE_TARGETING_TRUNCATED : null]), truncated }
}
