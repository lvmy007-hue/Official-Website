import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { CapacityImportService } from './capacity-import.service'
import { CapacityService } from './capacity.service'
import { LedgerService } from './ledger.service'
import { RemovalReadService } from './removal-read.service'
import { RemovalReceiptService } from './removal-receipt.service'

// 库存台账、移除与弃置、仓储容量与费用（P2a-09，06 章 6.4 至 6.6；freeze/api.md 第八节）。
// 查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
// 路由顺序：这里的静态路径（ledger、removals、capacity）必须在 InventoryDetailController 的 :id 之前注册，InventoryModule 里按此顺序列出；
// 同一控制器内 removals/recommended 要写在 removals/:id 之前。
@UseGuards(AuthGuard)
@Controller('inventory')
export class InventoryStockController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly removals: RemovalReadService,
    private readonly receipts: RemovalReceiptService,
    private readonly capacity: CapacityService,
    private readonly limits: CapacityImportService,
  ) {}

  @Get('ledger')
  async ledgerList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.ledger.ledger(req, query), req)
  }

  @Get('removals')
  async removalList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.removals.list(req, query), req)
  }

  @Get('removals/recommended')
  async recommended(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.removals.recommended(req, query), req)
  }

  @Get('removals/:id')
  async removalDetail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.removals.detail(req, id), req)
  }

  @Write({ action: 'REMOVAL_RECEIPT_RECORDED', resourceType: 'RemovalOrder', permission: 'inventory.removal.receive' })
  @Post('removals/:id/receipt')
  async receive(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.receipts.receive(req, id, body), req)
  }

  @Get('capacity')
  async capacityOverview(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.capacity.capacity(req, query), req)
  }

  @Write({ action: 'STORAGE_LIMITS_IMPORTED', resourceType: 'StorageCapacitySnapshot', permission: 'data.import' })
  @Post('capacity/limits-import')
  async importLimits(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.limits.importLimits(req, body), req)
  }
}
