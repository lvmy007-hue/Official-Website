import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { CUSTOM_REPORT_SOURCES } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard, ContextService } from '../auth'
import { CustomMetricService } from './custom-metric.service'
import { CustomReportService } from './custom-report.service'
import { ReportQueryService } from './report-query.service'

// 自定义报表接口（P6-32）。静态路径 validate 写在 :id 之前。
@UseGuards(AuthGuard)
@Controller()
export class CustomReportsController {
  constructor(
    private readonly context: ContextService,
    private readonly metrics: CustomMetricService,
    private readonly reports: CustomReportService,
    private readonly queries: ReportQueryService,
  ) {}

  @Get('report-sources')
  async listSources(@Req() req: RequestWithContext) {
    await this.context.authorize(req, 'reports.read')
    return ok({ items: CUSTOM_REPORT_SOURCES.map(source => ({ code: source.code, name: source.name, permission: source.permission, dimensions: source.dimensions, columns: source.columns })) }, req)
  }

  @Write({ action: 'CUSTOM_REPORT_RUN', resourceType: 'CustomReport', permission: 'reports.read', audit: false })
  @HttpCode(200)
  @Post('report-sources/:code/query')
  async query(@Req() req: RequestWithContext, @Param('code') code: string, @Query() query: Record<string, string>, @Body() body: unknown) {
    return ok(await this.queries.query(req, code, query, body), req)
  }

  @Get('custom-metrics')
  async metricList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.metrics.list(req, query), req)
  }

  @Write({ action: 'CUSTOM_METRIC_CREATED', resourceType: 'CustomMetric', permission: 'reports.read', audit: false })
  @HttpCode(200)
  @Post('custom-metrics/validate')
  async validate(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.metrics.validate(req, body), req)
  }

  @Write({ action: 'CUSTOM_METRIC_CREATED', resourceType: 'CustomMetric', permission: 'reports.custom.write' })
  @HttpCode(201)
  @Post('custom-metrics')
  async createMetric(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.metrics.create(req, body), req)
  }

  @Write({ action: 'CUSTOM_METRIC_UPDATED', resourceType: 'CustomMetric', permission: 'reports.custom.write' })
  @Put('custom-metrics/:id')
  async updateMetric(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.metrics.update(req, id, body), req)
  }

  @Write({ action: 'CUSTOM_METRIC_DELETED', resourceType: 'CustomMetric', permission: 'reports.custom.write' })
  @Delete('custom-metrics/:id')
  async removeMetric(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.metrics.remove(req, id), req)
  }

  @Get('custom-reports')
  async reportList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reports.list(req, query), req)
  }

  @Write({ action: 'CUSTOM_REPORT_CREATED', resourceType: 'CustomReport', permission: 'reports.custom.write' })
  @HttpCode(201)
  @Post('custom-reports')
  async createReport(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.reports.create(req, body), req)
  }

  @Write({ action: 'CUSTOM_REPORT_UPDATED', resourceType: 'CustomReport', permission: 'reports.custom.write' })
  @Put('custom-reports/:id')
  async updateReport(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.reports.update(req, id, body), req)
  }

  @Write({ action: 'CUSTOM_REPORT_DELETED', resourceType: 'CustomReport', permission: 'reports.custom.write' })
  @Delete('custom-reports/:id')
  async removeReport(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.reports.remove(req, id), req)
  }

  @Write({ action: 'CUSTOM_REPORT_EXPORTED', resourceType: 'CustomReport', permission: 'reports.read', audit: false })
  @HttpCode(200)
  @Post('custom-reports/:id/run')
  async run(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>, @Body() body: unknown) {
    return ok(await this.reports.run(req, id, query, body), req)
  }
}
