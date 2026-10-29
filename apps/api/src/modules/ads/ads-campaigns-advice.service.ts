import { Injectable } from '@nestjs/common'
import { ADS_ADVICE_LABEL, ADS_CAMPAIGN_ADVICE_RULES, ADS_OVER_BUDGET_NOTE, isWastedTarget, payloadNumber, payloadSummary, type AdsAdviceHit, type AdsAdviceRule } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { addDays, asDate } from '../overview'
import { num, type CampaignRecord } from './ads-campaigns-common'
import { anyRowInScope } from './ads-campaigns-load'
import { loadAdvertised } from './ads-campaigns-products.service'
import type { AdsLoadContext } from './ads-overview-load'

const RULES = ADS_CAMPAIGN_ADVICE_RULES
const money = (currency: string, value: number) => `${currency} ${value.toFixed(2)}`

// 活动详情“建议动作”区（08 章 8.3）：四条规则，每条要么命中（带证据、预估影响、风险与对应动作），要么说明没命中，要么说明缺数据来源没法评估。
// 规则阈值是自定默认值（08 章没有给数），写在 ADS_CAMPAIGN_ADVICE_RULES 里并在页面明示；预估影响是上限估算，不是承诺。
// 动作本身写亚马逊，随“广告写入接入”（P3-17）提供；这里只给建议，不执行。
@Injectable()
export class AdsCampaignAdviceService {
  constructor(private readonly prisma: PrismaService) {}

  async rules(ctx: AdsLoadContext, campaign: CampaignRecord, today: string): Promise<AdsAdviceRule[]> {
    const [waste, official, stockout] = await Promise.all([this.wastedTargets(ctx, campaign, today), this.official(ctx, campaign), this.stockout(ctx, campaign, today)])
    return [
      {
        kind: 'RAISE_BUDGET',
        rule: ADS_ADVICE_LABEL.RAISE_BUDGET,
        state: 'NOT_CONNECTED',
        note: `${ADS_OVER_BUDGET_NOTE}；目标 ACoS 也还没有设置入口（随自动规则 P3-13 提供），这条规则暂时没法评估`,
        hits: [],
      },
      waste,
      official,
      stockout,
    ]
  }

  private async wastedTargets(ctx: AdsLoadContext, campaign: CampaignRecord, today: string): Promise<AdsAdviceRule> {
    const head = {
      kind: 'WASTED_TARGETS' as const,
      rule: `${ADS_ADVICE_LABEL.WASTED_TARGETS}（近 ${RULES.WINDOW_DAYS} 天花费 ≥ ${RULES.WASTE_MIN_SPEND}、点击 ≥ ${RULES.WASTE_MIN_CLICKS}、订单为 0）`,
    }
    const groups = await this.prisma.adsTermMetric.groupBy({
      by: ['keywordId', 'keywordText', 'matchType'],
      where: {
        tenantId: ctx.tenantId,
        adsProfileId: campaign.adsProfileId,
        adProduct: campaign.adProduct,
        externalCampaignId: campaign.externalCampaignId,
        level: 'KEYWORD',
        currency: campaign.currency,
        reportDate: { gte: asDate(addDays(today, 1 - RULES.WINDOW_DAYS)), lte: asDate(today) },
        keywordText: { not: null },
      },
      _sum: { clicks: true, cost: true, purchases: true },
      orderBy: [{ _sum: { cost: 'desc' } }, { keywordText: 'asc' }],
      take: 2000,
    })
    if (groups.length === 0) {
      const ever = await anyRowInScope(this.prisma, ctx, 'adsTermMetric')
      return ever
        ? { ...head, state: 'NO_HIT', note: `近 ${RULES.WINDOW_DAYS} 天这个活动没有投放词的词级报表行`, hits: [] }
        : { ...head, state: 'NOT_CONNECTED', note: '词级报表（关键词报告）还没有同步，这条规则没法评估', hits: [] }
    }
    const hits = groups
      .flatMap((group): AdsAdviceHit[] => {
        const spend = num(group._sum.cost)
        const clicks = group._sum.clicks ?? 0
        const orders = group._sum.purchases ?? 0
        if (!group.keywordText || spend === null || !isWastedTarget({ spend, clicks, orders }, { minSpend: RULES.WASTE_MIN_SPEND, minClicks: RULES.WASTE_MIN_CLICKS })) return []
        return [
          {
            id: `waste:${group.keywordId ?? group.keywordText}:${group.matchType ?? ''}`,
            title: `投放词“${group.keywordText}”${group.matchType ? `（${group.matchType}）` : ''}花费高但没有订单`,
            evidence: `近 ${RULES.WINDOW_DAYS} 天花费 ${money(campaign.currency, spend)}，点击 ${clicks} 次，订单 0`,
            impact: `最多可省约 ${money(campaign.currency, spend)} / ${RULES.WINDOW_DAYS} 天（上限估算：降低竞价只能省一部分，否定才能全部省下）`,
            risk: '否定后该词不再展示，可能误伤品牌词或有转化潜力的长尾词；先在“搜索词”页签核对后再动',
            action: 'LOWER_BID',
            recommendationId: null,
          },
        ]
      })
      .slice(0, RULES.HIT_LIMIT)
    return hits.length > 0 ? { ...head, state: 'HIT', note: null, hits } : { ...head, state: 'NO_HIT', note: null, hits: [] }
  }

