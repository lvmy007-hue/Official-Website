import { Injectable } from '@nestjs/common'
import { ADS_GROUP_TABS, ADS_GROUP_WRITE_NOTE, ADS_WRITE_PENDING, ScopeSearchSchema, type AdsGroupDetailResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { num, rangeOf } from './ads-campaigns-common'
import { AdsGroupAccessService, accountOf, campaignView } from './ads-groups-common'
import { entityMetricsBlock } from './ads-entity-trend'

// 广告组详情（08 章 8.4）：身份区（名称、所属活动、状态、默认竞价）与关键指标；各页签的数据由各自接口按需取。
// 修改默认竞价、暂停与启用、添加否定投放写亚马逊，随“广告写入接入”（P3-17），这里只给说明。
@Injectable()
export class AdsGroupDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsGroupAccessService,
  ) {}

  async detail(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<AdsGroupDetailResponse> {
    const { group, campaign, ref, ctx, tenantId } = await this.access.resolveGroup(req, id, rawQuery)
    const { period, compare } = await rangeOf(this.prisma, tenantId, ScopeSearchSchema.parse(rawQuery), now)
    const metrics = await entityMetricsBlock(this.prisma, ctx, { ref, entityTypes: ['AD_GROUP'], entityId: group.adGroupId, label: '广告组' }, period, compare)
    return {
      identity: {
        id: group.id,
        adsProfileId: group.adsProfileId,
        adGroupId: group.adGroupId,
        name: group.name,
        state: group.state,
        defaultBid: num(group.defaultBid),
        currency: ref.currency,
        campaign: campaignView(group.campaignId, campaign),
        account: accountOf(group.adsProfile),
        syncedAt: group.syncedAt.toISOString(),
      },
      metrics,
      tabs: ADS_GROUP_TABS.map(tab => ({ key: tab.key, label: tab.label })),
      write: { state: ADS_WRITE_PENDING.state, note: ADS_GROUP_WRITE_NOTE },
    }
  }
}
