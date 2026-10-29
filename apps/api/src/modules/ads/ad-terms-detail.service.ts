import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  AD_TERM_DETAIL_LIMIT,
  AD_TERM_MATCH_BASIS,
  ADS_READ,
  ADS_WRITE_PENDING,
  AdTermDetailQuerySchema,
  BRAND_ANALYTICS_READ,
  ScopeSearchSchema,
  addTotals,
  adsRatios,
  termAdviceOf,
  termKey,
  termStatus,
  type AdsTermStatus,
  type AdsTotals,
  type AdsTrendPointDay,
  type AdTermDetailResponse,
  type AdTermRelationRow,
  type AdTermTargetingRow,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { dateText, eachDay } from '../overview'
import { num, rangeOf } from './ads-campaigns-common'
import { anyRowInScope } from './ads-campaigns-load'
import { termWhere } from './ad-terms-data'
import { entityNames, termEntities, type TermEntity } from './ad-terms-entities'
import { termHistory } from './ad-terms-history'
import { loadBrandShare } from './ad-terms-brand'
import { aggregateTerms, campaignKey, searchAnomalies, type Targeting } from './ad-terms-rows'

const NOTE_NEVER = '搜索词报表还没有同步（需要广告报表的“搜索词”报告），暂无法分析这个词'
const NOTE_EMPTY = '所选范围内这个词没有搜索词报表行；下面的“投放与否定记录”不受时间范围影响'
const NOTE_TARGETING_EMPTY = '可见范围内没有与这个词文字完全相同的关键词、投放表达式或否定词记录'
const NOTE_TARGETING_NEVER = '关键词、投放对象与否定词记录还没有同步（需要广告活动管理接口）'
const ZERO_CAMPAIGNS = { total: 0, targeted: 0, negated: 0 }

const SUMS = { impressions: true, clicks: true, cost: true, sales: true, purchases: true } as const
type Sums = { impressions: number | null; clicks: number | null; cost: { toString(): string } | null; sales: { toString(): string } | null; purchases: number | null }
const totalsOf = (sums: Sums): AdsTotals => ({ impressions: sums.impressions ?? 0, clicks: sums.clicks ?? 0, spend: num(sums.cost), sales: num(sums.sales), orders: sums.purchases ?? 0 })

/** 把关键词、投放与否定记录整理成“每个活动里已投放、已否定的词”（这里的记录已经是与这个词文字相同的）。 */
function targetingOf(term: string, entities: readonly TermEntity[]): Targeting {
  const key = termKey(term)
  const targeted = new Map<string, Set<string>>()
  const negated = new Map<string, Set<string>>()
  for (const entity of entities) {
    if (!entity.campaignId) continue
    const into = entity.kind === 'NEGATIVE' ? negated : targeted
    const campaign = campaignKey(entity.adsProfileId, entity.campaignId)
    into.set(campaign, (into.get(campaign) ?? new Set<string>()).add(key))
  }
  return { targeted, negated }
}

/** 与这个词文字完全相同的投放与否定记录；全站没有这三类记录是“尚未接入”，只是这个词没有是“尚无记录”。 */
function targetingBlockOf(entities: { items: readonly TermEntity[]; truncated: boolean; present: boolean }): AdTermDetailResponse['targeting'] {
  const items = entities.items.map((entity): AdTermTargetingRow => ({
    id: entity.id,
    kind: entity.kind,
    expression: entity.expression,
    matchType: entity.matchType,
    bid: entity.bid,
    state: entity.state,
    externalCampaignId: entity.campaignId,
    adGroupId: entity.adGroupId,
  }))
  if (items.length > 0) return { state: 'OK', note: entities.truncated ? '记录很多，每类只列出前一部分' : null, items }
  return entities.present ? { state: 'NO_DATA', note: NOTE_TARGETING_EMPTY, items: [] } : { state: 'NOT_CONNECTED', note: NOTE_TARGETING_NEVER, items: [] }
}

