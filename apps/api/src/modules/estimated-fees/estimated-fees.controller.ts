import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ESTIMATED_FEE_ACTIONS, ESTIMATED_FEE_WRITE } from '@nova/api-contracts'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { EstimatedFeesImportService } from './estimated-fees-import.service'
import { EstimatedFeesReadService } from './estimated-fees-read.service'
import { EstimatedFeesWriteService } from './estimated-fees-write.service'

// 预估与自定义费用（P6-20，freeze/api.md `/finance/estimated-fees*`）：读取需要 finance.read，录入、修改、删除与导入需要 finance.estimatedfee.write。
// 静态路径 import 在前；DELETE 的 id 与版本走查询参数。
@UseGuards(AuthGuard)
@Controller('finance/estimated-fees')
export class EstimatedFeesController {
  constructor(
    private readonly reader: EstimatedFeesReadService,
    private readonly writer: EstimatedFeesWriteService,
    private readonly importer: EstimatedFeesImportService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reader.list(req, query), req)
  }

  @Write({ action: ESTIMATED_FEE_ACTIONS.imported, resourceType: 'EstimatedFee', permission: ESTIMATED_FEE_WRITE, audit: false })
  @HttpCode(200)
  @Post('import')
  async importFile(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.importer.importFile(req, body), req)
  }

  @Write({ action: ESTIMATED_FEE_ACTIONS.created, resourceType: 'EstimatedFee', permission: ESTIMATED_FEE_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.writer.create(req, body), req))
  }

  @Write({ action: ESTIMATED_FEE_ACTIONS.updated, resourceType: 'EstimatedFee', permission: ESTIMATED_FEE_WRITE })
  @Put()
  async update(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writer.update(req, body), req)
  }

  @Write({ action: ESTIMATED_FEE_ACTIONS.deleted, resourceType: 'EstimatedFee', permission: ESTIMATED_FEE_WRITE })
  @Delete()
  async remove(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.writer.remove(req, query), req)
  }
}
