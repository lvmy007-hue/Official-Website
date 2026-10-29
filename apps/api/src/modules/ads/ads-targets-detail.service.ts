import { Injectable } from '@nestjs/common'
import { ADS_TARGET_WRITE_NOTE, ADS_WRITE_PENDING, adsTargetTabsFor, ScopeSearchSchema, type AdsTargetDetailResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { rangeOf } from './ads-campaigns-common'
import { accountOf, AdsGroupAccessService, campaignView, kindLabelOf, suggestedBidFor, TARGET_METRIC_TYPES } from './ads-groups-common'
import { entityMetricsBlock } from './ads-entity-trend'

// 投放对象详情（08 章 8.5）：身份区（投放文本或定向表达式、匹配方式、状态、当前竞价、建议竞价区间、所属活动与广告组）与关键指标。
// 建议竞价取自官方推荐原文（没有推荐就是“无推荐”）；调价、暂停、否定写亚马逊，随 P3-17。
@Injectable()
export class AdsTargetDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsGroupAccessService,
  ) {}

  async detail(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<AdsTargetDetailResponse> {
    const { target, group, campaign, externalCampaignId, ref, ctx, tenantId } = await this.access.resolveTarget(req, id, rawQuery)
    const { period, compare } = await rangeOf(this.prisma, tenantId, ScopeSearchSchema.parse(rawQuery), now)
    const [metrics, suggestedBid] = await Promise.all([
      entityMetricsBlock(this.prisma, ctx, { ref, entityTypes: TARGET_METRIC_TYPES, entityId: target.targetId, label: '投放对象' }, period, compare),
      suggestedBidFor(this.prisma, tenantId, target.adsProfileId, target.targetId),
    ])
    return {
      identity: {
        id: target.id,
        adsProfileId: target.adsProfileId,
        targetId: target.targetId,
        kind: target.kind,
        kindLabel: kindLabelOf(target.kind),
        expression: target.expression,
        matchType: target.matchType,
        state: target.state,
        bid: target.bid,
        currency: ref.currency,
        suggestedBid,
        campaign: campaignView(externalCampaignId, campaign),
        adGroup: { id: group?.id ?? null, adGroupId: target.adGroupId, name: group?.name ?? null },
        account: accountOf(target.adsProfile),
        syncedAt: target.syncedAt.toISOString(),
      },
      metrics,
      tabs: adsTargetTabsFor(target.kind),
      write: { state: ADS_WRITE_PENDING.state, note: ADS_TARGET_WRITE_NOTE },
    }
  }
}
