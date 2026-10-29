import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { COSTS_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { CostsDetailService } from './costs-detail.service'
import { CostsImportService } from './costs-import.service'
import { CostsListService } from './costs-list.service'
import { CostsWriteService } from './costs-write.service'

// 商品成本（P2b-14，05 章 5.9；freeze/api.md /costs*）。
// 多出冻结表的路由：确认生效（POST /costs/activate）、改与丢弃草稿（PATCH、DELETE /costs/versions/:id）、版本对比（GET /costs/:sku/compare），见 CR-052。
@UseGuards(AuthGuard)
@Controller('costs')
export class CostsController {
  constructor(
    private readonly lists: CostsListService,
    private readonly details: CostsDetailService,
    private readonly writes: CostsWriteService,
    private readonly imports: CostsImportService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Write({ action: 'COST_VERSION_CREATED', resourceType: 'CostVersion', permission: COSTS_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Write({ action: 'COST_VERSIONS_IMPORTED', resourceType: 'CostVersion', permission: COSTS_WRITE })
  @Post('import')
  async importFile(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.imports.importFile(req, body), req)
  }

  @Write({ action: 'COST_VERSION_ACTIVATED', resourceType: 'CostVersion', permission: COSTS_WRITE })
  @Post('activate')
  async activate(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.activate(req, body), req)
  }

  @Write({ action: 'COST_VERSION_UPDATED', resourceType: 'CostVersion', permission: COSTS_WRITE })
  @Patch('versions/:id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }

  @Write({ action: 'COST_VERSION_DISCARDED', resourceType: 'CostVersion', permission: COSTS_WRITE })
  @Delete('versions/:id')
  async discard(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.writes.discard(req, id, query), req)
  }

  @Get(':sku/compare')
  async compare(@Req() req: RequestWithContext, @Param('sku') sku: string, @Query() query: Record<string, string>) {
    return ok(await this.details.compare(req, sku, query), req)
  }

  @Get(':sku')
  async detail(@Req() req: RequestWithContext, @Param('sku') sku: string) {
    return ok(await this.details.detail(req, sku), req)
  }
}
