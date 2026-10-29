import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write, WriteExempt } from '../../platform/write'
import { AuthGuard } from '../auth'
import { InvitationService } from './invitation.service'
import { OnboardingService } from './onboarding.service'
import { SupportGrantService } from './support-grant.service'

// 公开的邀请接口：不需要登录，令牌即凭据。
@Controller('auth/invitations')
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Get(':token')
  async preview(@Req() req: RequestWithContext, @Param('token') token: string) {
    return ok(await this.invitations.preview(req, token), req)
  }

  @WriteExempt('公开接口：邀请令牌即凭据（一次性、72 小时有效、按来源地址限流）；成功后写入企业审计')
  @HttpCode(201)
  @Post(':token/accept')
  async accept(@Req() req: RequestWithContext, @Param('token') token: string, @Body() body: unknown) {
    return ok(await this.invitations.accept(req, token, body), req)
  }
}

@UseGuards(AuthGuard)
@Controller()
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly support: SupportGrantService,
  ) {}

  @Get('onboarding')
  async state(@Req() req: RequestWithContext) {
    return ok(await this.onboarding.get(req), req)
  }

  // 响应里可能含一次性邀请链接，幂等记录不保存它
  @Write({ action: 'ONBOARDING_STEP_UPDATED', resourceType: 'TenantOnboarding', permission: 'settings.write', sensitiveResponse: true })
  @Patch('onboarding')
  async step(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.onboarding.patch(req, body), req)
  }

  @Get('settings/quotas')
  async quotas(@Req() req: RequestWithContext) {
    return ok(await this.support.quotas(req), req)
  }

  @Get('settings/support-access')
  async supportList(@Req() req: RequestWithContext) {
    return ok({ items: await this.support.list(req) }, req)
  }

  @Write({ action: 'SUPPORT_ACCESS_GRANTED', resourceType: 'PlatformSupportAccess', permission: 'settings.write', stepUp: 'support.access' })
  @Post('settings/support-access')
  async supportGrant(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.support.grant(req, body), req))
  }

  @Write({ action: 'SUPPORT_ACCESS_REVOKED', resourceType: 'PlatformSupportAccess', permission: 'settings.write' })
  @Delete('settings/support-access/:id')
  async supportRevoke(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.support.revoke(req, id), req)
  }
}
