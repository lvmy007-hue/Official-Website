import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsTodayService } from './ads-today.service'

// 今日广告（08 章 8.2）：只读，要求 ads.read；范围按本人数据授权收窄。
// 注意：查询参数的类型必须直接写 Record<string, string>，不能起别名。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsTodayController {
  constructor(private readonly today: AdsTodayService) {}

  @Get('today')
  async getToday(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.today.today(req, query), req)
  }
}
