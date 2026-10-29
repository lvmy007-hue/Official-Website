import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { PreferencesService } from './preferences.service'

// 个人偏好（P5-11）：通知偏好与个人免打扰。个人资料（显示名）在认证模块的 PATCH /auth/me（需要写用户表，只有认证模块有这个连接）。
@UseGuards(AuthGuard)
@Controller('me')
export class ProfileController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get('preferences')
  async get(@Req() req: RequestWithContext) {
    return ok(await this.preferences.get(req), req)
  }

  @Write({ action: 'USER_PREFERENCES_UPDATED', resourceType: 'UserPreference', permission: 'profile.manage' })
  @Put('preferences')
  async update(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.preferences.update(req, body), req)
  }
}
