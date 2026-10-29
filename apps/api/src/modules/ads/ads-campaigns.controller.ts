import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ADS_CAMPAIGN_META_ACTION, ADS_CAMPAIGN_WRITE, ADS_RECOMMENDATION_DISMISS_ACTION } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AdsBudgetTimelineService } from './ads-budget-timeline.service'
import { AdsCampaignDetailService } from './ads-campaigns-detail.service'
import { AdsCampaignEntitiesService } from './ads-campaigns-entities.service'
import { AdsCampaignListService } from './ads-campaigns-list.service'
import { AdsCampaignMetaService } from './ads-campaigns-meta.service'
import { AdsCampaignProductsService } from './ads-campaigns-products.service'
import { AdsCampaignRecommendationsService } from './ads-campaigns-recommendations.service'
import { AdsCampaignTermsService } from './ads-campaigns-terms.service'
import { AdsCampaignTrendService } from './ads-campaigns-trend.service'

type Params = Record<string, string>

// 广告活动列表与详情（P3-07，08 章 8.3；freeze/api.md /ads/campaigns*）。静态路径 campaigns/meta 必须写在 campaigns/:id 之前。
// 读接口都要 ads.read 与数据范围；唯一的写入是系统内标签与负责人（ads.campaign.write，不写亚马逊）和忽略官方推荐。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsCampaignsController {
  constructor(
    private readonly lists: AdsCampaignListService,
    private readonly metas: AdsCampaignMetaService,
    private readonly details: AdsCampaignDetailService,
    private readonly trends: AdsCampaignTrendService,
    private readonly entities: AdsCampaignEntitiesService,
    private readonly terms: AdsCampaignTermsService,
    private readonly products: AdsCampaignProductsService,
    private readonly advice: AdsCampaignRecommendationsService,
    private readonly budgets: AdsBudgetTimelineService,
  ) {}

  @Get('campaigns')
  async list(@Req() req: RequestWithContext, @Query() query: Params) {
    return ok(await this.lists.list(req, query), req)
  }

  @Write({ action: ADS_CAMPAIGN_META_ACTION, resourceType: 'AdsCampaign', permission: ADS_CAMPAIGN_WRITE })
  @Patch('campaigns/meta')
  async meta(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.metas.update(req, body), req)
  }

  @Get('campaigns/:id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.details.detail(req, id, query), req)
  }

  @Get('campaigns/:id/trend')
  async trend(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.trends.trend(req, id, query), req)
  }

  @Get('campaigns/:id/hourly')
  async hourly(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.trends.hourly(req, id, query), req)
  }

  @Get('campaigns/:id/budget-timeline')
  async budgetTimeline(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.budgets.timeline(req, id, query), req)
  }

  @Get('campaigns/:id/ad-groups')
  async adGroups(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.entities.adGroups(req, id, query), req)
  }

  @Get('campaigns/:id/targets')
  async targets(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.entities.targets(req, id, query), req)
  }

  @Get('campaigns/:id/search-terms')
  async searchTerms(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.terms.list(req, id, query), req)
  }

  @Get('campaigns/:id/products')
  async productList(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.products.list(req, id, query), req)
  }

  @Get('campaigns/:id/placements')
  async placements(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.entities.placements(req, id, query), req)
  }

  @Get('campaigns/:id/creatives')
  async creatives(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.entities.creatives(req, id, query), req)
  }

  @Get('campaigns/:id/audiences')
  async audiences(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.entities.audiences(req, id, query), req)
  }

  @Get('campaigns/:id/history')
  async history(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.entities.history(req, id, query), req)
  }

  @Get('campaigns/:id/forecast')
  async forecast(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.advice.forecast(req, id, query), req)
  }

  @Get('campaigns/:id/recommendations')
  async recommendations(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.advice.recommendations(req, id, query), req)
  }

  @Get('campaigns/:id/changes')
  async changes(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.advice.changes(req, id, query), req)
  }

  @Write({ action: ADS_RECOMMENDATION_DISMISS_ACTION, resourceType: 'AdsRecommendation', permission: ADS_CAMPAIGN_WRITE })
  @Post('recommendations/:id/dismiss')
  async dismiss(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.advice.dismiss(req, id, body), req)
  }
}
