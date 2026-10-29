import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { EventsService } from './events.service'

// 统一事件（P6-06；freeze/api.md 16.1）：读权限随对象，各类事件再按各自模块的读权限过滤，服务内判定。
@UseGuards(AuthGuard)
@Controller()
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get('events')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.events.list(req, query), req)
  }
}
