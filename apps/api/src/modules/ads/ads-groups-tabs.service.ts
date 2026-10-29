import { Injectable } from '@nestjs/common'
import {
  ADS_CAMPAIGN_TAB_ROW_LIMIT,
  ADS_GROUP_ENTITY_TYPE,
  ADS_GROUP_WRITE_NOTE,
  ADS_WRITE_PENDING,
  ScopeSearchSchema,
  stockOf,
  type AdsEntityChangesResponse,
  type AdsEntityHourlyResponse,
  type AdsEntityTrendResponse,
  type AdsGroupProductRow,
  type AdsNegativeList,
  type AdsNegativeRow,
  type AdsTabList,
  type AdsTargetRow,
  type AdsTermList,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { NOT_CONNECTED_AMAZON_CHANGES, rangeOf } from './ads-campaigns-common'
import { emptyState } from './ads-campaigns-entities.service'
import { anyRowInScope, entityMetricMap } from './ads-campaigns-load'
import { productFacts } from './ads-campaigns-products.service'
import { changeRows, ENTITY_CHANGE_LIMIT, loadEntityEvents } from './ads-entity-changes'
import { entityHourly, entityTrend, type EntityKey } from './ads-entity-trend'
import { AdsGroupAccessService, type ResolvedGroup } from './ads-groups-common'
import { pageOf } from './ads-page'
import { loadTargetRows, targetSourcesExist } from './ads-target-rows'
import { loadSearchTerms } from './ads-terms-load'

const LIMIT = ADS_CAMPAIGN_TAB_ROW_LIMIT
const GROUP_KIND_LABEL = { 'ads.ad-group.bid': '默认竞价', 'ads.ad-group.state': '状态' } as Record<string, string>

const keyOf = (resolved: ResolvedGroup): EntityKey => ({ ref: resolved.ref, entityTypes: ['AD_GROUP'], entityId: resolved.group.adGroupId, label: '广告组' })

// 广告组详情的 7 个页签（08 章 8.4）：表现趋势、投放对象、搜索词、广告商品、否定投放、分时表现、操作记录。
// 每个页签自己取数；列表型页签沿用活动页签的分页（服务端签名游标，换条件即失效）。写入亚马逊的动作随 P3-17。
@Injectable()
export class AdsGroupTabsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsGroupAccessService,
  ) {}

  async trend(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsEntityTrendResponse> {
    const resolved = await this.access.resolveGroup(req, id, rawQuery)
    const { period, compare } = await rangeOf(this.prisma, resolved.tenantId, ScopeSearchSchema.parse(rawQuery))
    return entityTrend(this.prisma, resolved.ctx, keyOf(resolved), period, compare)
  }

  async hourly(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<AdsEntityHourlyResponse> {
    const resolved = await this.access.resolveGroup(req, id, rawQuery)
    const { zone } = await rangeOf(this.prisma, resolved.tenantId, {}, now)
    return entityHourly(this.prisma, resolved.ctx, keyOf(resolved), zone, now)
  }

  async targets(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTabList<AdsTargetRow>> {
    const tab = await this.access.openGroupTab(req, id, rawQuery)
    const { group, ctx } = tab
    const { rows, truncated } = await loadTargetRows(this.prisma, ctx, {
      adsProfileId: group.adsProfileId,
      ref: tab.ref,
      keywordScope: { adGroupId: group.adGroupId },
      targetGroupIds: [group.adGroupId],
      excludeAudience: false,
      groupNames: new Map([[group.adGroupId, group.name]]),
      from: tab.period.from,
      to: tab.period.to,
      needle: tab.query.q,
      limit: LIMIT,
    })
    const { page, pageInfo } = pageOf(rows, tab.offset, tab.query.pageSize, tab.binding)
    const empty =
      rows.length === 0 ? await emptyState(targetSourcesExist(this.prisma, ctx), '投放对象（关键词、商品、类目、受众）还没有同步（需要活动管理接口的投放对象）', '这个广告组下没有投放对象记录') : null
    return { state: empty?.state ?? 'OK', note: empty?.note ?? null, items: page, pageInfo, truncated }
  }

  async searchTerms(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTermList> {
    const tab = await this.access.openGroupTab(req, id, rawQuery)
    const { group, ref } = tab
    return loadSearchTerms(
      this.prisma,
      tab.ctx,
      { adsProfileId: group.adsProfileId, adProduct: ref.adProduct, currency: ref.currency, externalCampaignId: group.campaignId, adGroupId: group.adGroupId },
      tab,
    )
  }

  /** 广告商品：这个广告组里的广告（带 ASIN 与 SKU），指标是广告级（指标表对象类型 AD），再配库存状态；断货的商品标红。 */
  async products(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTabList<AdsGroupProductRow>> {
    const tab = await this.access.openGroupTab(req, id, rawQuery)
    const { group, ctx } = tab
    const ads = await this.prisma.adsAd.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: group.adsProfileId, adGroupId: group.adGroupId },
      select: { adId: true, asin: true, sku: true, state: true },
      orderBy: [{ adId: 'asc' }],
      take: LIMIT + 1,
    })
    const kept = ads.slice(0, LIMIT)
    const [metrics, facts] = await Promise.all([
      entityMetricMap(this.prisma, ctx, { ref: tab.ref, entityTypes: ['AD'], entityIds: kept.map(ad => ad.adId), from: tab.period.from, to: tab.period.to }),
      productFacts(
        this.prisma,
        ctx,
        group.adsProfile.sellerAccountId,
        kept.flatMap(ad => (ad.asin ? [ad.asin] : [])),
      ),
    ])
    const needle = tab.query.q?.toLowerCase()
    const rows = kept
      .map((ad): AdsGroupProductRow => {
        const fact = ad.asin ? facts.get(ad.asin) : undefined
        return {
          adId: ad.adId,
          asin: ad.asin,
          sku: ad.sku,
          state: ad.state,
          title: fact?.title ?? null,
          imageUrl: fact?.imageUrl ?? null,
          metrics: metrics.get(ad.adId) ?? null,
          sellable: fact?.sellable ?? null,
          snapshotDate: fact?.snapshotDate ?? null,
          stock: stockOf(fact?.sellable ?? null),
        }
      })
      .filter(row => !needle || (row.asin ?? '').toLowerCase().includes(needle) || (row.sku ?? '').toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle))
      .sort((a, b) => {
        // 花费高的在前；没有指标的排最后，再按广告编号保证翻页顺序稳定
        const left = a.metrics?.spend ?? null
        const right = b.metrics?.spend ?? null
        if (left === null && right !== null) return 1
        if (left !== null && right === null) return -1
        if (left !== null && right !== null && left !== right) return right - left
        return a.adId < b.adId ? -1 : a.adId > b.adId ? 1 : 0
      })
    const { page, pageInfo } = pageOf(rows, tab.offset, tab.query.pageSize, tab.binding)
    const empty = rows.length === 0 ? await emptyState(anyRowInScope(this.prisma, ctx, 'adsAd'), '广告（商品与 SKU）还没有同步（需要活动管理接口的广告）', '这个广告组下没有广告记录') : null
    return { state: empty?.state ?? 'OK', note: empty?.note ?? null, items: page, pageInfo, truncated: ads.length > LIMIT }
  }

  /** 否定投放：活动级（对整个活动生效，这里一并列出方便对照）与这个广告组的广告组级。 */
  async negatives(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsNegativeList> {
    const tab = await this.access.openGroupTab(req, id, rawQuery)
    const { group, ctx } = tab
    const found = await this.prisma.adsNegativeTarget.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: group.adsProfileId, campaignId: group.campaignId, OR: [{ level: 'CAMPAIGN' }, { adGroupId: group.adGroupId }] },
      select: { negativeId: true, level: true, expression: true, matchType: true },
      orderBy: [{ level: 'asc' }, { expression: 'asc' }, { negativeId: 'asc' }],
      take: LIMIT + 1,
    })
    const needle = tab.query.q?.toLowerCase()
    const rows = found
      .slice(0, LIMIT)
      .filter(row => !needle || row.expression.toLowerCase().includes(needle))
      .map((row): AdsNegativeRow => ({ negativeId: row.negativeId, level: row.level === 'AD_GROUP' ? 'AD_GROUP' : 'CAMPAIGN', expression: row.expression, matchType: row.matchType }))
    const { page, pageInfo } = pageOf(rows, tab.offset, tab.query.pageSize, tab.binding)
    const empty =
      rows.length === 0
        ? await emptyState(anyRowInScope(this.prisma, ctx, 'adsNegativeTarget'), '否定投放还没有同步（需要活动管理接口的否定投放）', '这个广告组与它所在的活动都没有否定投放记录')
        : null
    return { state: empty?.state ?? 'OK', note: empty?.note ?? null, items: page, pageInfo, truncated: found.length > LIMIT, write: { state: ADS_WRITE_PENDING.state, note: ADS_GROUP_WRITE_NOTE } }
  }

  /** 操作记录：本系统内对这个广告组做过的改动（修改默认竞价、暂停启用随 P3-17 提供，目前没有写入方）。亚马逊侧的变更没有同步器。 */
  async history(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsEntityChangesResponse> {
    const { group, tenantId } = await this.access.resolveGroup(req, id, rawQuery)
    const { events, truncated } = await loadEntityEvents(this.prisma, tenantId, ADS_GROUP_ENTITY_TYPE, group.id)
    const items = await changeRows(this.prisma, tenantId, events, GROUP_KIND_LABEL)
    const amazonSide = { state: 'NOT_CONNECTED' as const, note: NOT_CONNECTED_AMAZON_CHANGES }
    return items.length > 0
      ? { state: 'OK', note: null, items, truncated, amazonSide }
      : {
          state: 'NO_DATA',
          note: `本系统内还没有对这个广告组做过改动（${ADS_GROUP_WRITE_NOTE}；之后每次改动都会记在这里，最多显示最近 ${ENTITY_CHANGE_LIMIT} 条）`,
          items: [],
          truncated: false,
          amazonSide,
        }
  }
}
