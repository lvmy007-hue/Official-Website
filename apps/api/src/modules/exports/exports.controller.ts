import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ExportsService } from './exports.service'

@UseGuards(AuthGuard)
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  // 受理即返回任务（202）：文件由后台任务生成；审计由服务在同一事务里写（audit:false）
  @Write({ action: 'EXPORT_REQUESTED', resourceType: 'ExportJob', permission: 'export.create', audit: false })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(202).json(ok(await this.exports.create(req, body), req))
  }

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.exports.list(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.exports.detail(req, id), req)
  }

  @Get(':id/download')
  async download(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.exports.download(req, id), req)
  }
}
