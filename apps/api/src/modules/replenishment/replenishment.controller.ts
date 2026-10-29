import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ReplenishmentActionService } from './replenishment-action.service'
import { ReplenishmentComputeService } from './replenishment-compute.service'
import { ReplenishmentEvaluateService } from './replenishment-evaluate.service'
import { ReplenishmentPolicyService } from './replenishment-policy.service'
import { ReplenishmentReadService } from './replenishment-read.service'
import { ReplenishmentSimulateService } from './replenishment-simulate.service'

// 补货建议（P2a-07，06 章 6.2；freeze/api.md 第八节）。查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
@UseGuards(AuthGuard)
@Controller('replenishment')
export class ReplenishmentController {
  constructor(
    private readonly policies: ReplenishmentPolicyService,
    private readonly compute: ReplenishmentComputeService,
    private readonly read: ReplenishmentReadService,
    private readonly actions: ReplenishmentActionService,
    private readonly evaluation: ReplenishmentEvaluateService,
    private readonly simulation: ReplenishmentSimulateService,
  ) {}

  @Get('policies')
  async policyList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.policies.list(req, query), req)
  }

  @Write({ action: 'REPLENISHMENT_POLICY_VERSIONED', resourceType: 'ReplenishmentPolicy', permission: 'replenishment.policy.write' })
  @Put('policies')
  async savePolicy(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.policies.upsert(req, body), req)
  }

  @Write({ action: 'REPLENISHMENT_RECOMPUTED', resourceType: 'ReplenishmentBatch', permission: 'replenishment.plan.create' })
  @Post('recompute')
  async recompute(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.compute.recompute(req, body), req)
  }

  @Get('recommendations')
  async recommendations(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.recommendations(req, query), req)
  }

  @Get('batches')
  async batches(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.batches(req, query), req)
  }

  @Get('batches/:id')
  async batch(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.read.batchDetail(req, id, query), req)
  }

  @Write({ action: 'REPLENISHMENT_DECIDED', resourceType: 'ReplenishmentBatch', permission: 'replenishment.plan.create' })
  @Post('batches/:id/decisions')
  async decide(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.decide(req, id, body), req)
  }

  @Write({ action: 'REPLENISHMENT_EVALUATED', resourceType: 'ReplenishmentBatch', permission: 'replenishment.plan.create' })
  @Post('batches/:id/evaluate')
  async evaluate(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.evaluation.evaluate(req, id), req)
  }

  @Write({ action: 'REPLENISHMENT_PURCHASE_DRAFTED', resourceType: 'PurchaseOrder', permission: 'replenishment.plan.create' })
  @Post('to-purchase-draft')
  async toPurchaseDraft(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.actions.toPurchaseDraft(req, body), req)
  }

  @Write({ action: 'REPLENISHMENT_AWD_DRAFT_RECORDED', resourceType: 'ReplenishmentBatch', permission: 'replenishment.plan.create' })
  @Post('to-awd-draft')
  async toAwdDraft(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.actions.toAwdDraft(req, body), req)
  }

  // 库存走势模拟只读；上游仓储经济模拟会向亚马逊数据中心提交查询（需要 replenishment.plan.create，服务内校验）。
  @Write({ action: 'REPLENISHMENT_SIMULATED', resourceType: 'ReplenishmentSimulation', permission: 'replenishment.read' })
  @Post('simulate')
  async simulate(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.simulation.simulate(req, body), req)
  }

  @Get('simulations/:id')
  async simulationRun(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.simulation.awdRun(req, id), req)
  }
}