  private async official(ctx: AdsLoadContext, campaign: CampaignRecord): Promise<AdsAdviceRule> {
    const head = { kind: 'OFFICIAL_RECOMMENDATION' as const, rule: ADS_ADVICE_LABEL.OFFICIAL_RECOMMENDATION }
    const rows = await this.prisma.adsRecommendation.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: campaign.adsProfileId, entityId: campaign.externalCampaignId, entityType: { equals: 'CAMPAIGN', mode: 'insensitive' }, status: 'NEW' },
      select: { id: true, type: true, payloadJson: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
      take: RULES.HIT_LIMIT,
    })
    if (rows.length === 0) {
      const ever = await anyRowInScope(this.prisma, ctx, 'adsRecommendation')
      return ever
        ? { ...head, state: 'NO_HIT', note: '这个活动没有待处理的亚马逊官方推荐', hits: [] }
        : { ...head, state: 'NOT_CONNECTED', note: '官方推荐还没有同步（需要推荐接口），这条规则没法评估', hits: [] }
    }
    const hits = rows.map((row): AdsAdviceHit => {
      const budget = payloadNumber(row.payloadJson, ['suggestedBudget', 'recommendedBudget', 'budget'])
      return {
        id: `official:${row.id}`,
        title: `亚马逊推荐：${row.type}`,
        evidence: payloadSummary(row.payloadJson) ?? '亚马逊给出了这条推荐（推荐原文没有说明文字）',
        impact: budget === null ? '以亚马逊推荐自带的预估为准（这里不二次估算）' : `推荐日预算 ${money(campaign.currency, budget)}；效果以亚马逊的预估为准`,
        risk: '采纳等于对应的写入操作（改预算、改竞价等），会写亚马逊，随“广告写入接入”（P3-17）才能在这里执行；也可以忽略（只在本系统标记，需要写原因）',
        action: 'ADOPT',
        recommendationId: row.id,
      }
    })
    return { ...head, state: 'HIT', note: null, hits }
  }

  private async stockout(ctx: AdsLoadContext, campaign: CampaignRecord, today: string): Promise<AdsAdviceRule> {
    const head = { kind: 'STOCKOUT_PRODUCTS' as const, rule: `${ADS_ADVICE_LABEL.STOCKOUT_PRODUCTS}（最近 ${RULES.STOCKOUT_LOOKBACK_DAYS} 天仍有花费）` }
    const { rows } = await loadAdvertised(this.prisma, ctx, campaign, addDays(today, 1 - RULES.STOCKOUT_LOOKBACK_DAYS), today, 200)
    const spending = rows.filter(row => (row.metrics.spend ?? 0) > 0)
    if (spending.length === 0) {
      const ever = await anyRowInScope(this.prisma, ctx, 'adsAdvertisedProductMetric')
      return ever
        ? { ...head, state: 'NO_HIT', note: `最近 ${RULES.STOCKOUT_LOOKBACK_DAYS} 天这个活动没有推广商品花费`, hits: [] }
        : { ...head, state: 'NOT_CONNECTED', note: '被推广商品日报表还没有同步，这条规则没法评估', hits: [] }
    }
    if (!campaign.adsProfile.sellerAccountId) return { ...head, state: 'NOT_CONNECTED', note: '这个活动所属的广告账户没有绑定店铺，没法对照库存快照', hits: [] }
    if (spending.every(row => row.stock === 'UNKNOWN')) return { ...head, state: 'NOT_CONNECTED', note: '库存快照（接口来源）里没有这些推广商品，没法判断是否断货', hits: [] }
    const hits = spending
      .filter(row => row.stock === 'OUT_OF_STOCK')
      .slice(0, RULES.HIT_LIMIT)
      .map((row): AdsAdviceHit => {
        const spend = row.metrics.spend ?? 0
        return {
          id: `stockout:${row.asin}`,
          title: `商品 ${row.asin}${row.title ? `（${row.title.slice(0, 40)}）` : ''} 已断货但仍在花钱`,
          evidence: `可售 0（库存快照 ${row.snapshotDate ?? '日期未知'}）；最近 ${RULES.STOCKOUT_LOOKBACK_DAYS} 天花费 ${money(campaign.currency, spend)}`,
          impact: `每天约浪费 ${money(campaign.currency, spend / RULES.STOCKOUT_LOOKBACK_DAYS)}（按最近 ${RULES.STOCKOUT_LOOKBACK_DAYS} 天平均估算）`,
          risk: '暂停后补货时要记得重新启用，否则错过补货后的流量；快照可能滞后，先确认确实断货',
          action: 'PAUSE_PRODUCT',
          recommendationId: null,
        }
      })
    return hits.length > 0 ? { ...head, state: 'HIT', note: null, hits } : { ...head, state: 'NO_HIT', note: null, hits: [] }
  }
}
