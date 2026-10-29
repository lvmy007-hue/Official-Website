import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { PRICING_GUARDRAIL_ACTION, PRICING_PRICE_WRITE, PRICING_RULE_ACTIONS, PRICING_RULE_WRITE, PRICING_READ, PRICING_SUBMITTED_ACTIONS } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { PricingDetailService } from './pricing-detail.service'
import { PricingGuardrailService } from './pricing-guardrail.service'
import { PricingListService } from './pricing-list.service'
import { PricingRuleService } from './pricing-rule.service'
import { PricingRuleDryRunService } from './pricing-rule-dryrun.service'
import { PricingRuleRunsService } from './pricing-rule-runs.service'
import { PricingWriteService } from './pricing-write.service'

// 定价与购物车（P4-11；05 章 5.5；freeze/api.md /pricing*）。静态路径（guardrails、rules、rule-runs）必须写在 :sku 之前，否则会被当成 SKU。
// 改价走“先校验预览、再提交”：校验只读（不要写入开关），提交需要 sw.pricing.update；亚马逊的调用都在后台任务里。规则与护栏只改本系统里的设置。
@UseGuards(AuthGuard)
@Controller('pricing')
export class PricingController {
  constructor(
    private readonly lists: PricingListService,
    private readonly details: PricingDetailService,
    private readonly writes: PricingWriteService,
    private readonly guardrails: PricingGuardrailService,
    private readonly rules: PricingRuleService,
    private readonly dryRuns: PricingRuleDryRunService,
    private readonly ruleRuns: PricingRuleRunsService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get('guardrails')
  async listGuardrails(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.guardrails.list(req, query), req)
  }

  @Write({ action: PRICING_GUARDRAIL_ACTION, resourceType: 'PriceGuardrail', permission: PRICING_RULE_WRITE })
  @Put('guardrails')
  async saveGuardrail(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.guardrails.upsert(req, body), req)
  }

  @Get('rules')
  async listRules(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.rules.list(req, query), req)
  }

  @Write({ action: PRICING_RULE_ACTIONS.created, resourceType: 'PricingRule', permission: PRICING_RULE_WRITE })
  @Post('rules')
  async createRule(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.rules.create(req, body), req)
  }

  @Write({ action: PRICING_RULE_ACTIONS.updated, resourceType: 'PricingRule', permission: PRICING_RULE_WRITE })
  @Patch('rules/:id')
  async updateRule(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.rules.update(req, id, body), req)
  }

  // 试运行用 POST 是冻结表里的约定；它只读，不改任何数据，冻结表要求写审计。
  @Write({ action: PRICING_RULE_ACTIONS.dryRun, resourceType: 'PricingRule', permission: PRICING_RULE_WRITE })
  @HttpCode(200)
  @Post('rules/:id/dry-run')
  async dryRun(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.dryRuns.dryRun(req, id, body), req)
  }

  @Get('rules/:id/runs')
  async ruleRunList(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.ruleRuns.runs(req, id, query), req)
  }

  @Write({ action: PRICING_RULE_ACTIONS.dismissed, resourceType: 'PricingRuleRun', permission: PRICING_PRICE_WRITE })
  @HttpCode(200)
  @Post('rule-runs/:id/dismiss')
  async dismiss(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.ruleRuns.dismiss(req, id, body), req)
  }

  @Get(':sku')
  async detail(@Req() req: RequestWithContext, @Param('sku') sku: string, @Query() query: Record<string, string>) {
    return ok(await this.details.detail(req, sku, query), req)
  }

  // 模拟只读，不写审计。
  @Write({ action: 'PRICE_SIMULATED', resourceType: 'Price', permission: PRICING_READ, audit: false })
  @HttpCode(200)
  @Post(':sku/simulation')
  async simulate(@Req() req: RequestWithContext, @Param('sku') sku: string, @Body() body: unknown) {
    return ok(await this.details.simulate(req, sku, body), req)
  }

  @Write({ action: PRICING_SUBMITTED_ACTIONS.PRICE_VALIDATE, resourceType: 'ListingWriteRun', permission: PRICING_PRICE_WRITE })
  @Post(':sku/validate')
  async validate(@Req() req: RequestWithContext, @Param('sku') sku: string, @Body() body: unknown) {
    return ok(await this.writes.validate(req, sku, body), req)
  }

  @Write({ action: PRICING_SUBMITTED_ACTIONS.PRICE_PATCH, resourceType: 'ListingWriteRun', permission: PRICING_PRICE_WRITE })
  @Patch(':sku')
  async update(@Req() req: RequestWithContext, @Param('sku') sku: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, sku, body), req)
  }
}
