import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { InventoryDetailMoreService } from './inventory-detail-more.service'
import { InventoryDetailService } from './inventory-detail.service'

// 库存详情（P2a-06，06 章 6.1）：概览与 9 个数据页签（第 10 个“变更与审计”复用 /events 与 /comments）。
// 页签 6“补货建议”（:id/replenishment）由补货模块提供（P2a-07），与我方计算链共用一套结果。
// 带 :id 的路径会匹配任何一段，所以本控制器必须排在所有 inventory/<静态路径> 控制器之后。
@UseGuards(AuthGuard)
@Controller('inventory')
export class InventoryDetailController {
  constructor(
    private readonly detail: InventoryDetailService,
    private readonly more: InventoryDetailMoreService,
  ) {}

  @Get(':id')
  async identity(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.identity(req, id), req)
  }

  @Get(':id/structure')
  async structure(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.structure(req, id, query), req)
  }

  @Get(':id/snapshots')
  async snapshots(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.snapshots(req, id, query), req)
  }

  @Get(':id/ledger')
  async ledger(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.detail.ledger(req, id, query), req)
  }

  @Get(':id/inbound')
  async inbound(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.inbound(req, id), req)
  }

  @Get(':id/awd')
  async awd(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.more.awd(req, id), req)
  }

  @Get(':id/age-fees')
  async ageFees(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.more.ageFees(req, id), req)
  }

  @Get(':id/disposition')
  async disposition(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.more.disposition(req, id), req)
  }

  @Get(':id/forecast')
  async forecast(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.more.forecast(req, id), req)
  }
}
