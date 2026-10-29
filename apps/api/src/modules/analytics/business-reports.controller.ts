import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { BusinessReportsAsinService } from './business-reports-asin.service'
import { BusinessReportsDateService } from './business-reports-date.service'
import { BusinessReportsSummaryService } from './business-reports-summary.service'

// 业务报告（P4-02，04 章 4.5；freeze/api.md /analytics/sales-traffic/*）：全部只读，权限 analytics.read。
// 参数：全局范围参数（店铺、日期、对比期）加各接口自己的 granularity、level、q、sort、cursor、pageSize、asin。
@UseGuards(AuthGuard)
@Controller('analytics/sales-traffic')
export class BusinessReportsController {
  constructor(
    private readonly summary: BusinessReportsSummaryService,
    private readonly dates: BusinessReportsDateService,
    private readonly asins: BusinessReportsAsinService,
  ) {}

  @Get('summary')
  async dashboard(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.summary.summary(req, query), req)
  }

  @Get('by-date')
  async byDate(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.dates.byDate(req, query), req)
  }

  @Get('by-asin')
  async byAsin(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.asins.list(req, query), req)
  }

  @Get('trends')
  async trends(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.asins.trends(req, query), req)
  }
}
