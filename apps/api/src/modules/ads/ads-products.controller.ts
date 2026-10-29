import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdsAsinListService } from './ads-products.service'

// 广告商品（P3-09，08 章 8.6；freeze/api.md GET /ads/products）：按店铺 × ASIN 汇总全部广告，只读（ads.read 与数据范围）。
// 冻结里的 PATCH /ads/products（按 ASIN 暂停或启用）与 POST /ads/products/copy（复制到其他广告组）写亚马逊，随 P3-17，本包没有实现（请求会 404）。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsProductsController {
  constructor(private readonly products: AdsAsinListService) {}

  @Get('products')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.products.list(req, query), req)
  }
}
