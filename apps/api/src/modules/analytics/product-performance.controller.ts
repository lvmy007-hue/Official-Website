import { Body, Controller, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common'
import { PP_PERMISSION } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ProductPerformanceSlowService } from './product-performance-slow.service'
import { ProductPerformanceService } from './product-performance.service'

// 商品表现宽表（P6-22，freeze/api.md `/analytics/product-performance/*`）：全部是只读计算，用 POST 只是因为维度、筛选、可见列、行编号放在请求体里。
// 不落库、不写审计（audit: false）；权限 analytics.read，范围参数（店铺、日期、对比期）在地址栏；利润、成本、广告、库存列按各自权限降级。
@UseGuards(AuthGuard)
@Controller('analytics/product-performance')
export class ProductPerformanceController {
  constructor(
    private readonly list: ProductPerformanceService,
    private readonly slow: ProductPerformanceSlowService,
  ) {}

  @Write({ action: 'PRODUCT_PERFORMANCE_QUERIED', resourceType: 'ProductPerformance', permission: PP_PERMISSION, audit: false })
  @HttpCode(200)
  @Post('query')
  async query(@Req() req: RequestWithContext, @Query() query: Record<string, string>, @Body() body: unknown) {
    return ok(await this.list.query(req, query, body), req)
  }

  @Write({ action: 'PRODUCT_PERFORMANCE_SUMMARIZED', resourceType: 'ProductPerformance', permission: PP_PERMISSION, audit: false })
  @HttpCode(200)
  @Post('summary')
  async summary(@Req() req: RequestWithContext, @Query() query: Record<string, string>, @Body() body: unknown) {
    return ok(await this.list.summary(req, query, body), req)
  }

  @Write({ action: 'PRODUCT_PERFORMANCE_TRENDED', resourceType: 'ProductPerformance', permission: PP_PERMISSION, audit: false })
  @HttpCode(200)
  @Post('trend')
  async trend(@Req() req: RequestWithContext, @Query() query: Record<string, string>, @Body() body: unknown) {
    return ok(await this.slow.trend(req, query, body), req)
  }

  @Write({ action: 'PRODUCT_PERFORMANCE_COLUMNS_LOADED', resourceType: 'ProductPerformance', permission: PP_PERMISSION, audit: false })
  @HttpCode(200)
  @Post('async-columns')
  async asyncColumns(@Req() req: RequestWithContext, @Query() query: Record<string, string>, @Body() body: unknown) {
    return ok(await this.slow.slow(req, query, body), req)
  }
}
