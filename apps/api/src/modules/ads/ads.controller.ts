import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsService } from './ads.service'

// 广告档案列表。报告任务、模板库、核对在 AdsReportsController，指标分析在 AdsMetricsController（P3-15）。
@UseGuards(AuthGuard)
@Controller()
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  @Get('ads/profiles')
  async profiles(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.ads.profiles(req, query), req)
  }
}
