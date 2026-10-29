import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsGroupDetailService } from './ads-groups-detail.service'
import { AdsGroupTabsService } from './ads-groups-tabs.service'
import { AdsTargetDetailService } from './ads-targets-detail.service'
import { AdsTargetTabsService } from './ads-targets-tabs.service'

type Params = Record<string, string>

// 广告组详情与投放对象详情（P3-08，08 章 8.4、8.5；freeze/api.md /ads/ad-groups/:id*、/ads/targets/:id*）。
// 全部只读，权限 ads.read 加数据范围；范围外与不存在的对象都是 404。修改默认竞价、暂停启用、调价、否定写亚马逊，随 P3-17（冻结里的 PATCH 这里没有实现）。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsGroupsController {
  constructor(
    private readonly details: AdsGroupDetailService,
    private readonly tabs: AdsGroupTabsService,
  ) {}

  @Get('ad-groups/:id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.details.detail(req, id, query), req)
  }

  @Get('ad-groups/:id/trend')
  async trend(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.trend(req, id, query), req)
  }

  @Get('ad-groups/:id/targets')
  async targets(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.targets(req, id, query), req)
  }

  @Get('ad-groups/:id/search-terms')
  async searchTerms(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.searchTerms(req, id, query), req)
  }

  @Get('ad-groups/:id/products')
  async products(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.products(req, id, query), req)
  }

  @Get('ad-groups/:id/negatives')
  async negatives(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.negatives(req, id, query), req)
  }

  @Get('ad-groups/:id/hourly')
  async hourly(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.hourly(req, id, query), req)
  }

  @Get('ad-groups/:id/history')
  async history(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.history(req, id, query), req)
  }
}

@UseGuards(AuthGuard)
@Controller('ads')
export class AdsTargetsController {
  constructor(
    private readonly details: AdsTargetDetailService,
    private readonly tabs: AdsTargetTabsService,
  ) {}

  @Get('targets/:id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.details.detail(req, id, query), req)
  }

  @Get('targets/:id/trend')
  async trend(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.trend(req, id, query), req)
  }

  @Get('targets/:id/search-terms')
  async searchTerms(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.searchTerms(req, id, query), req)
  }

  @Get('targets/:id/placements')
  async placements(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.placements(req, id, query), req)
  }

  @Get('targets/:id/hourly')
  async hourly(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.hourly(req, id, query), req)
  }

  @Get('targets/:id/bid-history')
  async bidHistory(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.bidHistory(req, id, query), req)
  }

  @Get('targets/:id/brand-analytics')
  async brandAnalytics(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Params) {
    return ok(await this.tabs.brandAnalytics(req, id, query), req)
  }
}
