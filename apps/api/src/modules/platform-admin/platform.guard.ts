import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { hasPlatformPermission, type PlatformPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { platformJwtSecret, type PlatformTokenPayload } from '../auth'
import type { PlatformActor } from './platform-audit.service'

const PERMISSION_KEY = 'nova:platform-permission'

/** 声明平台接口需要的平台权限点；不声明则任何已登录的平台账号都可访问（如查看自己）。 */
export const RequirePlatform = (permission: PlatformPermission) => SetMetadata(PERMISSION_KEY, permission)

export type PlatformRequest = RequestWithContext & { platformAdmin?: PlatformActor }

/**
 * 平台账号守卫（P1-19）：只接受平台令牌（与成员令牌用不同密钥签名）；
 * 每个请求都核对账号仍然有效、令牌签发时间晚于“全部失效时间”（注销或停用账号时更新），再核对权限点。
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: SystemPrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<PlatformRequest>()
    const header = request.header('authorization')
    if (!header?.startsWith('Bearer ')) throw appError('PLATFORM_AUTH_REQUIRED', '需要平台账号登录')
    let payload: PlatformTokenPayload & { iat?: number }
    try {
      payload = await this.jwt.verifyAsync(header.slice(7), { secret: platformJwtSecret() })
    } catch {
      throw appError('PLATFORM_AUTH_REQUIRED', '平台登录已失效，请重新登录')
    }
    if (payload.typ !== 'platform' || !payload.adminId) throw appError('PLATFORM_AUTH_REQUIRED', '平台登录已失效，请重新登录')
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: payload.adminId } })
    // 令牌的签发时间只精确到秒：与“全部失效时间”比较时也取整到秒，避免注销后立刻重新登录的新令牌被误判失效
    const issuedAtMs = (payload.iat ?? 0) * 1000
    if (!admin || admin.status !== 'ACTIVE' || (admin.tokenValidAfter && issuedAtMs < Math.floor(admin.tokenValidAfter.getTime() / 1000) * 1000)) {
      throw appError('PLATFORM_AUTH_REQUIRED', '平台登录已失效，请重新登录')
    }
    const required = this.reflector.get<PlatformPermission | undefined>(PERMISSION_KEY, context.getHandler())
    if (required && !hasPlatformPermission(admin.role, required)) throw appError('PLATFORM_PERMISSION_DENIED', '当前平台账号没有执行此操作的权限')
    request.platformAdmin = { id: admin.id, email: admin.email, name: admin.name, role: admin.role }
    return true
  }
}
