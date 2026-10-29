import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ADS_ACCOUNT_BIND, CONNECTION_ACTIONS, CONNECTION_DISCONNECT_STEP_UP, CONNECTION_MANAGE } from '@nova/api-contracts'
import type { Response } from 'express'
import { AppError, ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AdsBindingService } from './ads-binding.service'
import { AdsOAuthService } from './ads-oauth.service'
import { ConnectionActionsService } from './connection-actions.service'
import { ConnectionCenterService } from './connection-center.service'
import { SpOAuthService } from './sp-oauth.service'

type Provider = 'sp-api' | 'ads'

// 授权回调统一跳回前端：成功带 status=connected，失败带 status=error 与错误码。
async function redirectAfterCallback(response: Response, target: string, provider: Provider, fallbackCode: string, run: () => Promise<unknown>) {
  const join = target.includes('?') ? '&' : '?'
  try {
    await run()
    return response.redirect(302, `${target}${join}provider=${provider}&status=connected`)
  } catch (error) {
    const code = error instanceof AppError ? error.code : fallbackCode
    return response.redirect(302, `${target}${join}provider=${provider}&status=error&code=${encodeURIComponent(code)}`)
  }
}

@Controller()
export class ConnectionsController {
  constructor(
    private readonly center: ConnectionCenterService,
    private readonly actions: ConnectionActionsService,
    private readonly spOAuth: SpOAuthService,
    private readonly adsOAuth: AdsOAuthService,
    private readonly adsBinding: AdsBindingService,
  ) {}

  // 连接中心（P5-04）：四类连接、授权范围、健康、失败码、令牌更新时间与角色对照
  @UseGuards(AuthGuard)
  @Get('connections')
  async list(@Req() req: RequestWithContext) {
    return ok(await this.center.overview(req), req)
  }

  // 广告账户与店铺绑定（P3-03）：静态路径放在 connections/:id 之前
  @UseGuards(AuthGuard)
  @Get('connections/ads-accounts')
  async adsAccounts(@Req() req: RequestWithContext) {
    return ok(await this.adsBinding.list(req), req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'ADS_ACCOUNT_BOUND', resourceType: 'AdsProfile', permission: ADS_ACCOUNT_BIND })
  @Post('connections/ads-accounts/:id/bind')
  async bindAdsAccount(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.adsBinding.bind(req, id, body), req)
  }

  // 连接动作（P5-04）：每个都写审计；断开要再次验证身份并写原因
  @UseGuards(AuthGuard)
  @Write({ action: CONNECTION_ACTIONS.healthCheckRequested, resourceType: 'PlatformConnection', permission: CONNECTION_MANAGE })
  @Post('connections/:id/health-check')
  async healthCheck(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.actions.requestHealthCheck(req, id), req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: CONNECTION_ACTIONS.reauthorizeStarted, resourceType: 'PlatformConnection', permission: CONNECTION_MANAGE })
  @Post('connections/:id/reauthorize')
  async reauthorize(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.actions.reauthorize(req, id), req, 'external')
  }

  @UseGuards(AuthGuard)
  @Write({ action: CONNECTION_ACTIONS.disconnected, resourceType: 'PlatformConnection', permission: CONNECTION_MANAGE, stepUp: CONNECTION_DISCONNECT_STEP_UP })
  @Post('connections/:id/disconnect')
  async disconnect(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.disconnect(req, id, body), req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'SP_API_OAUTH_STARTED', resourceType: 'PlatformConnection', permission: 'connection.manage' })
  @Post('sp-api/oauth/start')
  async startSpOAuth(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.spOAuth.start(req, body), req, 'external')
  }

  @Get('sp-api/oauth/callback')
  async spCallback(@Query() query: Record<string, string>, @Res() response: Response) {
    const target = process.env.AMAZON_SP_SUCCESS_REDIRECT ?? '/app/connections'
    return redirectAfterCallback(response, target, 'sp-api', 'SP_API_OAUTH_FAILED', () => this.spOAuth.complete(query))
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'ADS_OAUTH_STARTED', resourceType: 'PlatformConnection', permission: 'connection.manage' })
  @Post('ads/oauth/start')
  async startAdsOAuth(@Req() req: RequestWithContext) {
    return ok(await this.adsOAuth.start(req), req, 'external')
  }

  @Get('ads/oauth/callback')
  async adsCallback(@Query() query: Record<string, string>, @Res() response: Response) {
    const target = process.env.AMAZON_ADS_SUCCESS_REDIRECT ?? '/app/connections'
    return redirectAfterCallback(response, target, 'ads', 'ADS_OAUTH_FAILED', () => this.adsOAuth.complete(query))
  }
}
