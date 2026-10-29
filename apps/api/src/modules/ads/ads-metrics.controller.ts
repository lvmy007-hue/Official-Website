import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsMetricsService } from './ads-metrics.service'

// 广告指标（P3-15，08 章 8.13；freeze/api.md /ads/metrics）：一条只读路由（权限 ads.read），自由组合维度与指标。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsMetricsController {
  constructor(private readonly metrics: AdsMetricsService) {}

  @Get('metrics')
  async query(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.metrics.query(req, query), req)
  }
}
