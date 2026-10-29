import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AlertRulePreviewService } from './alert-rule-preview.service'
import { AlertRulesQueryService } from './alert-rules-query.service'
import { AlertTemplatesService } from './alert-templates.service'
import { AlertRulesWriteService } from './alert-rules-write.service'
import { AlertsActionsService } from './alerts-actions.service'
import { AlertsDetailService } from './alerts-detail.service'
import { AlertsListService } from './alerts-list.service'
import { AlertsReadService } from './alerts-read.service'

// 静态路径（rules）必须排在 :id 之前，否则会被当成预警编号。
@UseGuards(AuthGuard)
@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly list: AlertsListService,
    private readonly detail: AlertsDetailService,
    private readonly actions: AlertsActionsService,
    private readonly rulesQuery: AlertRulesQueryService,
    private readonly rulesWrite: AlertRulesWriteService,
    private readonly rulePreview: AlertRulePreviewService,
    private readonly reads: AlertsReadService,
    private readonly templatesService: AlertTemplatesService,
  ) {}

  @Get()
  async index(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  @Get('templates')
  async templates(@Req() req: RequestWithContext) {
    return ok(await this.templatesService.list(req), req)
  }

  // 已读标记只改我自己的已读状态，不属于业务数据变更，不写通用审计（audit:false，与消息已读一致）；仍要求幂等键
  @Write({ action: 'ALERT_READ_MARKED', resourceType: 'AlertRead', permission: 'alerts.read', audit: false })
  @HttpCode(200)
  @Post('read')
  async markRead(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.reads.markRead(req, body), req)
  }

  // 批量标记已处理：逐条走单条“关闭”（各自写审计 ALERT_CLOSED），这里不再多写一条
  @Write({ action: 'ALERT_BATCH_HANDLED', resourceType: 'AlertInstance', permission: 'alerts.handle' })
  @HttpCode(200)
  @Post('handled')
  async batchHandle(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.reads.batchHandle(req, body), req)
  }

  @Get('rules')
  async rules(@Req() req: RequestWithContext) {
    return ok(await this.rulesQuery.list(req), req)
  }

  @Write({ action: 'ALERT_RULE_CREATED', resourceType: 'AlertRule', permission: 'alerts.manage' })
  @Post('rules')
  async createRule(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.rulesWrite.create(req, body), req))
  }

  // 试算用 POST 是冻结里的约定（条件放在请求体里）；它只读、不改任何数据，所以不写审计（但仍要幂等键，和其他 POST 一致）。
  @Write({ action: 'ALERT_RULE_PREVIEWED', resourceType: 'AlertRule', permission: 'alerts.manage', audit: false })
  @HttpCode(200)
  @Post('rules/preview')
  async previewRule(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.rulePreview.preview(req, body), req)
  }

  @Write({ action: 'ALERT_RULE_UPDATED', resourceType: 'AlertRule', permission: 'alerts.manage' })
  @Patch('rules/:id')
  async updateRule(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.rulesWrite.update(req, id, body), req)
  }

  @Get(':id')
  async show(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.detail(req, id), req)
  }

  @Write({ action: 'ALERT_ACKED', resourceType: 'AlertInstance', permission: 'alerts.handle' })
  @HttpCode(200)
  @Post(':id/ack')
  async ack(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.ack(req, id, body), req)
  }

  @Write({ action: 'ALERT_IGNORED', resourceType: 'AlertInstance', permission: 'alerts.handle' })
  @HttpCode(200)
  @Post(':id/ignore')
  async ignore(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.ignore(req, id, body), req)
  }

  @Write({ action: 'ALERT_ASSIGNED', resourceType: 'AlertInstance', permission: 'alerts.handle' })
  @HttpCode(200)
  @Post(':id/assign')
  async assign(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.assign(req, id, body), req)
  }

  @Write({ action: 'ALERT_CLOSED', resourceType: 'AlertInstance', permission: 'alerts.handle' })
  @HttpCode(200)
  @Post(':id/close')
  async close(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.close(req, id, body), req)
  }
}
