import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { ProfitBridgeService } from './profit-bridge.service'
import { ProfitCoverageService } from './profit-coverage.service'
import { ProfitGroupsService } from './profit-groups.service'
import { ProfitOverviewService } from './profit-overview.service'
import { ProfitStoresService } from './profit-stores.service'

// 利润分析（P2b-10，07 章 7.9；freeze/api.md /profit/*）：6 条只读路由。读取利润日表（P2b-09 派生），不写任何数据。
// 旧的 /analytics/profit（有内存汇总截断缺陷）已随本包下线。
@UseGuards(AuthGuard)
@Controller('profit')
export class ProfitController {
  constructor(
    private readonly overview: ProfitOverviewService,
    private readonly stores: ProfitStoresService,
    private readonly groups: ProfitGroupsService,
    private readonly coverage: ProfitCoverageService,
    private readonly bridge: ProfitBridgeService,
  ) {}

  @Get('overview')
  async readOverview(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.overview.overview(req, query), req)
  }

  @Get('stores')
  async readStores(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.stores.stores(req, query), req)
  }

  @Get('asins')
  async readAsins(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.groups.asins(req, query), req)
  }

  @Get('ads')
  async readAds(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.groups.ads(req, query), req)
  }

  @Get('cost-coverage')
  async readCoverage(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.coverage.coverage(req, query), req)
  }

  @Get('bridge')
  async readBridge(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.bridge.compare(req, query), req)
  }
}
