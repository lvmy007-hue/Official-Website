import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AsinAnalyticsService } from './asin-analytics.service'
import { ParentDetailService } from './parent-detail.service'
import { ParentExtrasService } from './parent-extras.service'

// ASIN 与父体分析（P4-03，04 章 4.6；freeze/api.md /analytics/asins、/analytics/parents/:parentAsin/*）：全部只读，权限 analytics.read；
// 库存页签再要 inventory.read，广告页签再要 ads.read（权限先于参数校验）。
@UseGuards(AuthGuard)
@Controller('analytics')
export class AsinAnalyticsController {
  constructor(
    private readonly list: AsinAnalyticsService,
    private readonly detail: ParentDetailService,
    private readonly extras: ParentExtrasService,
  ) {}

  @Get('asins')
  async asins(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  @Get('parents/:parentAsin')
  async identity(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.identity(req, query, parentAsin), req)
  }

  @Get('parents/:parentAsin/matrix')
  async matrix(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.matrix(req, query, parentAsin), req)
  }

  @Get('parents/:parentAsin/trend')
  async trend(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.trend(req, query, parentAsin), req)
  }

  @Get('parents/:parentAsin/traffic')
  async traffic(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.traffic(req, query, parentAsin), req)
  }

  @Get('parents/:parentAsin/inventory')
  async inventory(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.extras.inventory(req, query, parentAsin), req)
  }

  @Get('parents/:parentAsin/ads')
  async ads(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.extras.ads(req, query, parentAsin), req)
  }

  @Get('parents/:parentAsin/reviews')
  async reviews(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.extras.reviews(req, query, parentAsin), req)
  }

  @Get('parents/:parentAsin/changes')
  async changes(@Req() req: RequestWithContext, @Param('parentAsin') parentAsin: string, @Query() query: Record<string, string>) {
    return ok(await this.extras.changes(req, query, parentAsin), req)
  }
}
