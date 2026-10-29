import { AD_TERM_ROOT_BASIS, aggregateRoots, compareTermRows, termKey, termMatches, type AdTermRootSort, type AdTermRootsQuery, type AdTermRootsResponse, type DashPeriod } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { anyRowInScope } from './ads-campaigns-load'
import type { AdsLoadContext } from './ads-overview-load'
import { pageOf } from './ads-page'
import { profileInfo, termGroups } from './ad-terms-data'

// 词根分析（P3-10）：把搜索词拆成词根，跨活动与店铺汇总词频与花费。词根拆分与单复数还原是规则实现（见 AD_TERM_ROOT_BASIS），不是词典。

const NOTE_NEVER = '搜索词报表还没有同步（需要广告报表的“搜索词”报告），暂无法做词根分析'
const NOTE_EMPTY = '所选范围内没有搜索词报表行'
const NOTE_FILTERED = '没有符合筛选条件的词根'
const NOTE_TRUNCATED = '词级报表的分组很多，只读了花费最高的一部分；花费较低的搜索词没有计入词根'

export interface RootsCall {
  prisma: PrismaService
  ctx: AdsLoadContext
  period: DashPeriod
  defaulted: boolean
  query: AdTermRootsQuery
  binding: string
  offset: number
}

export async function rootsTab(call: RootsCall): Promise<AdTermRootsResponse> {
  const { prisma, ctx, period, query } = call
  const { groups, truncated } = await termGroups(prisma, ctx, period.from, period.to)
  const base = { period, range: { from: period.from, to: period.to, defaulted: call.defaulted }, currency: 'USD' as const, basis: AD_TERM_ROOT_BASIS, truncated }
  if (groups.length === 0) {
    const ever = await anyRowInScope(prisma, ctx, 'adsTermMetric')
    const pageInfo = { pageSize: query.pageSize, nextCursor: null, hasMore: false, approxTotal: 0 }
    return { ...base, state: ever ? 'NO_DATA' : 'NOT_CONNECTED', note: ever ? NOTE_EMPTY : NOTE_NEVER, items: [], pageInfo, termCount: 0 }
  }
  const profiles = await profileInfo(
    prisma,
    ctx,
    groups.map(group => group.adsProfileId),
  )
  const roots = aggregateRoots(groups.map(group => ({ term: group.term, storeId: profiles.get(group.adsProfileId)?.storeId ?? null, totals: group.totals })))
  const entries = roots
    .filter(row => termMatches(row.root, query.q))
    .map(row => ({ row, key: row.root, label: row.root, totals: row.totals, ratios: row.ratios, terms: row.terms, stores: row.stores }))
  const field = query.sort.field as AdTermRootSort
  entries.sort((a, b) => compareTermRows(a, b, field, query.sort.dir))
  const { page, pageInfo } = pageOf(entries, call.offset, query.pageSize, call.binding)
  const termCount = new Set(groups.map(group => termKey(group.term))).size
  if (entries.length === 0) return { ...base, state: 'NO_DATA', note: NOTE_FILTERED, items: [], pageInfo, termCount }
  return { ...base, state: 'OK', note: truncated ? NOTE_TRUNCATED : null, items: page.map(entry => entry.row), pageInfo, termCount }
}
