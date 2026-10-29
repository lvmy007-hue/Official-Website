import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { REPORT_ACTIONS, REPORT_WRITE } from '@nova/api-contracts'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ReportsDetailService } from './reports-detail.service'
import { ReportsListService } from './reports-list.service'
import { ReportsService } from './reports.service'

// 报表中心（P5-03）：列表合并三个来源，详情按来源适配；创建、取消、重试、下载原始文件只对亚马逊报告任务开放。
@UseGuards(AuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly lists: ReportsListService,
    private readonly details: ReportsDetailService,
    private readonly writes: ReportsService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }

  @Write({ action: REPORT_ACTIONS.created, resourceType: 'FbaReportJob', permission: REPORT_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(202).json(ok(await this.writes.create(req, body), req))
  }

  @Write({ action: REPORT_ACTIONS.cancelled, resourceType: 'FbaReportJob', permission: REPORT_WRITE })
  @HttpCode(200)
  @Post(':id/cancel')
  async cancel(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.writes.cancel(req, id), req)
  }

  @Write({ action: REPORT_ACTIONS.retried, resourceType: 'FbaReportJob', permission: REPORT_WRITE })
  @Post(':id/retry')
  async retry(@Req() req: RequestWithContext, @Param('id') id: string, @Res() response: Response) {
    return response.status(202).json(ok(await this.writes.retry(req, id), req))
  }

  @Get(':id/download')
  async download(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.writes.download(req, id), req)
  }
}
