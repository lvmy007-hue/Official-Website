import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { BUSINESS_RULES_WRITE, FINANCE_POLICY_STEP_UP, FINANCE_POLICY_WRITE, METRIC_VERSION_ACTIONS, PROFIT_FORMULA_READ } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { MetricVersionsDiffService } from './metric-versions-diff.service'
import { MetricVersionsReadService } from './metric-versions-read.service'
import { MetricVersionsWriteService } from './metric-versions-write.service'

// 利润公式（P6-31，freeze/api.md `/finance/profit-formula`）：读取需要 finance.read；提交修改需要 finance.policy.write 并再次验证身份，审批通过才生效。
@UseGuards(AuthGuard)
@Controller('finance/profit-formula')
export class ProfitFormulaController {
  constructor(
    private readonly reads: MetricVersionsReadService,
    private readonly writes: MetricVersionsWriteService,
  ) {}

  @Get()
  async get(@Req() req: RequestWithContext) {
    return ok(await this.reads.formula(req), req)
  }

  @Write({ action: METRIC_VERSION_ACTIONS.submitted, resourceType: 'MetricVersion', permission: FINANCE_POLICY_WRITE, stepUp: FINANCE_POLICY_STEP_UP })
  @Put()
  async submit(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.submitFormula(req, body), req)
  }
}

// 业务口径（P6-31，`/settings/business-rules`）：读取需要 settings.read；修改需要 settings.business.write 并再次验证身份，同样走审批。
@UseGuards(AuthGuard)
@Controller('settings/business-rules')
export class BusinessRulesController {
  constructor(
    private readonly reads: MetricVersionsReadService,
    private readonly writes: MetricVersionsWriteService,
  ) {}

  @Get()
  async get(@Req() req: RequestWithContext) {
    return ok(await this.reads.rules(req), req)
  }

  @Write({ action: METRIC_VERSION_ACTIONS.submitted, resourceType: 'MetricVersion', permission: BUSINESS_RULES_WRITE, stepUp: FINANCE_POLICY_STEP_UP })
  @Put(':key')
  async submit(@Req() req: RequestWithContext, @Param('key') key: string, @Body() body: unknown) {
    return ok(await this.writes.submitRule(req, key, body), req)
  }
}

// 口径版本（P6-31，`/metric-versions`）：列表、审批、差异报告。
@UseGuards(AuthGuard)
@Controller('metric-versions')
export class MetricVersionsController {
  constructor(
    private readonly reads: MetricVersionsReadService,
    private readonly writes: MetricVersionsWriteService,
    private readonly diffs: MetricVersionsDiffService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reads.list(req, query), req)
  }

  @Write({ action: METRIC_VERSION_ACTIONS.approved, resourceType: 'MetricVersion', permission: FINANCE_POLICY_WRITE, stepUp: FINANCE_POLICY_STEP_UP })
  @Post(':id/decision')
  async decide(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.decide(req, id, body), req)
  }

  // 差异报告是只读计算，用 POST 只是因为区间放在请求体里；不落库，通用审计记一条“生成差异报告”
  @Write({ action: METRIC_VERSION_ACTIONS.diffed, resourceType: 'MetricVersion', permission: PROFIT_FORMULA_READ })
  @Post(':id/diff-report')
  async diff(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.diffs.diff(req, id, body), req)
  }
}
