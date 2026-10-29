import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { SettingsService } from './settings.service'

@UseGuards(AuthGuard)
@Controller('settings/preferences')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async list(@Req() req: RequestWithContext) {
    return ok(await this.settings.list(req), req)
  }

  @Write({ action: 'TENANT_SETTING_UPDATED', resourceType: 'TenantSetting', permission: 'settings.write' })
  @Put(':key')
  async update(@Req() req: RequestWithContext, @Param('key') key: string, @Body() body: unknown) {
    return ok(await this.settings.update(req, key, body), req)
  }
}
