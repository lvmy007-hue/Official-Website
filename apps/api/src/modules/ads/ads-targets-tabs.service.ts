import { Injectable } from '@nestjs/common'
import {
  ADS_BID_EFFECT_DAYS,
  ADS_BID_HISTORY_LIMIT,
  ADS_CAMPAIGN_TAB_ROW_LIMIT,
  ADS_TARGET_BID_EVENT_KIND,
  ADS_TARGET_ENTITY_TYPE,
  ADS_TARGET_WRITE_NOTE,
  ADS_WRITE_PENDING,
  ScopeSearchSchema,
  bidChangeOf,
  bidEffectWindows,
  type AdsBidChangeRow,
  type AdsEntityHourlyResponse,
  type AdsEntityTrendResponse,
  type AdsTargetBidHistoryResponse,
  type AdsTargetBrandResponse,
  type AdsTargetPlacementResponse,
  type AdsTargetTermList,
  type AdsTargetTermRow,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { addDays, asDate, localDate } from '../overview'
import { NOT_CONNECTED_AMAZON_CHANGES, num, rangeOf } from './ads-campaigns-common'
import { anyRowInScope, entityDaily } from './ads-campaigns-load'
import { changeRows, loadEntityEvents } from './ads-entity-changes'
import { entityHourly, entityTrend, type EntityKey } from './ads-entity-trend'
import { AdsGroupAccessService, suggestedBidFor, TARGET_METRIC_TYPES, type ResolvedTarget } from './ads-groups-common'
import { pageOf } from './ads-page'

const KEY_LABEL = '投放对象'
const keyOf = (resolved: ResolvedTarget): EntityKey => ({ ref: resolved.ref, entityTypes: TARGET_METRIC_TYPES, entityId: resolved.target.targetId, label: KEY_LABEL })

const NOTE_PLACEMENT = '亚马逊的广告位报告只到“活动 × 广告位 × 日”，没有投放对象级的数据，所以这里没有数字；活动级的广告位表现请到所属活动详情的“广告位”页签查看'
const NOTE_BRAND = '品牌分析（该词的搜索量与我方份额）来自亚马逊品牌分析数据集，对应的同步器随“品牌分析”（P4-04）交付，交付后这里自动出现；在那之前不显示示例数字'
const NOTE_TERM_NEVER = '搜索词报表还没有同步（需要广告报表的“搜索词”报告），暂无法列出这个投放对象带来的搜索词'
const NOTE_TERM_EMPTY = '所选范围内这个投放对象没有带来搜索词记录'
const NOTE_BID_EMPTY = `本系统内还没有对这个投放对象调过价（${ADS_TARGET_WRITE_NOTE}；上线后每次调价都会记在这里，并给出调价前后各 ${ADS_BID_EFFECT_DAYS} 天的指标对照）`

// 投放对象详情的页签（08 章 8.5）：趋势、带来的搜索词、广告位、分时表现、竞价历史与效果、品牌分析（仅关键词类）。
@Injectable()
export class AdsTargetTabsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsGroupAccessService,
  ) {}

  async trend(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsEntityTrendResponse> {
    const resolved = await this.access.resolveTarget(req, id, rawQuery)
    const { period, compare } = await rangeOf(this.prisma, resolved.tenantId, ScopeSearchSchema.parse(rawQuery))
    return entityTrend(this.prisma, resolved.ctx, keyOf(resolved), period, compare)
  }

  async hourly(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<AdsEntityHourlyResponse> {
    const resolved = await this.access.resolveTarget(req, id, rawQuery)
    const { zone } = await rangeOf(this.prisma, resolved.tenantId, {}, now)
    return entityHourly(this.prisma, resolved.ctx, keyOf(resolved), zone, now)
  }

  /** 带来的搜索词：词级报表里指向这个投放对象（投放编号或关键词编号）的搜索词，以及它们命中的投放表达式。 */
  async searchTerms(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTargetTermList> {
    const tab = await this.access.openTargetTab(req, id, rawQuery)
    const { target, ctx, period, query } = tab
    const limit = ADS_CAMPAIGN_TAB_ROW_LIMIT
    const groups = await this.prisma.adsTermMetric.groupBy({
      by: ['searchTerm', 'matchedTargetExpression'],
      where: {
        tenantId: ctx.tenantId,
        adsProfileId: target.adsProfileId,
        ...(tab.ref.adProduct ? { adProduct: tab.ref.adProduct } : {}),
        ...(tab.externalCampaignId ? { externalCampaignId: tab.externalCampaignId } : {}),
        level: 'SEARCH_TERM',
        currency: tab.ref.currency,
        reportDate: { gte: asDate(period.from), lte: asDate(period.to) },
        OR: [{ targetId: target.targetId }, { keywordId: target.targetId }],
        searchTerm: query.q ? { contains: query.q, mode: 'insensitive' } : { not: null },
      },
      _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
      orderBy: [{ _sum: { cost: 'desc' } }, { searchTerm: 'asc' }, { matchedTargetExpression: 'asc' }],
      take: limit + 1,
    })
    const rows = groups.slice(0, limit).flatMap((group): AdsTargetTermRow[] =>
      group.searchTerm
        ? [
            {
              searchTerm: group.searchTerm,
              matchedExpression: group.matchedTargetExpression,
              metrics: { impressions: group._sum.impressions ?? 0, clicks: group._sum.clicks ?? 0, spend: num(group._sum.cost), sales: num(group._sum.sales), orders: group._sum.purchases ?? 0 },
            },
          ]
        : [],
    )
    const { page, pageInfo } = pageOf(rows, tab.offset, query.pageSize, tab.binding)
    if (rows.length > 0) return { state: 'OK', note: groups.length > limit ? `搜索词很多，只列花费最高的 ${limit} 个` : null, period, items: page, pageInfo, truncated: groups.length > limit }
    const ever = await anyRowInScope(this.prisma, ctx, 'adsTermMetric')
    return { state: ever ? 'NO_DATA' : 'NOT_CONNECTED', note: ever ? NOTE_TERM_EMPTY : NOTE_TERM_NEVER, period, items: [], pageInfo, truncated: false }
  }

  async placements(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTargetPlacementResponse> {
    const { campaign } = await this.access.resolveTarget(req, id, rawQuery)
    return { state: 'NOT_CONNECTED', note: NOTE_PLACEMENT, campaignId: campaign?.id ?? null }
  }

  /** 竞价历史与效果：本系统内的调价（P3-17 写入）各带调价前后各 7 天的指标对照；亚马逊侧调价没有同步器。 */
  async bidHistory(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTargetBidHistoryResponse> {
    const resolved = await this.access.resolveTarget(req, id, rawQuery)
    const { target, ref, ctx, tenantId } = resolved
    const [suggestedBid, { zone }, { events, truncated }] = await Promise.all([
      suggestedBidFor(this.prisma, tenantId, target.adsProfileId, target.targetId),
      rangeOf(this.prisma, tenantId, {}),
      loadEntityEvents(this.prisma, tenantId, ADS_TARGET_ENTITY_TYPE, target.id, ADS_TARGET_BID_EVENT_KIND, ADS_BID_HISTORY_LIMIT),
    ])
    const base = {
      current: { bid: target.bid, currency: ref.currency, suggestedBid },
      amazonSide: { state: 'NOT_CONNECTED' as const, note: NOT_CONNECTED_AMAZON_CHANGES },
      write: { state: ADS_WRITE_PENDING.state, note: ADS_TARGET_WRITE_NOTE },
    }
    if (events.length === 0) return { ...base, changes: { state: 'NO_DATA', note: NOTE_BID_EMPTY, items: [], truncated: false } }

    const dates = events.map(event => localDate(event.occurredAt, zone)).sort()
    const daily = await entityDaily(this.prisma, ctx, {
      ref,
      entityTypes: TARGET_METRIC_TYPES,
      entityId: target.targetId,
      from: addDays(dates[0]!, -ADS_BID_EFFECT_DAYS),
      to: addDays(dates[dates.length - 1]!, ADS_BID_EFFECT_DAYS),
    })
    const described = await changeRows(this.prisma, tenantId, events, { [ADS_TARGET_BID_EVENT_KIND]: '调价' })
    const items = events.map((event, index): AdsBidChangeRow => {
      const change = bidChangeOf(event.detailJson)
      const windows = bidEffectWindows(daily, localDate(event.occurredAt, zone), ADS_BID_EFFECT_DAYS)
      const row = described[index]!
      return { id: event.id, at: row.occurredAt, actor: row.actor, source: row.source, beforeBid: change?.before.bid ?? null, afterBid: change?.after.bid ?? null, title: row.title, ...windows }
    })
    return { ...base, changes: { state: 'OK', note: null, items, truncated } }
  }

  /** 品牌分析：只有关键词类有；对应数据集的同步器随 P4-04，目前一律“尚未接入”。 */
  async brandAnalytics(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTargetBrandResponse> {
    const { target } = await this.access.resolveTarget(req, id, rawQuery)
    if (target.kind !== 'KEYWORD') throw appError('RESOURCE_NOT_FOUND', '只有关键词类投放对象有品牌分析页签')
    return { state: 'NOT_CONNECTED', note: NOTE_BRAND, keyword: target.expression }
  }
}
