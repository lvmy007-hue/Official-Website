import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { TodayService } from './today.service'

// 今日实时（04 章 4.2）：读接口，要求 overview.read；范围按本人数据授权收窄。
// 查询参数类型必须直接写 Record<string, string>，不能起别名。
@UseGuards(AuthGuard)
@Controller('today')
export class TodayController {
  constructor(private readonly today: TodayService) {}

  @Get('summary')
  async summary(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.today.summary(req, query), req)
  }

  @Get('hourly')
  async hourly(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.today.hourly(req, query), req)
  }

  @Get('events')
  async events(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.today.events(req, query), req)
  }
}
