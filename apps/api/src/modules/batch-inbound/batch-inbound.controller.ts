import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { BATCH_INBOUND_PERMISSION } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { BatchInboundService } from './batch-inbound.service'

// 补货批次转入仓计划草稿（P6-08）：与补货模块共用 /replenishment 前缀，单独成模块是因为入仓模块已经依赖补货模块，放进补货模块会形成循环依赖。
// 预览与确认是同一个 POST（dryRun 缺省 true），都不调用亚马逊；除 replenishment.plan.create 外，服务里还会校验 inbound.plan.write。
@UseGuards(AuthGuard)
@Controller('replenishment')
export class BatchInboundController {
  constructor(private readonly drafts: BatchInboundService) {}

  // 拦截器登记的动作是“请求生成”：预览没有写任何数据，只留下这条通用记录（被拒绝时也留痕）；真正生成草稿时服务里另写 REPLENISHMENT_INBOUND_DRAFTED 与每份计划的创建审计。
  @Write({ action: 'REPLENISHMENT_INBOUND_DRAFT_REQUESTED', resourceType: 'ReplenishmentBatch', permission: BATCH_INBOUND_PERMISSION })
  @HttpCode(200)
  @Post('batches/:id/to-inbound-drafts')
  async toDrafts(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.drafts.toDrafts(req, id, body), req)
  }

  @Get('intents')
  async intents(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.drafts.intents(req, query), req)
  }
}
