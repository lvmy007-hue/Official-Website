import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { CashService } from './cash.service'
import { CompareService } from './compare.service'
import { KpisService } from './kpis.service'
import { OverviewService } from './overview.service'
import { TrendService } from './trend.service'

// 经营控制台（04 章 4.1）：全部是读接口，要求 overview.read；范围按本人数据授权收窄；利润相关字段另需“利润”字段权限，现金另需 finance.read。
// 注意：查询参数的类型必须直接写 Record<string, string>，不能起别名（别名与 @Query 装饰器重名会让校验管道误把它当成类）。
@UseGuards(AuthGuard)
@Controller('overview')
export class OverviewController {
  constructor(
    private readonly overview: OverviewService,
    private readonly kpis: KpisService,
    private readonly trend: TrendService,
    private readonly compare: CompareService,
    private readonly cash: CashService,
  ) {}

  @Get('source-health')
  async sourceHealth(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.overview.sourceHealth(req, query), req)
  }

  @Get('kpis')
  async getKpis(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.kpis.kpis(req, query), req)
  }

  @Get('trend')
  async getTrend(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.trend.trend(req, query), req)
  }

  @Get('attribution')
  async attribution(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.kpis.attribution(req, query), req)
  }

  @Get('store-compare')
  async storeCompare(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.compare.storeCompare(req, query), req)
  }

  @Get('asin-rank')
  async asinRank(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.compare.asinRank(req, query), req)
  }

  @Get('volatility')
  async volatility(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.compare.volatility(req, query), req)
  }

  @Get('ad-anomalies')
  async adAnomalies(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.overview.adAnomalies(req, query), req)
  }

  @Get('inventory-risk')
  async inventoryRisk(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.overview.inventoryRisk(req, query), req)
  }

  @Get('growth-waterfall')
  async growthWaterfall(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.compare.growthWaterfall(req, query), req)
  }

  @Get('cash')
  async getCash(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.cash.cash(req, query), req)
  }
}
