import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common'
import { PROFIT_ITEM_ACTIONS, PROFIT_ITEM_MANAGE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ProfitItemsSaveService } from './profit-items-save.service'
import { ProfitItemsService } from './profit-items.service'

// 利润项目字典（P6-18，freeze/api.md 第 16 节 /finance/profit-items*）：读取需要 finance.read，整树保存需要 finance.profititem.manage。
// 静态路径 unmapped 在前。
@UseGuards(AuthGuard)
@Controller('finance/profit-items')
export class ProfitItemsController {
  constructor(
    private readonly items: ProfitItemsService,
    private readonly saver: ProfitItemsSaveService,
  ) {}

  @Get()
  async read(@Req() req: RequestWithContext) {
    return ok(await this.items.read(req), req)
  }

  @Get('unmapped')
  async unmapped(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.items.unmapped(req, query), req)
  }

  @Write({ action: PROFIT_ITEM_ACTIONS.saved, resourceType: 'ProfitItemDictionary', permission: PROFIT_ITEM_MANAGE })
  @Put()
  async save(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.saver.save(req, body), req)
  }
}
