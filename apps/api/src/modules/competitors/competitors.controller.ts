import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { COMPETITOR_ACTIONS, COMPETITORS_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { CompetitorsCandidatesService } from './competitors-candidates.service'
import { CompetitorsDetailService } from './competitors-detail.service'
import { CompetitorsListService } from './competitors-list.service'
import { CompetitorsWriteService } from './competitors-write.service'

// 竞品监控（P4-12；05 章 5.6；freeze/api.md /competitors*）。静态路径 candidates 必须写在 :asin 之前，否则会被当成 ASIN。
// 竞品只来自官方接口与报告：热门搜索词点击前三的商品，或手工添加；不抓取亚马逊前台页面。关注与取消只改本系统的清单，不调用亚马逊。
@UseGuards(AuthGuard)
@Controller('competitors')
export class CompetitorsController {
  constructor(
    private readonly lists: CompetitorsListService,
    private readonly candidates: CompetitorsCandidatesService,
    private readonly details: CompetitorsDetailService,
    private readonly writes: CompetitorsWriteService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get('candidates')
  async listCandidates(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.candidates.candidates(req, query), req)
  }

  @Write({ action: COMPETITOR_ACTIONS.added, resourceType: 'WatchedAsin', permission: COMPETITORS_WRITE })
  @Post()
  async add(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.add(req, body), req)
  }

  @Get(':asin')
  async detail(@Req() req: RequestWithContext, @Param('asin') asin: string, @Query() query: Record<string, string>) {
    return ok(await this.details.detail(req, asin, query), req)
  }

  @Write({ action: COMPETITOR_ACTIONS.removed, resourceType: 'WatchedAsin', permission: COMPETITORS_WRITE })
  @Delete(':asin')
  async remove(@Req() req: RequestWithContext, @Param('asin') asin: string, @Query() query: Record<string, string>) {
    return ok(await this.writes.remove(req, asin, query), req)
  }
}
