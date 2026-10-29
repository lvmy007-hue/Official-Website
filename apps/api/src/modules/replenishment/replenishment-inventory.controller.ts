import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { ReplenishmentSkuService } from './replenishment-sku.service'

// 库存详情的“补货建议”页签：路径属于库存详情（inventory/:id/replenishment），内容由补货模块提供，
// 这样补货模块单向依赖库存模块，避免两个模块互相引用。
@UseGuards(AuthGuard)
@Controller('inventory')
export class ReplenishmentInventoryController {
  constructor(private readonly sku: ReplenishmentSkuService) {}

  @Get(':id/replenishment')
  async replenishment(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.sku.forInventory(req, id), req)
  }
}
