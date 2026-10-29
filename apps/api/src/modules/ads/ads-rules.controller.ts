import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ADS_READ, ADS_RULE_CREATED_ACTION, ADS_RULE_DRY_RUN_ACTION, ADS_RULE_UPDATED_ACTION, ADS_RULE_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AdsRulesService } from './ads-rules.service'
import { AdsRulesDryRunService } from './ads-rules-dryrun.service'
import { AdsRulesRunsService } from './ads-rules-runs.service'
import { AdsRulesWriteService } from './ads-rules-write.service'

// 自动规则（P3-13，08 章 8.10；freeze/api.md /ads/rules*）：列表、详情与执行记录（ads.read）、创建与修改（ads.rule.write，只改本系统里的规则）、试运行（只读）。
// 规则命中后只生成待办；自动执行写亚马逊，受写入开关“自动规则执行”控制，随 P3-17 接入。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsRulesController {
  constructor(
    private readonly lists: AdsRulesService,
    private readonly writes: AdsRulesWriteService,
    private readonly dryRuns: AdsRulesDryRunService,
    private readonly runs: AdsRulesRunsService,
  ) {}

  @Get('rules')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Write({ action: ADS_RULE_CREATED_ACTION, resourceType: 'AdsAutomationRule', permission: ADS_RULE_WRITE })
  @Post('rules')
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Get('rules/:id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.lists.detail(req, id), req)
  }

  @Write({ action: ADS_RULE_UPDATED_ACTION, resourceType: 'AdsAutomationRule', permission: ADS_RULE_WRITE })
  @Patch('rules/:id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }

  // 试运行用 POST 是冻结里的约定；它只读、不改任何数据，所以不写审计（但仍要幂等键，和其他 POST 一致）。
  @Write({ action: ADS_RULE_DRY_RUN_ACTION, resourceType: 'AdsAutomationRule', permission: ADS_READ, audit: false })
  @HttpCode(200)
  @Post('rules/:id/dry-run')
  async dryRun(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.dryRuns.dryRun(req, id, body), req)
  }

  @Get('rules/:id/runs')
  async history(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.runs.runs(req, id, query), req)
  }
}
