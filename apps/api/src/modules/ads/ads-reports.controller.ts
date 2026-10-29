import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ADS_REPORT_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AdsParityService } from './ads-parity.service'
import { AdsReportsService } from './ads-reports.service'
import { AdsReportsWriteService } from './ads-reports-write.service'

// 广告报表（P3-15，08 章 8.12；freeze/api.md /ads/reports*、/ads/report-templates、/ads/parity*）：
// 读（ads.read）：报告任务列表、模板库、迁移期核对；写（ads.report）：创建任务、重试、历史回补、手动触发核对。
// 写入口都只在本系统里建任务并入队（202），不修改任何广告设置。静态路径（backfill、report-templates、parity）都写在带 :id 的路径之前。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsReportsController {
  constructor(
    private readonly lists: AdsReportsService,
    private readonly writes: AdsReportsWriteService,
    private readonly parity: AdsParityService,
  ) {}

  @Get('reports')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get('report-templates')
  async templates(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.templates(req, query), req)
  }

  @Write({ action: 'ADS_REPORT_REQUESTED', resourceType: 'AdsReportJob', permission: ADS_REPORT_WRITE })
  @HttpCode(202)
  @Post('reports')
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Write({ action: 'ADS_REPORT_BACKFILL_REQUESTED', resourceType: 'AdsReportJob', permission: ADS_REPORT_WRITE })
  @HttpCode(202)
  @Post('reports/backfill')
  async backfill(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.backfill(req, body), req)
  }

  @Write({ action: 'ADS_REPORT_RETRIED', resourceType: 'AdsReportJob', permission: ADS_REPORT_WRITE })
  @HttpCode(202)
  @Post('reports/:id/retry')
  async retry(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.writes.retry(req, id), req)
  }

  @Get('parity')
  async parityOverview(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.parity.overview(req, query), req)
  }

  @Write({ action: 'ADS_PARITY_REQUESTED', resourceType: 'AdsParityRun', permission: ADS_REPORT_WRITE })
  @HttpCode(202)
  @Post('parity/run')
  async parityRun(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.parity.run(req, body), req)
  }

  @Get('parity/:runId/diffs')
  async parityDiffs(@Req() req: RequestWithContext, @Param('runId') runId: string, @Query() query: Record<string, string>) {
    return ok(await this.parity.diffs(req, runId, query), req)
  }
}
