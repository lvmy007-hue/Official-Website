import { Injectable } from '@nestjs/common'
import {
  ADS_BUCKET_RULE,
  ADS_READ,
  AdTermListQuerySchema,
  AdTermRootsQuerySchema,
  adsRangeIssue,
  countBuckets,
  hasRangeFilter,
  termFilterIssue,
  type AdsLevelCountsResponse,
  type AdTermListQuery,
  type AdTermListTab,
  type AdTermNegativesResponse,
  type AdTermQuadrantResponse,
  type AdTermRootsResponse,
  type AdTermSearchResponse,
  type AdTermTargetsResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ContextService } from '../auth'
import { rangeOf } from './ads-campaigns-common'
import { decodeOffset } from './ads-page'
import { rootsTab } from './ad-terms-roots'
import { negativesTab, quadrantTab, searchTermCounts, searchTermsTab, targetCounts, targetsTab } from './ad-terms-tabs'

/** 区间与分类筛选只适用于投放对象与搜索词页签（P6-23）；不适用的直接拒绝，不静默忽略。 */
function levelFilterIssue(tab: AdTermListTab, query: AdTermListQuery): string | null {
  const rangeIssue = adsRangeIssue(query)
  if (rangeIssue) return rangeIssue
  if ((query.bucket || hasRangeFilter(query)) && tab !== 'targets' && tab !== 'search-terms') return '指标区间与分类筛选只适用于投放对象与搜索词页签'
  return null
}

export type AdTermListResponse = AdTermSearchResponse | AdTermTargetsResponse | AdTermNegativesResponse | AdTermQuadrantResponse

// 词级中心的列表接口（P3-10，08 章 8.7）：GET /ads/terms?tab=（投放对象、搜索词、否定词库、四象限）、GET /ads/terms/roots（词根分析）、GET /ads/negatives（否定词库，等同 tab=negatives）。
// 全部只读（ads.read 与数据范围）；否定、加词、调价写亚马逊，随 P3-17，本包没有实现。
@Injectable()
export class AdTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, forcedTab?: AdTermListTab): Promise<AdTermListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    if (forcedTab && rawQuery.tab !== undefined && rawQuery.tab !== forcedTab)
      throw appError('VALIDATION_FAILED', '这个接口只返回固定页签，不接受 tab 参数', { fieldErrors: { tab: [`只能是 ${forcedTab}`] } })
    const query = AdTermListQuerySchema.parse(forcedTab ? { ...rawQuery, tab: forcedTab } : rawQuery)
    const tab = query.tab ?? 'search-terms'
    // 不适用于当前页签的筛选直接拒绝，不静默忽略
    const issue = termFilterIssue(tab, query)
    if (issue) throw appError('VALIDATION_FAILED', issue, { fieldErrors: { filter: [issue] } })
    const levelIssue = levelFilterIssue(tab, query)
    if (levelIssue) throw appError('VALIDATION_FAILED', levelIssue, { fieldErrors: { filter: [levelIssue] } })
    const tenantId = context.tenantId
    const { period, defaulted } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const binding = bindingOf(tenantId, query)
    const call = { prisma: this.prisma, ctx: { tenantId, scope }, period, defaulted, query, binding, offset: decodeOffset(query.cursor, binding) }
    switch (tab) {
      case 'targets':
        return targetsTab(call)
      case 'negatives':
        return negativesTab(call)
      case 'quadrant':
        return quadrantTab(call)
      default:
        return searchTermsTab(call)
    }
  }

  /** 投放对象与搜索词的分类计数（GET /ads/targets/counts、/ads/search-terms/counts）：与列表同一套筛选，分类筛选之前。 */
  async counts(req: RequestWithContext, rawQuery: Record<string, string>, level: 'targets' | 'search-terms'): Promise<AdsLevelCountsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdTermListQuerySchema.parse({ ...rawQuery, tab: level })
    const issue = adsRangeIssue(query)
    if (issue) throw appError('VALIDATION_FAILED', issue, { fieldErrors: { range: [issue] } })
    const tenantId = context.tenantId
    const { period, defaulted } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const call = { prisma: this.prisma, ctx: { tenantId, scope }, period, defaulted, query, binding: bindingOf(tenantId, query), offset: 0 }
    const counted = level === 'targets' ? await targetCounts(call) : await searchTermCounts(call)
    const { buckets, withoutMetrics } = countBuckets(counted.totals)
    const state = counted.totals.length > 0 ? 'OK' : counted.hasGroups ? 'NO_DATA' : 'NOT_CONNECTED'
    const note = state === 'OK' ? (counted.truncated ? '词级报表的分组很多，只数了花费最高的一部分' : null) : state === 'NO_DATA' ? '没有符合筛选条件的记录' : '词级报表还没有同步，暂无法分类计数'
    return { level, state, note, range: { from: period.from, to: period.to, defaulted }, total: counted.totals.length, buckets, withoutMetrics, rule: ADS_BUCKET_RULE, truncated: counted.truncated }
  }

  async roots(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdTermRootsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdTermRootsQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const { period, defaulted } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const binding = bindingOf(tenantId, query)
    return rootsTab({ prisma: this.prisma, ctx: { tenantId, scope }, period, defaulted, query, binding, offset: decodeOffset(query.cursor, binding) })
  }
}
