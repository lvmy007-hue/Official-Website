import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsOverviewService } from './ads-overview.service'

// 广告控制台（08 章 8.1）：只读，要求 ads.read；范围按本人数据授权收窄。
// 注意：查询参数的类型必须直接写 Record<string, string>，不能起别名。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsOverviewController {
  constructor(private readonly overview: AdsOverviewService) {}

  @Get('overview')
  async getOverview(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.overview.overview(req, query), req)
  }
}
