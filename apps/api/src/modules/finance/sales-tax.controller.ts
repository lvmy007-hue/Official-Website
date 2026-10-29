import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { SalesTaxService } from './sales-tax.service'

// 销售税（P2b-12，07 章 7.11；freeze/api.md /finance/sales-tax）：只读，参数就是全局范围参数（店铺、日期）。
@UseGuards(AuthGuard)
@Controller('finance')
export class SalesTaxController {
  constructor(private readonly salesTax: SalesTaxService) {}

  @Get('sales-tax')
  async read(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.salesTax.read(req, query), req)
  }
}
