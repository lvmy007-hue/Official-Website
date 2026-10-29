import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdTermDetailService } from './ad-terms-detail.service'
import { AdTermsService } from './ad-terms.service'

// 词级中心（P3-10，08 章 8.7；freeze/api.md GET /ads/terms、/ads/terms/roots、/ads/terms/detail、/ads/negatives）：只读（ads.read 与数据范围）。
// 冻结里的 POST /ads/negatives（添加否定投放）与 POST /ads/keywords（添加关键词）写亚马逊，随 P3-17，本包没有实现（请求会 404）。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdTermsController {
  constructor(
    private readonly terms: AdTermsService,
    private readonly detail: AdTermDetailService,
  ) {}

  @Get('terms')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.terms.list(req, query), req)
  }

  @Get('terms/roots')
  async roots(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.terms.roots(req, query), req)
  }

  @Get('terms/detail')
  async termDetail(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.detail.detail(req, query), req)
  }

  @Get('negatives')
  async negatives(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.terms.list(req, query, 'negatives'), req)
  }
}
