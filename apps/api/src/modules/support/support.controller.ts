import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { SupportDetailService } from './support-detail.service'
import { SupportListService } from './support-list.service'

// 支持案件（P2b-04，07 章 7.4；freeze/api.md /support-cases*）：只读，案件由同步器从亚马逊支持接口取回，没有任何写入口。
@UseGuards(AuthGuard)
@Controller('support-cases')
export class SupportController {
  constructor(
    private readonly lists: SupportListService,
    private readonly details: SupportDetailService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }
}
