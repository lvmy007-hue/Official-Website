import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { PromotionsDetailService } from './promotions-detail.service'
import { PromotionsListService } from './promotions-list.service'
import { PromotionsStackingService } from './promotions-stacking.service'

// 促销与优惠券（P4-05，04 章 4.8；freeze/api.md /promotions*）：只读，促销由同步器从亚马逊促销接口取回，亚马逊接口不支持写入，所以没有任何写入口。
@UseGuards(AuthGuard)
@Controller('promotions')
export class PromotionsController {
  constructor(
    private readonly lists: PromotionsListService,
    private readonly details: PromotionsDetailService,
    private readonly stackings: PromotionsStackingService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  // 静态路径 stacking 必须写在 :id 之前，否则会被当成促销编号（P6-17）
  @Get('stacking')
  async stacking(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.stackings.stacking(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }
}
