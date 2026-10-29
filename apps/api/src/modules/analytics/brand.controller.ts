import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { BrandBasketService } from './brand-basket.service'
import { BrandCatalogService } from './brand-catalog.service'
import { BrandRepeatService } from './brand-repeat.service'
import { BrandSqpService } from './brand-sqp.service'
import { BrandTermsService } from './brand-terms.service'
import { ShareTrendService } from './share-trend.service'

// 品牌分析（P4-04，04 章 4.7；freeze/api.md /analytics/brand/*）：全部只读，权限 analytics.brand.read。
// 参数：全局范围参数（店铺）加各接口自己的 period（WEEK、MONTH、QUARTER）、periodStart、dimension、asin、brand、q、sort、cursor、pageSize 等。
@UseGuards(AuthGuard)
@Controller('analytics/brand')
export class BrandController {
  constructor(
    private readonly searchQuery: BrandSqpService,
    private readonly catalogPerformance: BrandCatalogService,
    private readonly searchTerms: BrandTermsService,
    private readonly marketBasket: BrandBasketService,
    private readonly repeatPurchase: BrandRepeatService,
    private readonly shareTrend: ShareTrendService,
  ) {}

  @Get('share-trend')
  async share(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.shareTrend.trend(req, query), req)
  }

  @Get('search-query')
  async sqp(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.searchQuery.search(req, query), req)
  }

  @Get('catalog')
  async catalog(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.catalogPerformance.catalog(req, query), req)
  }

  @Get('search-terms')
  async terms(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.searchTerms.terms(req, query), req)
  }

  @Get('market-basket')
  async basket(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.marketBasket.basket(req, query), req)
  }

  @Get('repeat-purchase')
  async repeat(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.repeatPurchase.repeat(req, query), req)
  }
}
