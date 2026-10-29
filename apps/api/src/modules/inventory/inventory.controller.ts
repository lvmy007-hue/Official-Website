import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { InventoryService } from './inventory.service'

@UseGuards(AuthGuard)
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('inventory/movements')
  async movements(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.inventory.movements(req, query), req)
  }

  @Get('warehouses')
  async warehouses(@Req() req: RequestWithContext) {
    return ok(await this.inventory.warehouses(req), req)
  }
}
