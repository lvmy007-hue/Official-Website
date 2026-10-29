import { Injectable } from '@nestjs/common'
import {
  ADS_CAMPAIGN_TAB_ROW_LIMIT,
  ADS_OVER_BUDGET_NOTE,
  type AdsAdGroupRow,
  type AdsAudienceRow,
  type AdsCampaignHistoryResponse,
  type AdsCreativeRow,
  type AdsPlacementResponse,
  type AdsPlacementRow,
  type AdsTabList,
  type AdsTargetRow,
  type DashState,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere } from '../auth'
import { asDate } from '../overview'
import { AdsCampaignAccessService, num, NOT_CONNECTED_AMAZON_CHANGES, NOT_CONNECTED_PLACEMENT_ADJUSTMENT, type OpenedTab } from './ads-campaigns-common'
import { anyRowInScope, campaignAdGroups, entityMetricMap, entitySums, type CampaignRef } from './ads-campaigns-load'
import { pageOf } from './ads-page'
import { loadTargetRows, targetSourcesExist } from './ads-target-rows'

const refOf = (tab: OpenedTab): CampaignRef => ({
  adsProfileId: tab.campaign.adsProfileId,
  adProduct: tab.campaign.adProduct,
  externalCampaignId: tab.campaign.externalCampaignId,
  currency: tab.campaign.currency,
})
const LIMIT = ADS_CAMPAIGN_TAB_ROW_LIMIT

/** 没有行时分“同步器尚未接入”（可见范围内这类实体一条都没有）与“这个活动下没有”。 */
export async function emptyState(exists: Promise<boolean>, never: string, empty: string): Promise<{ state: DashState; note: string }> {
  return (await exists) ? { state: 'NO_DATA', note: empty } : { state: 'NOT_CONNECTED', note: never }
}

/** 广告位的口径名：亚马逊的广告位名称有多种写法，按关键字归并；认不出的原样显示。 */
export function placementLabel(placement: string): string {
  const text = placement.toLowerCase()
  if (text.includes('top')) return '搜索结果顶部'
  if (text.includes('detail') || text.includes('product')) return '商品页面'
  if (text.includes('rest') || text.includes('other')) return '其余位置'
  return placement
}

/** 创意原文（assetsJson）里的标题、着陆页与素材个数；结构随广告产品而变，只做保守读取。 */
export function creativeView(assets: unknown): { headline: string | null; landingPage: string | null; assetCount: number } {
  const record = assets && typeof assets === 'object' && !Array.isArray(assets) ? (assets as Record<string, unknown>) : {}
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null)
  const landing = record.landingPage
  const landingText = text(landing) ?? (landing && typeof landing === 'object' ? text((landing as Record<string, unknown>).url) : null) ?? text(record.landingPageUrl) ?? text(record.url)
  return {
    headline: text(record.headline) ?? text(record.title) ?? text(record.brandName) ?? text(record.name),
    landingPage: landingText,
    assetCount: Object.values(record).filter(value => (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '')).length,
  }
}

