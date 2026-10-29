import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { SubscribeSaveListsService } from './subscribe-save-lists.service'
import { SubscribeSaveOverviewService } from './subscribe-save-overview.service'

// 订阅省（P4-06，04 章 4.9；freeze/api.md /subscribe-save*）：全部只读，权限 analytics.read。
// 订阅省的报价与折扣在卖家后台设置，系统不写亚马逊，所以没有任何写入口。静态路径 asins、offers 与概览同属一个控制器，没有 :id 路由，顺序无影响。
@UseGuards(AuthGuard)
@Controller('subscribe-save')
export class SubscribeSaveController {
  constructor(
    private readonly overviews: SubscribeSaveOverviewService,
    private readonly lists: SubscribeSaveListsService,
  ) {}

  @Get()
  async overview(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.overviews.overview(req, query), req)
  }

  @Get('asins')
  async asins(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.asins(req, query), req)
  }

  @Get('offers')
  async offers(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.offers(req, query), req)
  }
}
