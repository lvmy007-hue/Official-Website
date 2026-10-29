import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { SettlementsDetailService } from './settlements-detail.service'
import { SettlementsLinesService } from './settlements-lines.service'
import { SettlementsListService } from './settlements-list.service'

// 结算交易（P2b-07，07 章 7.7；freeze/api.md /settlements*）：全部只读，没有写入口（到账手工登记属于回款页 P2b-08）。
@UseGuards(AuthGuard)
@Controller('settlements')
export class SettlementsController {
  constructor(
    private readonly lists: SettlementsListService,
    private readonly details: SettlementsDetailService,
    private readonly lines: SettlementsLinesService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get(':id/summary')
  async summary(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.summary(req, id), req)
  }

  @Get(':id/transactions')
  async transactions(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.lines.lines(req, id, query), req)
  }

  @Get(':id/reconciliation')
  async reconciliation(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.reconciliation(req, id), req)
  }

  @Get(':id/exceptions')
  async exceptions(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.lines.exceptions(req, id, query), req)
  }

  @Get(':id/disbursements')
  async disbursements(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.disbursements(req, id), req)
  }
}
