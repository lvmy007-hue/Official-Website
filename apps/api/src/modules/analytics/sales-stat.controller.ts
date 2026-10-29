import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { SalesStatService } from './sales-stat.service'

// 销量统计（P6-25，freeze/api.md `GET /analytics/sales-stat`）：只读，权限 analytics.read，范围参数（店铺、日期）在地址栏。
// 查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
@UseGuards(AuthGuard)
@Controller('analytics')
export class SalesStatController {
  constructor(private readonly stat: SalesStatService) {}

  @Get('sales-stat')
  async salesStat(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.stat.query(req, query), req)
  }
}
