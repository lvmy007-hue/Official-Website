import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { STOCK_COUNT_APPROVE, STOCK_COUNT_WRITE } from './procurement-common'
import { StockCountService } from './stock-count.service'
import { WarehouseReadService } from './warehouse-read.service'

// 国内仓（P2a-10，06 章 6.9；freeze/api.md /domestic-warehouse*、/stock-counts*）。
// 与旧的 /warehouses、/inventory/movements（亚马逊仓库存快照）并存，互不影响。
@UseGuards(AuthGuard)
@Controller()
export class WarehouseController {
  constructor(
    private readonly read: WarehouseReadService,
    private readonly counts: StockCountService,
  ) {}

  @Get('domestic-warehouse/stock')
  async stock(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.stock(req, query), req)
  }

  @Get('domestic-warehouse/movements')
  async movements(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.movements(req, query), req)
  }

  @Get('stock-counts')
  async listCounts(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.counts.list(req, query), req)
  }

  @Write({ action: 'STOCK_COUNT_SAVED', resourceType: 'StockCount', permission: STOCK_COUNT_WRITE })
  @Post('stock-counts')
  async saveCount(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.counts.save(req, body), req)
  }

  @Write({ action: 'STOCK_COUNT_APPROVED', resourceType: 'StockCount', permission: STOCK_COUNT_APPROVE })
  @Post('stock-counts/:id/approve')
  async approveCount(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.counts.approve(req, id, body), req)
  }
}
