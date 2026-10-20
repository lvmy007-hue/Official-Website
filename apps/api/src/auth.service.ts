import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { compare } from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { PrismaService } from './prisma.service'
import { RateLimitService } from './rate-limit.service'
import { ApiContext, AppError } from './http'
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex')
const LOGIN_LOCK_SECONDS = 30 * 60
const IDLE_MS = 15 * 60 * 1000
@Injectable()
export class AuthService { constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly config: ConfigService, private readonly rateLimit: RateLimitService) {}
  async login(email: string, password: string, tenantId?: string, userAgent?: string, ip?: string) {
    const emailKey = email.toLowerCase()
    await this.rateLimit.assertUnlocked('login', emailKey)
    const user = await this.prisma.user.findUnique({ where: { email: emailKey } })
    const passwordOk = Boolean(user && user.status === 'ACTIVE' && await compare(password, user.passwordHash))
    if (!user || !passwordOk) {
      await this.rateLimit.recordFailure('login', emailKey, 10, LOGIN_LOCK_SECONDS)
      throw new AppError(401, 'AUTH_REQUIRED', '企业邮箱或密码不正确')
    }
    await this.rateLimit.clearFailures('login', emailKey)
    const membership = await this.prisma.membership.findFirst({ where: { userId: user.id, status: 'ACTIVE', ...(tenantId ? { tenantId } : {}) }, include: { tenant: true, role: true } }); if (!membership) throw new AppError(403, 'TENANT_ACCESS_DENIED', '当前账号没有可用的企业访问范围'); const refreshToken = randomBytes(48).toString('base64url'); const session = await this.prisma.session.create({ data: { userId: user.id, refreshTokenHash: hashToken(refreshToken), userAgent, ipHash: ip ? hashToken(ip) : undefined, expiresAt: new Date(Date.now() + 30 * 86400000) } }); const accessToken = await this.jwt.signAsync({ userId: user.id, sessionId: session.id }, { expiresIn: '15m' }); return { accessToken, refreshToken, user: { id: user.id, email: user.email, displayName: user.displayName }, tenant: { id: membership.tenant.id, name: membership.tenant.name, slug: membership.tenant.slug }, requestScope: { permissions: Array.isArray(membership.role.permissions) ? membership.role.permissions : [] } }
  }
  private async touchSession(session: { id: string; lastSeenAt: Date }) {
    if (Date.now() - session.lastSeenAt.getTime() > IDLE_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      throw new AppError(401, 'AUTH_REQUIRED', '登录已超过 15 分钟无操作，请重新登录')
    }
    await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
  }
  async refresh(token: string) { const session = await this.prisma.session.findFirst({ where: { refreshTokenHash: hashToken(token), revokedAt: null, expiresAt: { gt: new Date() } } }); if (!session) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录'); await this.touchSession(session); return { accessToken: await this.jwt.signAsync({ userId: session.userId, sessionId: session.id }, { expiresIn: '15m' }) } }
  async context(userId: string, sessionId: string, requestedTenantId?: string): Promise<ApiContext> { const session = await this.prisma.session.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } } }); if (!session) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录'); await this.touchSession(session); const membership = await this.prisma.membership.findFirst({ where: { userId, status: 'ACTIVE', ...(requestedTenantId ? { tenantId: requestedTenantId } : {}) }, include: { role: true } }); if (!membership) throw new AppError(403, 'TENANT_ACCESS_DENIED', '当前账号无权访问该企业'); return { userId, sessionId, tenantId: membership.tenantId, permissions: Array.isArray(membership.role.permissions) ? membership.role.permissions.map(String) : [] } }
}
