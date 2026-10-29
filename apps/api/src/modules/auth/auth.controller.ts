import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { MfaVerifyBodySchema, ProfileUpdateBodySchema, REFRESH_TOKEN_DAYS, StepUpBodySchema } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { CookieOptions, Response } from 'express'
import { appError, ok, RequestWithContext } from '../../platform/http'
import { MailService } from '../../platform/mail'
import { parsePageParams } from '../../platform/query'
import { RateLimitService } from '../../platform/rate-limit.service'
import { AuditWriter, StepUpService, Write, WriteExempt } from '../../platform/write'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'
import { parseLoginInput, readRefreshToken, REFRESH_COOKIE_NAME } from './auth.validation'
import { ContextService } from './context.service'
import { MfaService } from './mfa.service'
import { allowedOriginsFromEnv, isRefreshOriginAllowed } from './session-meta'

// 刷新凭据只放在服务端可读的 Cookie 里：脚本读不到（HttpOnly）、只走加密连接（生产 Secure）、严格同站（SameSite=Strict）、
// 且只在认证接口路径下发送。
const refreshCookie = (): CookieOptions => ({
  httpOnly: true,
  secure: process.env.APP_MODE === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
})

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly context: ContextService,
    private readonly rateLimit: RateLimitService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditWriter,
    private readonly mfa: MfaService,
    private readonly mail: MailService,
  ) {}

  // 个人身份才能做的操作（注销、会话、多因素、再次验证）：内部访问模式没有个人账号，一律拒绝
  private personal<T extends { accessMode?: string }>(context: T): T {
    if (context.accessMode === 'INTERNAL_DIRECT' || context.accessMode === 'SUPPORT') throw appError('INTERNAL_ACCESS_UNSUPPORTED', '内部访问与支持访问模式没有个人账号，不支持该操作')
    return context
  }

  @WriteExempt('登录：此时还没有登录态，按邮箱与来源地址限流、连续失败锁定；成功后单独写登录审计')
  @Post('login')
  async login(@Req() req: RequestWithContext, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const input = parseLoginInput(body)
    await this.rateLimit.check('login', `${req.ip}:${input.email.toLowerCase()}`, 10, 60)
    const result = await this.auth.login(input.email, input.password, input.tenantId, req.header('user-agent'), req.ip)
    response.cookie(REFRESH_COOKIE_NAME, result.refreshToken, { ...refreshCookie(), maxAge: REFRESH_TOKEN_DAYS * 86400000 })
    // 审计写入企业数据，需要先确定本次请求属于哪个企业
    await runWithTenant(result.tenant.id, () =>
      this.audit.recordQuietly(req, { action: 'LOGIN_SUCCEEDED', resourceType: 'Session', resourceId: result.user.id }, { tenantId: result.tenant.id, userId: result.user.id }),
    )
    // 新设备登录提醒（防滥用）：邮件通道未配置时如实记录“未发送”，企业管理员能在审计里看到
    if (result.newDevice) {
      const mail = await this.mail.send(result.user.email, { kind: 'new-device', displayName: result.user.displayName, device: result.device, ipMasked: result.ipMasked, signedInAt: new Date() })
      await runWithTenant(result.tenant.id, () =>
        this.audit.recordQuietly(
          req,
          { action: 'NEW_DEVICE_LOGIN', resourceType: 'Session', resourceId: result.user.id, detail: { device: result.device, ipMasked: result.ipMasked, notified: mail.delivered } },
          { tenantId: result.tenant.id, userId: result.user.id },
        ),
      )
    }
    // 刷新凭据只通过 Cookie 下发，不出现在响应体里；设备信息只用于上面的提醒
    const { refreshToken: _refreshToken, newDevice: _newDevice, device: _device, ipMasked: _ipMasked, ...publicResult } = result
    return ok(publicResult, req)
  }

  @WriteExempt('刷新：凭据是仅服务端可读的刷新令牌，没有访问令牌；按来源校验、轮换与重用检测保护（P1-17）')
  @Post('refresh')
  async refresh(@Req() req: RequestWithContext, @Res({ passthrough: true }) response: Response, @Headers('cookie') cookie?: string) {
    // 跨站请求伪造防护：只接受来自本站页面的刷新请求
    if (!isRefreshOriginAllowed({ origin: req.header('origin'), referer: req.header('referer'), host: req.header('host'), allowedOrigins: allowedOriginsFromEnv() })) {
      throw appError('ORIGIN_NOT_ALLOWED', '请求来源不在允许范围内')
    }
    const token = readRefreshToken(cookie)
    if (!token) throw appError('AUTH_REQUIRED', '登录已失效')
    try {
      const result = await this.auth.refresh(token, { userAgent: req.header('user-agent'), ip: req.ip }, alert => this.alertReuse(req, alert))
      response.cookie(REFRESH_COOKIE_NAME, result.refreshToken, { ...refreshCookie(), maxAge: REFRESH_TOKEN_DAYS * 86400000 })
      return ok({ accessToken: result.accessToken }, req)
    } catch (error) {
      // 凭据已无效（失效、被吊销、检测到重用）：清掉浏览器里的旧凭据。
      // 并发冲突要保留（客户端要用刚更新的新凭据重试），服务端临时故障也不能把用户登出。
      const code = (error as { code?: string }).code
      if (code === 'AUTH_REQUIRED' || code === 'SESSION_REUSE_DETECTED') response.clearCookie(REFRESH_COOKIE_NAME, refreshCookie())
      throw error
    }
  }

  // 检测到重用时：写审计（落到用户所属的每个企业，企业管理员可见）并输出告警日志（日志在服务里已写）
  private async alertReuse(req: RequestWithContext, alert: { userId: string; chainId: string }) {
    for (const tenantId of await this.auth.activeTenantIds(alert.userId)) {
      await runWithTenant(tenantId, () =>
        this.audit.recordQuietly(
          req,
          { action: 'SESSION_REUSE_DETECTED', resourceType: 'Session', resourceId: alert.chainId, result: 'DENIED', detail: { reason: '旧刷新凭据在宽限期之外被再次使用，整条会话已吊销' } },
          { tenantId, userId: alert.userId },
        ),
      )
    }
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'LOGOUT', resourceType: 'Session' })
  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: RequestWithContext, @Res({ passthrough: true }) response: Response) {
    const context = this.personal(await this.context.resolve(req))
    await this.auth.revokeChain(context.userId, context.sessionId)
    response.clearCookie(REFRESH_COOKIE_NAME, refreshCookie())
    await this.audit.record(req, { action: 'LOGOUT', resourceType: 'Session', resourceId: context.sessionId })
    return ok({ loggedOut: true }, req)
  }

  @UseGuards(AuthGuard)
  @Get('me')
  async me(@Req() req: RequestWithContext) {
    const context = await this.context.resolve(req)
    // 平台支持访问没有成员账号，也就没有多因素认证状态
    return ok({ ...(await this.auth.me(context)), ...(context.accessMode === 'SUPPORT' ? {} : { mfa: await this.mfa.status(context.userId) }) }, req)
  }

  // 个人资料（P5-11）：目前只有显示名；通知偏好在 PUT /me/preferences。权限先于参数校验（Write 拦截器预检）。
  @UseGuards(AuthGuard)
  @Write({ action: 'PROFILE_UPDATED', resourceType: 'User', permission: 'profile.manage' })
  @Patch('me')
  async updateMe(@Req() req: RequestWithContext, @Body() body: unknown) {
    const input = ProfileUpdateBodySchema.parse(body)
    const context = this.personal(await this.context.resolve(req))
    const result = await this.auth.updateDisplayName(context.userId, input.displayName)
    if (result.changed) {
      await this.audit.record(req, { action: 'PROFILE_UPDATED', resourceType: 'User', resourceId: context.userId, before: { displayName: result.before }, after: { displayName: input.displayName } })
    }
    return ok({ displayName: input.displayName, changed: result.changed }, req)
  }

  @UseGuards(AuthGuard)
  @Get('sessions')
  async sessions(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    const context = await this.context.resolve(req)
    const { page, pageSize, skip, take } = parsePageParams(query)
    const { items, total } = await this.auth.sessions(context.userId, context.sessionId, { skip, take })
    return ok({ items, total, page, pageSize }, req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'SESSION_REVOKED', resourceType: 'Session' })
  @Delete('sessions/:id')
  async revokeSession(@Req() req: RequestWithContext, @Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const context = this.personal(await this.context.resolve(req))
    // 只能注销自己的会话；不存在、已注销、或属于别人的一律返回“不存在”
    if (!(await this.auth.revokeChain(context.userId, id))) throw appError('RESOURCE_NOT_FOUND', '会话不存在或已注销')
    if (id === context.sessionId) response.clearCookie(REFRESH_COOKIE_NAME, refreshCookie())
    await this.audit.record(req, { action: 'SESSION_REVOKED', resourceType: 'Session', resourceId: id, detail: { current: id === context.sessionId } })
    return ok({ revoked: true, current: id === context.sessionId }, req)
  }

  // 获取多因素认证的绑定信息（密钥与扫码链接）：只在这次响应里出现，不进入幂等记录与审计
  @UseGuards(AuthGuard)
  @Write({ action: 'MFA_ENROLLMENT_STARTED', resourceType: 'MfaFactor', sensitiveResponse: true })
  @HttpCode(200)
  @Post('mfa/enroll')
  async mfaEnroll(@Req() req: RequestWithContext) {
    const context = this.personal(await this.context.resolve(req))
    const me = await this.auth.me(context)
    const result = await this.mfa.enroll(context.userId, me.user.email)
    await this.audit.record(req, { action: 'MFA_ENROLLMENT_STARTED', resourceType: 'MfaFactor', resourceId: context.userId })
    return ok(result, req)
  }

  // 提交验证码：首次通过即完成绑定并领取恢复码（只显示一次）
  @UseGuards(AuthGuard)
  @Write({ action: 'MFA_VERIFIED', resourceType: 'MfaFactor', sensitiveResponse: true })
  @HttpCode(200)
  @Post('mfa/verify')
  async mfaVerify(@Req() req: RequestWithContext, @Body() body: unknown) {
    const input = MfaVerifyBodySchema.parse(body)
    const context = this.personal(await this.context.resolve(req))
    const result = await this.mfa.verify(context.userId, input.code)
    await this.audit.record(req, { action: 'MFA_VERIFIED', resourceType: 'MfaFactor', resourceId: context.userId, detail: { method: result.method, issuedRecoveryCodes: 'recoveryCodes' in result } })
    return ok(result, req)
  }

  // 高风险操作的再次验证：通过后，所选操作在 10 分钟内可以执行
  @UseGuards(AuthGuard)
  @Write({ action: 'STEP_UP_VERIFIED', resourceType: 'StepUp' })
  @HttpCode(200)
  @Post('step-up')
  async stepUpVerify(@Req() req: RequestWithContext, @Body() body: unknown) {
    const input = StepUpBodySchema.parse(body)
    const context = this.personal(await this.context.resolve(req))
    const verification = await this.stepUp.verify(context, input)
    await this.audit.record(req, { action: 'STEP_UP_VERIFIED', resourceType: 'StepUp', resourceId: verification.id, detail: { action: verification.action, method: verification.method } })
    return ok({ action: verification.action, expiresAt: verification.expiresAt }, req)
  }
}
