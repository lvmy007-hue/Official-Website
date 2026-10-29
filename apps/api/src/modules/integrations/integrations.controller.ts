import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { IntegrationsService } from './integrations.service'
import { SwitchActionsService } from './switch-actions.service'

@UseGuards(AuthGuard)
@Controller('settings/integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly actions: SwitchActionsService,
  ) {}

  @Get()
  async overview(@Req() req: RequestWithContext) {
    return ok(await this.integrations.overview(req), req)
  }

  // 顶栏写入状态：登录成员即可查看（只含模式与数量）
  @Get('summary')
  async summary(@Req() req: RequestWithContext) {
    return ok(await this.integrations.summary(req), req)
  }

  @Write({ action: 'WRITE_SWITCH_BATCH_DISABLED', resourceType: 'IntegrationSwitch', permission: 'settings.integration.write' })
  @Patch()
  async batch(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.actions.batchDisable(req, body), req)
  }

  @Write({ action: 'WRITE_SWITCH_READONLY_ALL', resourceType: 'IntegrationSwitch', permission: 'settings.integration.write' })
  @HttpCode(200)
  @Post('readonly-all')
  async readonlyAll(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.actions.readonlyAll(req, body), req)
  }

  @Write({ action: 'WRITE_SWITCH_ENABLED', resourceType: 'IntegrationSwitch', permission: 'settings.integration.write', stepUp: 'switch.enable' })
  @HttpCode(200)
  @Post(':key/enable')
  async enable(@Req() req: RequestWithContext, @Param('key') key: string, @Body() body: unknown) {
    return ok(await this.actions.enable(req, key, body), req)
  }

  @Write({ action: 'WRITE_SWITCH_DISABLED', resourceType: 'IntegrationSwitch', permission: 'settings.integration.write' })
  @HttpCode(200)
  @Post(':key/disable')
  async disable(@Req() req: RequestWithContext, @Param('key') key: string, @Body() body: unknown) {
    return ok(await this.actions.disable(req, key, body), req)
  }
}