// 活动详情的实体页签（08 章 8.3）：广告组、投放对象、广告位、创意、受众、预算与竞价历史。
// 实体来自活动管理接口，指标来自指标表（AdsMetric 按实体类型），全部可空：没有指标行的实体指标列是 null，页面写“尚无记录”。
@Injectable()
export class AdsCampaignEntitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsCampaignAccessService,
  ) {}

  async adGroups(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTabList<AdsAdGroupRow>> {
    const tab = await this.access.openTab(req, id, rawQuery)
    const groups = await campaignAdGroups(this.prisma, tab.ctx, refOf(tab), LIMIT + 1)
    const metrics = await entityMetricMap(this.prisma, tab.ctx, {
      ref: refOf(tab),
      entityTypes: ['AD_GROUP'],
      entityIds: groups.map(group => group.adGroupId),
      from: tab.period.from,
      to: tab.period.to,
    })
    const needle = tab.query.q?.toLowerCase()
    const rows = groups
      .slice(0, LIMIT)
      .filter(group => !needle || group.name.toLowerCase().includes(needle))
      .map((group): AdsAdGroupRow => ({
        id: group.id,
        adGroupId: group.adGroupId,
        name: group.name,
        state: group.state,
        defaultBid: num(group.defaultBid),
        metrics: metrics.get(group.adGroupId) ?? null,
      }))
    const { page, pageInfo } = pageOf(rows, tab.offset, tab.query.pageSize, tab.binding)
    const empty = rows.length === 0 ? await emptyState(anyRowInScope(this.prisma, tab.ctx, 'adsAdGroup'), '广告组还没有同步（需要活动管理接口的广告组）', '这个活动下没有广告组记录') : null
    return { state: empty?.state ?? 'OK', note: empty?.note ?? null, items: page, pageInfo, truncated: groups.length > LIMIT }
  }

  /** 投放对象：关键词、商品、类目投放；受众单独一个页签。同一个关键词若同时出现在关键词表与投放表以关键词表为准。 */
  async targets(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTabList<AdsTargetRow>> {
    const tab = await this.access.openTab(req, id, rawQuery)
    const { campaign, ctx } = tab
    const groups = await campaignAdGroups(this.prisma, ctx, refOf(tab), LIMIT)
    const { rows, truncated } = await loadTargetRows(this.prisma, ctx, {
      adsProfileId: campaign.adsProfileId,
      ref: refOf(tab),
      keywordScope: { campaignId: campaign.externalCampaignId },
      targetGroupIds: groups.map(group => group.adGroupId),
      excludeAudience: true,
      groupNames: new Map(groups.map(group => [group.adGroupId, group.name])),
      from: tab.period.from,
      to: tab.period.to,
      needle: tab.query.q,
      limit: LIMIT,
    })
    const { page, pageInfo } = pageOf(rows, tab.offset, tab.query.pageSize, tab.binding)
    const empty =
      rows.length === 0 ? await emptyState(targetSourcesExist(this.prisma, ctx), '投放对象（关键词、商品、类目）还没有同步（需要活动管理接口的投放对象）', '这个活动下没有投放对象记录') : null
    return { state: empty?.state ?? 'OK', note: empty?.note ?? null, items: page, pageInfo, truncated }
  }

  async placements(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsPlacementResponse> {
    const tab = await this.access.openTab(req, id, rawQuery)
    const { campaign, ctx, period } = tab
    const groups = await this.prisma.adsPlacementMetric.groupBy({
      by: ['placement'],
      where: {
        tenantId: ctx.tenantId,
        ...adsRelationWhere(ctx.scope),
        adsProfileId: campaign.adsProfileId,
        campaignId: campaign.externalCampaignId,
        currency: campaign.currency,
        reportDate: { gte: asDate(period.from), lte: asDate(period.to) },
      },
      _sum: { impressions: true, clicks: true, spend: true, sales: true, orders: true },
      orderBy: [{ _sum: { spend: 'desc' } }, { placement: 'asc' }],
      take: 50,
    })
    const adjustments = { state: 'NOT_CONNECTED' as const, note: NOT_CONNECTED_PLACEMENT_ADJUSTMENT }
    const items = groups.map((group): AdsPlacementRow => ({ placement: group.placement, label: placementLabel(group.placement), metrics: entitySums(group._sum) }))
    if (items.length > 0) return { state: 'OK', note: null, period, items, adjustments }
    const empty = await emptyState(anyRowInScope(this.prisma, ctx, 'adsPlacementMetric'), '广告位报表还没有同步（需要广告报表的“广告位”报告）', '所选范围内这个活动没有广告位报表行')
    return { ...empty, period, items: [], adjustments }
  }

  private requireProduct(tab: OpenedTab, products: readonly string[]) {
    if (!products.includes(tab.campaign.adProduct)) throw appError('RESOURCE_NOT_FOUND', '这个广告产品的活动没有此页签')
  }

  /** 创意与着陆页：只有品牌推广与展示型推广有。 */
  async creatives(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTabList<AdsCreativeRow>> {
    const tab = await this.access.openTab(req, id, rawQuery)
    this.requireProduct(tab, ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'])
    const { campaign, ctx } = tab
    const groups = await campaignAdGroups(this.prisma, ctx, refOf(tab), LIMIT)
    const ads =
      groups.length === 0
        ? []
        : await this.prisma.adsAd.findMany({
            where: { tenantId: ctx.tenantId, adsProfileId: campaign.adsProfileId, adGroupId: { in: groups.map(group => group.adGroupId) } },
            select: { adId: true },
            orderBy: [{ adId: 'asc' }],
            take: LIMIT,
          })
    const creatives =
      ads.length === 0
        ? []
        : await this.prisma.adsCreative.findMany({
            where: { tenantId: ctx.tenantId, adsProfileId: campaign.adsProfileId, adId: { in: ads.map(ad => ad.adId) } },
            select: { creativeId: true, adId: true, kind: true, assetsJson: true },
            orderBy: [{ creativeId: 'asc' }],
            take: LIMIT + 1,
          })
    const needle = tab.query.q?.toLowerCase()
    const rows = creatives
      .slice(0, LIMIT)
      .map((creative): AdsCreativeRow => ({ creativeId: creative.creativeId, adId: creative.adId, kind: creative.kind, ...creativeView(creative.assetsJson) }))
      .filter(row => !needle || (row.headline ?? '').toLowerCase().includes(needle) || (row.landingPage ?? '').toLowerCase().includes(needle))
    const { page, pageInfo } = pageOf(rows, tab.offset, tab.query.pageSize, tab.binding)
    const empty = rows.length === 0 ? await emptyState(anyRowInScope(this.prisma, ctx, 'adsCreative'), '创意还没有同步（需要活动管理接口的广告与创意）', '这个活动下没有创意记录') : null
    return { state: empty?.state ?? 'OK', note: empty?.note ?? null, items: page, pageInfo, truncated: creatives.length > LIMIT }
  }

  /** 受众：只有展示型推广有。 */
  async audiences(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTabList<AdsAudienceRow>> {
    const tab = await this.access.openTab(req, id, rawQuery)
    this.requireProduct(tab, ['SPONSORED_DISPLAY'])
    const { campaign, ctx } = tab
    const groups = await campaignAdGroups(this.prisma, ctx, refOf(tab), LIMIT)
    const targets =
      groups.length === 0
        ? []
        : await this.prisma.adsTarget.findMany({
            where: { tenantId: ctx.tenantId, adsProfileId: campaign.adsProfileId, adGroupId: { in: groups.map(group => group.adGroupId) }, kind: 'AUDIENCE' },
            select: { targetId: true, expression: true, state: true, bid: true, adGroupId: true },
            orderBy: [{ targetId: 'asc' }],
            take: LIMIT + 1,
          })
    const needle = tab.query.q?.toLowerCase()
    const rows = targets
      .slice(0, LIMIT)
      .filter(target => !needle || target.expression.toLowerCase().includes(needle))
      .map((target): AdsAudienceRow => ({ targetId: target.targetId, expression: target.expression, state: target.state, bid: num(target.bid), adGroupId: target.adGroupId }))
    const { page, pageInfo } = pageOf(rows, tab.offset, tab.query.pageSize, tab.binding)
    const empty = rows.length === 0 ? await emptyState(anyRowInScope(this.prisma, ctx, 'adsTarget'), '受众投放还没有同步（需要活动管理接口的投放对象）', '这个活动下没有受众投放记录') : null
    return { state: empty?.state ?? 'OK', note: empty?.note ?? null, items: page, pageInfo, truncated: targets.length > LIMIT }
  }

  /** 预算与竞价历史：当前值来自活动记录；历史需要亚马逊的变更历史接口，没有同步器。 */
  async history(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsCampaignHistoryResponse> {
    const { campaign } = await this.access.resolve(req, id, rawQuery)
    const notConnected = { state: 'NOT_CONNECTED' as const, note: NOT_CONNECTED_AMAZON_CHANGES, items: [] }
    return {
      current: { budget: num(campaign.budget), budgetType: campaign.budgetType, currency: campaign.currency, bidStrategy: campaign.bidStrategy, servingStatus: campaign.servingStatus },
      budgetChanges: notConnected,
      bidChanges: notConnected,
      overBudget: { state: 'NOT_CONNECTED', note: ADS_OVER_BUDGET_NOTE, items: [] },
    }
  }
}