// 词级分析页（08 章 8.7）：一个搜索词的趋势、在哪些活动与投放词下出现、与它文字相同的投放与否定记录、推荐动作与历史动作。
// 词按“不分大小写、整串相等”在库里匹配（多余空格不合并）；全部聚合在数据库里完成，只取聚合结果。
@Injectable()
export class AdTermDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdTermDetailResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const { term: wanted } = AdTermDetailQuerySchema.parse(rawQuery)
    const ctx = { tenantId: context.tenantId, scope }
    const { period, zone } = await rangeOf(this.prisma, context.tenantId, ScopeSearchSchema.parse(rawQuery))
    const where = { ...termWhere(ctx, period.from, period.to, 'SEARCH_TERM'), searchTerm: { equals: wanted, mode: 'insensitive' as const }, cost: { not: null } }

    const [byCampaign, relations, daily, entities] = await Promise.all([
      this.prisma.adsTermMetric.groupBy({
        by: ['adsProfileId', 'externalCampaignId', 'searchTerm'],
        where,
        _sum: SUMS,
        orderBy: [{ _sum: { cost: 'desc' } }, { searchTerm: 'asc' }, { adsProfileId: 'asc' }, { externalCampaignId: 'asc' }],
        take: 5000,
      }),
      this.prisma.adsTermMetric.groupBy({
        by: ['adsProfileId', 'externalCampaignId', 'adGroupId', 'keywordText', 'matchType', 'matchedTargetExpression'],
        where,
        _sum: SUMS,
        orderBy: [
          { _sum: { cost: 'desc' } },
          { adsProfileId: 'asc' },
          { externalCampaignId: 'asc' },
          { adGroupId: 'asc' },
          { keywordText: 'asc' },
          { matchType: 'asc' },
          { matchedTargetExpression: 'asc' },
        ],
        take: AD_TERM_DETAIL_LIMIT + 1,
      }),
      this.prisma.adsTermMetric.groupBy({ by: ['reportDate'], where, _sum: SUMS, orderBy: [{ reportDate: 'asc' }], take: 1200 }),
      termEntities(this.prisma, ctx, wanted),
    ])

    const targeting = targetingOf(wanted, entities.items)
    const aggregate = aggregateTerms(
      byCampaign.map(group => ({ adsProfileId: group.adsProfileId, campaignId: group.externalCampaignId ?? '', term: group.searchTerm ?? wanted, totals: totalsOf(group._sum) })),
      targeting,
      () => null,
    )[0]
    const { campaigns: campaignNames, groups: groupNames } = await entityNames(
      this.prisma,
      ctx,
      relations.map(group => ({ adsProfileId: group.adsProfileId, campaignId: group.externalCampaignId, adGroupId: group.adGroupId })),
    )
    const history = await termHistory(this.prisma, ctx, zone, entities.items)
    // 品牌分析份额：只有同时具备品牌分析读取权限才查，没有记录或没有权限都是 null（页面不显示该页签）
    const brand = hasPermission(context.permissions, BRAND_ANALYTICS_READ) ? await loadBrandShare(this.prisma, context.tenantId, scope, wanted) : null
    const base = { period, currency: 'USD' as const, write: ADS_WRITE_PENDING, brand, basis: AD_TERM_MATCH_BASIS, history, targeting: targetingBlockOf(entities) }

    if (!aggregate) {
      const ever = await anyRowInScope(this.prisma, ctx, 'adsTermMetric')
      return {
        ...base,
        term: wanted,
        state: ever ? 'NO_DATA' : 'NOT_CONNECTED',
        note: ever ? NOTE_EMPTY : NOTE_NEVER,
        status: null,
        campaigns: ZERO_CAMPAIGNS,
        totals: null,
        ratios: null,
        anomalies: [],
        trend: [],
        relations: { items: [], truncated: false },
        advice: [],
      }
    }

    const anomalies = searchAnomalies(aggregate)
    const days = eachDay(period.from, period.to)
    const byDate = new Map(daily.map(group => [dateText(group.reportDate), totalsOf(group._sum)]))
    const trend = days.map((date): AdsTrendPointDay => {
      const totals = byDate.get(date)
      return { date, impressions: totals?.impressions ?? null, clicks: totals?.clicks ?? null, spend: totals?.spend ?? null, sales: totals?.sales ?? null, orders: totals?.orders ?? null }
    })
    const relationRows = relations.slice(0, AD_TERM_DETAIL_LIMIT).map((group): AdTermRelationRow => {
      const totals = totalsOf(group._sum)
      const campaign = campaignKey(group.adsProfileId, group.externalCampaignId ?? '')
      const status: AdsTermStatus = termStatus(wanted, targeting.targeted.get(campaign) ?? new Set(), targeting.negated.get(campaign) ?? new Set())
      return {
        key: [group.adsProfileId, group.externalCampaignId ?? '', group.adGroupId ?? '', group.keywordText ?? '', group.matchType ?? '', group.matchedTargetExpression ?? ''].join('|'),
        adsProfileId: group.adsProfileId,
        externalCampaignId: group.externalCampaignId ?? '',
        campaignName: campaignNames.get(campaign) ?? null,
        adGroupId: group.adGroupId,
        adGroupName: group.adGroupId ? (groupNames.get(`${group.adsProfileId}|${group.adGroupId}`) ?? null) : null,
        targetExpression: group.keywordText ?? group.matchedTargetExpression,
        matchType: group.matchType,
        status,
        totals,
        ratios: adsRatios(totals),
      }
    })
    const total = addTotals(byCampaign.map(group => totalsOf(group._sum)))
    return {
      ...base,
      term: aggregate.term,
      state: 'OK',
      note: byCampaign.length >= 5000 ? '这个词出现在非常多的活动里，只汇总了花费最高的一部分' : null,
      status: aggregate.status,
      campaigns: aggregate.campaigns,
      totals: total,
      ratios: adsRatios(total),
      anomalies,
      trend,
      relations: { items: relationRows, truncated: relations.length > AD_TERM_DETAIL_LIMIT },
      advice: termAdviceOf(total, aggregate.status, anomalies, days.length),
    }
  }
}
