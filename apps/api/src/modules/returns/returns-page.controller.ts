import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { ReturnsAnalysisService } from './returns-analysis.service'
import { ReturnsAwaitingService } from './returns-awaiting.service'
import { ReturnsDetailService } from './returns-detail.service'
import { ReturnsListService } from './returns-list.service'

// 退货页（P2b-02）：全部是读接口。静态路径（analysis、awaiting）必须在 :id 之前注册。
@UseGuards(AuthGuard)
@Controller('returns')
export class ReturnsPageController {
  constructor(
    private readonly list: ReturnsListService,
    private readonly detail: ReturnsDetailService,
    private readonly awaitingService: ReturnsAwaitingService,
    private readonly analysisService: ReturnsAnalysisService,
  ) {}

  @Get()
  async index(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  @Get('analysis')
  async analysis(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.analysisService.analysis(req, query), req)
  }

  @Get('awaiting')
  async awaiting(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.awaitingService.awaiting(req, query), req)
  }

  @Get(':id')
  async one(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.detail(req, id), req)
  }
}
