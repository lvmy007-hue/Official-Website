import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common'
import { FEE_EVENTS_RECONCILE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { FeeEventsDetailService } from './fee-events-detail.service'
import { FeeEventsListService } from './fee-events-list.service'
import { FeeEventsSummaryService } from './fee-events-summary.service'
import { FeeEventsWriteService } from './fee-events-write.service'

// 费用事件（P2b-05，07 章 7.5；freeze/api.md /finance/events*）。静态路径 events/summary 必须写在 events/:id 之前。
// 冻结表之外新增：页签统计 events/summary、证据与变更历史 events/:id；发起导出走导出中心（kind = fee-events）。
@UseGuards(AuthGuard)
@Controller('finance/events')
export class FeeEventsController {
  constructor(
    private readonly lists: FeeEventsListService,
    private readonly summaries: FeeEventsSummaryService,
    private readonly details: FeeEventsDetailService,
    private readonly writes: FeeEventsWriteService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get('summary')
  async summary(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.summaries.summary(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }

  @Write({ action: 'FEE_EVENT_RECONCILED', resourceType: 'FbaFeeEvent', permission: FEE_EVENTS_RECONCILE })
  @Patch(':id/reconciliation')
  async reconcile(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.reconcile(req, id, body), req)
  }
}
