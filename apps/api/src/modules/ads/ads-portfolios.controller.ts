import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsPortfolioDetailService } from './ads-portfolios-detail.service'
import { AdsPortfolioListService } from './ads-portfolios-list.service'

// 广告组合与预算（P3-11，08 章 8.8；freeze/api.md GET /ads/portfolios）：列表与详情，只读（ads.read 与数据范围）。
// 冻结里的 POST /ads/portfolios（新建）与 PATCH /ads/portfolios/{id}（改预算、预算规则）写亚马逊，随 P3-17，本包没有实现（请求会 404）。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsPortfoliosController {
  constructor(
    private readonly list: AdsPortfolioListService,
    private readonly detail: AdsPortfolioDetailService,
  ) {}

  @Get('portfolios')
  async portfolios(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  @Get('portfolios/:id')
  async portfolio(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.detail(req, id, query), req)
  }
}
