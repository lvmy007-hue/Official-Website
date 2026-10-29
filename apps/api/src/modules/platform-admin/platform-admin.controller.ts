import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { PlatformLoginBodySchema, PlatformMfaBodySchema } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { WriteExempt } from '../../platform/write'
import { PlatformAuthService } from './platform-auth.service'
import { PlatformLifecycleService } from './platform-lifecycle.service'
import { PlatformGuard, PlatformRequest, RequirePlatform } from './platform.guard'
import { PlatformSupportService } from './platform-support.service'
import { PlatformTenantsService } from './platform-tenants.service'

const EXEMPT_SESSION = '平台账号登录流程：此时还没有平台令牌，按邮箱限流、连续失败锁定；动态验证码强制，同一时间步只能用一次'
const EXEMPT_PLATFORM = '平台账号接口：由平台守卫鉴权（独立令牌与权限点），不经过企业幂等与通用审计；每次变更在服务内写入该企业的审计与生命周期事件'

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @WriteExempt(EXEMPT_SESSION)
  @HttpCode(200)
  @Post('login')
  async login(@Req() req: RequestWithContext, @Body() body: unknown) {
    const input = PlatformLoginBodySchema.parse(body)
    return ok(await this.auth.login(input.email, input.password), req)
  }

  @WriteExempt(EXEMPT_SESSION)
  @HttpCode(200)
  @Post('mfa/verify')
  async verify(@Req() req: RequestWithContext, @Body() body: unknown) {
    const input = PlatformMfaBodySchema.parse(body)
    return ok(await this.auth.verifyMfa(input.challengeToken, input.code), req)
  }

  @UseGuards(PlatformGuard)
  @Get('me')
  async me(@Req() req: PlatformRequest) {
    return ok(this.auth.present(req.platformAdmin!), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @UseGuards(PlatformGuard)
  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: PlatformRequest) {
    await this.auth.logout(req.platformAdmin!.id)
    return ok({ signedOut: true }, req)
  }
}

@UseGuards(PlatformGuard)
@Controller('platform')
export class PlatformTenantsController {
  constructor(
    private readonly tenants: PlatformTenantsService,
    private readonly lifecycle: PlatformLifecycleService,
    private readonly support: PlatformSupportService,
  ) {}

  @RequirePlatform('platform.tenant.read')
  @Get('tenants')
  async list(@Req() req: RequestWithContext, @Query() query: unknown) {
    return ok(await this.tenants.list(query), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.tenant.manage')
  @Post('tenants')
  async create(@Req() req: PlatformRequest, @Body() body: unknown) {
    return ok(await this.tenants.create(req, req.platformAdmin!, body), req)
  }

  @RequirePlatform('platform.tenant.read')
  @Get('tenants/:id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.tenants.detail(id), req)
  }

  @RequirePlatform('platform.tenant.read')
  @Get('tenants/:id/usage')
  async usage(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.tenants.usage(id), req)
  }

  @RequirePlatform('platform.tenant.manage')
  @Get('tenants/:id/close-export')
  async closeExport(@Req() req: PlatformRequest, @Param('id') id: string) {
    return ok(await this.lifecycle.closeExport(req, req.platformAdmin!, id), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.tenant.manage')
  @Post('tenants/:id/invite')
  async invite(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.lifecycle.reinvite(req, req.platformAdmin!, id, body), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.tenant.manage')
  @HttpCode(200)
  @Post('tenants/:id/suspend')
  async suspend(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.lifecycle.suspend(req, req.platformAdmin!, id, body), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.tenant.manage')
  @HttpCode(200)
  @Post('tenants/:id/resume')
  async resume(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.lifecycle.resume(req, req.platformAdmin!, id, body), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.tenant.manage')
  @HttpCode(200)
  @Post('tenants/:id/deactivate')
  async deactivate(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.lifecycle.deactivate(req, req.platformAdmin!, id, body), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.tenant.manage')
  @HttpCode(202)
  @Post('tenants/:id/close')
  async close(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.lifecycle.close(req, req.platformAdmin!, id, body), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.quota.manage')
  @Put('tenants/:id/quota')
  async quota(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.tenants.updateQuotas(req, req.platformAdmin!, id, body), req)
  }

  @RequirePlatform('platform.support.access')
  @Get('support-access')
  async supportList(@Req() req: PlatformRequest) {
    return ok(await this.support.list(req.platformAdmin!), req)
  }

  @WriteExempt(EXEMPT_PLATFORM)
  @RequirePlatform('platform.support.access')
  @HttpCode(200)
  @Post('support-access')
  async supportClaim(@Req() req: PlatformRequest, @Body() body: unknown) {
    return ok(await this.support.claim(req, req.platformAdmin!, body), req)
  }
}
