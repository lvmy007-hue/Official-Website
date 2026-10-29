import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { AppError, RequestWithContext } from '../../platform/http'
import { logger } from '../../platform/observability'
import { platformJwtSecret, SUPPORT_USER_PREFIX, type SupportTokenPayload } from './platform-token'
import { checkInternalSource, INTERNAL_ACCESS_SESSION_ID, readInternalAccessConfig } from './internal-access'

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithContext>()
    const header = request.header('authorization')
    if (!header?.startsWith('Bearer ')) {
      if (process.env.APP_MODE === 'development' && process.env.LOCAL_NO_AUTH === 'true') {
        request.user = { userId: process.env.LOCAL_DEV_USER_ID ?? 'local-dev-user', sessionId: 'local-dev-session' }
        return true
      }
      if (this.admitInternal(request)) return true
      throw new AppError(401, 'AUTH_REQUIRED', '需要登录')
    }
    const token = header.slice(7)
    try {
      const payload = await this.jwt.verifyAsync<{ userId: string; sessionId: string }>(token)
      request.user = { userId: payload.userId, sessionId: payload.sessionId }
      return true
    } catch {
      // 不是成员的访问令牌：再看是不是平台支持访问令牌（用另一把密钥签发，且只读，见 ContextService）
      if (await this.admitSupport(request, token)) return true
      throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录')
    }
  }

  // 平台支持访问（P1-19）：令牌绑定一条企业授权记录；授权是否仍有效、是否只读，由 ContextService 逐请求校验并审计
  private async admitSupport(request: RequestWithContext, token: string): Promise<boolean> {
    try {
      const payload = await this.jwt.verifyAsync<SupportTokenPayload>(token, { secret: platformJwtSecret() })
      if (payload.typ !== 'support' || !payload.adminId || !payload.accessId || !payload.tenantId) return false
      request.user = { userId: `${SUPPORT_USER_PREFIX}${payload.adminId}`, sessionId: payload.accessId }
      request.accessMode = 'SUPPORT'
      request.support = { adminId: payload.adminId, accessId: payload.accessId, tenantId: payload.tenantId }
      return true
    } catch {
      return false
    }
  }

  // 内部访问模式（P1-18）：只处理没有登录凭证的请求；来源校验不通过时与普通未登录完全一致（401），不暴露该模式是否开启。
  // 带了访问令牌的请求始终走普通登录，不会因为来源在内网就被降级。
  private admitInternal(request: RequestWithContext): boolean {
    const config = readInternalAccessConfig()
    if (!config.enabled) return false
    const check = checkInternalSource(config, {
      ip: request.ip,
      header: name => {
        const value = request.headers[name.toLowerCase()]
        return Array.isArray(value) ? value[0] : value
      },
      proxyTrusted: Boolean(request.app.get('trust proxy')),
    })
    if (!check.ok) {
      logger.warn({ event: 'internal_access_denied', ip: request.ip, reason: check.reason, requestId: request.requestId }, '内部访问被拒绝')
      return false
    }
    request.user = { userId: INTERNAL_ACCESS_SESSION_ID, sessionId: INTERNAL_ACCESS_SESSION_ID }
    request.accessMode = 'INTERNAL_DIRECT'
    return true
  }
}
