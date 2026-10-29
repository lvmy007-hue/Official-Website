import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { InventoryHealthService } from './inventory-health.service'
import { InventoryPolicyService } from './inventory-policy.service'

// 库存健康（P2a-06，06 章 6.1）：列表、顶部指标与图表、库存规则（读取与保存新版本）。
// 查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
// 路由顺序：静态路径（summary、rules）必须在 InventoryDetailController 的 :id 之前注册，InventoryModule 里按此顺序列出。
@UseGuards(AuthGuard)
@Controller('inventory')
export class InventoryHealthController {
  constructor(
    private readonly health: InventoryHealthService,
    private readonly policies: InventoryPolicyService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.health.list(req, query), req)
  }

  @Get('summary')
  async summary(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.health.summary(req, query), req)
  }

  @Get('rules')
  async rules(@Req() req: RequestWithContext) {
    return ok(await this.health.rules(req), req)
  }

  @Write({ action: 'REPLENISHMENT_POLICY_VERSIONED', resourceType: 'ReplenishmentPolicy', permission: 'replenishment.policy.write' })
  @Put('rules')
  async saveRules(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.policies.write(req, body), req)
  }
}
