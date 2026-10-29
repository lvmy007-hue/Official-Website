import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsChangesService } from './ads-changes.service'
import { AdsChangeCompareService } from './ads-changes-compare.service'

// 广告变更记录（P3-14，08 章 8.11；freeze/api.md /ads/changes*）：两条只读路由（权限 ads.read），没有写入口。
// 变更记录由 worker 对比实体快照（外部变更）与广告写入（手动、自动规则、分时策略，随 P3-17）写入。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsChangesController {
  constructor(
    private readonly lists: AdsChangesService,
    private readonly compares: AdsChangeCompareService,
  ) {}

  @Get('changes')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get('changes/:id/compare')
  async compare(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.compares.compare(req, id), req)
  }
}
