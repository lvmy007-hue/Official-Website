import { Injectable } from '@nestjs/common'
import type { AdsTermList } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AdsCampaignAccessService } from './ads-campaigns-common'
import { loadSearchTerms } from './ads-terms-load'

// 搜索词页签（08 章 8.3）：词级报表按搜索词汇总，并标出是否已被投放或已被否定；“添加为关键词、添加否定”随 P3-17 提供。汇总逻辑在 ads-terms-load.ts（广告组页签共用）。
@Injectable()
export class AdsCampaignTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsCampaignAccessService,
  ) {}

  async list(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsTermList> {
    const tab = await this.access.openTab(req, id, rawQuery)
    const { campaign } = tab
    return loadSearchTerms(
      this.prisma,
      tab.ctx,
      { adsProfileId: campaign.adsProfileId, adProduct: campaign.adProduct, currency: campaign.currency, externalCampaignId: campaign.externalCampaignId },
      tab,
    )
  }
}
