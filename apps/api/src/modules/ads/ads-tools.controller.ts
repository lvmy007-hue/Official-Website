import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsConflictsService } from './ads-conflicts.service'
import { AdsDuplicatesService } from './ads-duplicates.service'

// 广告分析工具（P6-24，freeze/api.md GET /ads/conflicts、GET /ads/duplicate-keywords）：投放冲突与重复关键词，只读（ads.read 与数据范围）。
// 批量加词在写入控制器（POST /ads/keywords/bulk-add，走统一写入流水线）；超预算时间条在活动控制器（GET /ads/campaigns/:id/budget-timeline）。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsToolsController {
  constructor(
    private readonly conflicts: AdsConflictsService,
    private readonly duplicates: AdsDuplicatesService,
  ) {}

  @Get('conflicts')
  async conflictList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.conflicts.list(req, query), req)
  }

  @Get('duplicate-keywords')
  async duplicateList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.duplicates.list(req, query), req)
  }
}
