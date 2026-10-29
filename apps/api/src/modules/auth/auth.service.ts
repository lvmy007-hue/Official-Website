import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ACCESS_TOKEN_MINUTES, READABLE_STATUSES, REFRESH_REUSE_GRACE_SECONDS, REFRESH_TOKEN_DAYS, SESSION_IDLE_MINUTES, type TenantLifecycleStatus } from '@nova/api-contracts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appError, ApiContext, AppError } from '../../platform/http'
import { logger } from '../../platform/observability'
import { SystemPrismaService } from '../../platform/prisma.service'
import { RateLimitService } from '../../platform/rate-limit.service'
import { verifyPassword } from './password-check'
import { permissionsOfRole, roleInclude } from './role-permissions'
import { describeDevice, deviceFingerprint, maskIp } from './session-meta'

const hashToken = (value: string) => createHash('sha256').update(value).digest('hex')
const LOGIN_LOCK_SECONDS = 30 * 60
const IDLE_MS = SESSION_IDLE_MINUTES * 60 * 1000
const ACCESS_TOKEN_TTL = `${ACCESS_TOKEN_MINUTES}m`

export interface ClientMeta {
  userAgent?: string
  ip?: string
}

/** 刷新凭据重用检测的结果：用于控制器写审计与告警。 */
export interface ReuseAlert {
  userId: string
  chainId: string
}

// 登录与会话（P1-17）。
// 一次登录是一条“会话链”：访问令牌里的 sessionId 就是链编号（rotationChainId），每次刷新签发一个新的会话行并作废旧行，
// 访问令牌因此在轮换后仍然有效，不会因为另一个标签页刚刷新过而被误伤。
// 旧的刷新凭据再次出现：宽限期内按并发处理（返回 REFRESH_CONFLICT，让客户端带新凭据重试）；宽限期之外视为凭据被截取，吊销整条链并告警。
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly jwt: JwtService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * 找到成员可用的企业：只在可登录的状态（试用、正常、暂停）里选；暂停的企业可以登录，但只读。
   * 成员的企业全部已停用或已注销时，明确提示 TENANT_INACTIVE，而不是笼统的“无权访问”。
   */
  private async findUsableMembership<T extends object>(userId: string, tenantId: string | undefined, include: T) {
    const base = { userId, status: 'ACTIVE', ...(tenantId ? { tenantId } : {}) }
    const found = await this.prisma.membership.findFirst({ where: { ...base, tenant: { lifecycleStatus: { in: [...READABLE_STATUSES] } } }, include })
    if (found) return found as typeof found & { tenant: { lifecycleStatus: string } }
    const inactive = await this.prisma.membership.findFirst({ where: base, select: { id: true } })
    if (inactive) throw new AppError(403, 'TENANT_INACTIVE', '企业已停用或已注销，不能访问，请联系平台运营')
    throw new AppError(403, 'TENANT_ACCESS_DENIED', tenantId ? '当前账号无权访问该企业' : '当前账号没有可用的企业访问范围')
  }

  private signAccessToken(userId: string, chainId: string) {
    return this.jwt.signAsync({ userId, sessionId: chainId }, { expiresIn: ACCESS_TOKEN_TTL })
  }

  async login(email: string, password: string, tenantId?: string, userAgent?: string, ip?: string) {
    const emailKey = email.toLowerCase()
    await this.rateLimit.assertUnlocked('login', emailKey)
    const user = await this.prisma.user.findUnique({ where: { email: emailKey } })
    // 账号不存在或已停用时也做一次同样代价的哈希比较，响应耗时不泄露“邮箱是否存在”（P5-13）
    const passwordOk = await verifyPassword(password, user?.status === 'ACTIVE' ? user.passwordHash : null)
    if (!user || !passwordOk) {
      await this.rateLimit.recordFailure('login', emailKey, 10, LOGIN_LOCK_SECONDS)
      throw new AppError(401, 'AUTH_REQUIRED', '企业邮箱或密码不正确')
    }
    await this.rateLimit.clearFailures('login', emailKey)

    const membership = await this.findUsableMembership(user.id, tenantId, { tenant: true, ...roleInclude })

    // 新设备登录：该账号以前登录过，但这个设备指纹从未出现过（首次登录不算）
    const fingerprint = deviceFingerprint(userAgent)
    const [everSignedIn, knownDevice] = await Promise.all([
      this.prisma.session.count({ where: { userId: user.id } }),
      fingerprint ? this.prisma.session.count({ where: { userId: user.id, deviceFingerprint: fingerprint } }) : Promise.resolve(1),
    ])
    const newDevice = everSignedIn > 0 && knownDevice === 0

    const refreshToken = randomBytes(48).toString('base64url')
    const id = randomUUID()
    await this.prisma.session.create({
      data: {
        id,
        rotationChainId: id,
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        userAgent,
        ipHash: ip ? hashToken(ip) : undefined,
        ipMasked: maskIp(ip),
        deviceFingerprint: deviceFingerprint(userAgent),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000),
      },
    })
    const accessToken = await this.signAccessToken(user.id, id)
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      tenant: { id: membership.tenant.id, name: membership.tenant.name, slug: membership.tenant.slug },
      requestScope: { permissions: permissionsOfRole(membership.role) },
      newDevice,
      device: describeDevice(userAgent),
      ipMasked: maskIp(ip),
    }
  }

  private async touchSession(session: { id: string; lastSeenAt: Date }) {
    if (Date.now() - session.lastSeenAt.getTime() > IDLE_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      throw new AppError(401, 'AUTH_REQUIRED', `登录已超过 ${SESSION_IDLE_MINUTES} 分钟无操作，请重新登录`)
    }
    await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
  }

  /**
   * 用刷新凭据换新的访问令牌，同时轮换刷新凭据：旧凭据立刻作废，返回新的刷新凭据（由控制器写入 Cookie）。
   * onReuse：检测到凭据被重用并已吊销整条会话链时回调，用于写审计与告警。
   */
  async refresh(token: string, meta: ClientMeta = {}, onReuse?: (alert: ReuseAlert) => Promise<void>) {
    const session = await this.prisma.session.findFirst({ where: { refreshTokenHash: hashToken(token) } })
    if (!session || session.expiresAt <= new Date()) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录')

    const successor = await this.prisma.session.findFirst({ where: { rotatedFromId: session.id }, orderBy: { createdAt: 'asc' } })
    if (successor || session.reuseDetectedAt) return this.rejectReusedToken(session, successor, onReuse)
    // 已注销、或被空闲超时作废的凭据：普通的“登录已失效”，不是盗用
    if (session.revokedAt) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录')
    await this.touchSession(session)

    const nextToken = randomBytes(48).toString('base64url')
    const nextId = randomUUID()
    const rotated = await this.prisma.$transaction(async tx => {
      // 抢占式作废旧凭据：并发的两个刷新请求只有一个能成功
      const claimed = await tx.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } })
      if (claimed.count !== 1) return null
      return tx.session.create({
        data: {
          id: nextId,
          rotationChainId: session.rotationChainId,
          rotatedFromId: session.id,
          userId: session.userId,
          refreshTokenHash: hashToken(nextToken),
          userAgent: meta.userAgent ?? session.userAgent,
          ipHash: meta.ip ? hashToken(meta.ip) : session.ipHash,
          ipMasked: meta.ip ? maskIp(meta.ip) : session.ipMasked,
          deviceFingerprint: deviceFingerprint(meta.userAgent) ?? session.deviceFingerprint,
          // 绝对有效期不顺延：自首次登录起最多 30 天，到期必须重新登录
          expiresAt: session.expiresAt,
        },
      })
    })
    if (!rotated) {
      // 另一个请求刚刚抢先完成了轮换：当作并发处理，让客户端带上新凭据重试
      throw appError('REFRESH_CONFLICT', '登录凭据刚刚已被更新，请重试')
    }
    return { accessToken: await this.signAccessToken(session.userId, session.rotationChainId), refreshToken: nextToken }
  }

  private async rejectReusedToken(
    session: { id: string; userId: string; rotationChainId: string; revokedAt: Date | null; reuseDetectedAt: Date | null },
    successor: { createdAt: Date } | null,
    onReuse?: (alert: ReuseAlert) => Promise<void>,
  ): Promise<never> {
    const rotatedAt = successor?.createdAt ?? session.revokedAt
    if (!session.reuseDetectedAt && rotatedAt && Date.now() - rotatedAt.getTime() <= REFRESH_REUSE_GRACE_SECONDS * 1000) {
      throw appError('REFRESH_CONFLICT', '登录凭据刚刚已被另一个请求更新，请携带新的凭据重试')
    }
    const alreadyFlagged = await this.prisma.session.count({ where: { rotationChainId: session.rotationChainId, reuseDetectedAt: { not: null } } })
    const now = new Date()
    await this.prisma.session.updateMany({ where: { rotationChainId: session.rotationChainId, revokedAt: null }, data: { revokedAt: now } })
    if (alreadyFlagged === 0) {
      await this.prisma.session.update({ where: { id: session.id }, data: { reuseDetectedAt: now } })
      logger.error({ event: 'refresh_token_reuse', userId: session.userId, chainId: session.rotationChainId }, '检测到刷新凭据被重复使用，已吊销整条会话链')
      await onReuse?.({ userId: session.userId, chainId: session.rotationChainId })
    }
    throw appError('SESSION_REUSE_DETECTED', '检测到登录凭据被重复使用，为了账号安全已退出所有相关登录，请重新登录')
  }

  /** 注销一条会话链（含当前设备自己的退出登录）。返回是否真的注销了一条有效会话。 */
  async revokeChain(userId: string, chainId: string): Promise<boolean> {
    const result = await this.prisma.session.updateMany({ where: { userId, rotationChainId: chainId, revokedAt: null }, data: { revokedAt: new Date() } })
    return result.count > 0
  }

  /** 当前用户的有效会话列表（每个登录一行），当前设备标记 current。 */
  async sessions(userId: string, currentChainId: string, page: { skip: number; take: number }) {
    const where = { userId, revokedAt: null, expiresAt: { gt: new Date() } }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.session.findMany({ where, orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }], skip: page.skip, take: page.take }),
      this.prisma.session.count({ where }),
    ])
    // 首次登录时间取自链的起点（链编号就是起点会话的编号）
    const roots = await this.prisma.session.findMany({ where: { id: { in: rows.map(row => row.rotationChainId) } }, select: { id: true, createdAt: true } })
    const signedInAt = new Map(roots.map(root => [root.id, root.createdAt]))
    const items = rows.map(row => ({
      id: row.rotationChainId,
      device: describeDevice(row.userAgent),
      ipMasked: row.ipMasked,
      signedInAt: signedInAt.get(row.rotationChainId) ?? row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      current: row.rotationChainId === currentChainId,
    }))
    return { items, total }
  }

  /** 修改个人显示名（P5-11）。用户表对业务连接只读，所以放在认证模块里用系统连接写；没有变化时不写。 */
  async updateDisplayName(userId: string, displayName: string): Promise<{ before: string; changed: boolean }> {
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } })
    if (current.displayName === displayName) return { before: current.displayName, changed: false }
    await this.prisma.user.update({ where: { id: userId }, data: { displayName } })
    return { before: current.displayName, changed: true }
  }

  async me(context: ApiContext) {
    // 平台支持访问没有成员账号：以固定的显示名返回，不暴露平台人员的邮箱
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { id: true, name: true, slug: true, mode: true, timezone: true, localTimezone: true, defaultCurrency: true, lifecycleStatus: true },
    })
    const user =
      context.accessMode === 'SUPPORT'
        ? { id: context.userId, email: '', displayName: '平台支持人员（只读）' }
        : await this.prisma.user.findUniqueOrThrow({ where: { id: context.userId }, select: { id: true, email: true, displayName: true } })
    // 初始化向导是否已完成（P1-19）：没有向导记录的企业视为已完成；外壳据此显示“未完成企业初始化”提示
    const onboarding = await this.prisma.tenantOnboarding.findUnique({ where: { tenantId: context.tenantId }, select: { completedAt: true } })
    return {
      user,
      tenant: { ...tenant, onboardingCompleted: !onboarding || Boolean(onboarding.completedAt) },
      activeTenantId: context.tenantId,
      permissions: context.permissions,
      accessMode: context.accessMode ?? 'NORMAL',
    }
  }

  async context(userId: string, chainId: string, requestedTenantId?: string): Promise<ApiContext> {
    // 访问令牌里的 sessionId 是链编号：取这条链当前有效的那一行
    const session = await this.prisma.session.findFirst({
      where: { rotationChainId: chainId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    })
    if (!session) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录')
    await this.touchSession(session)
    const membership = await this.findUsableMembership(userId, requestedTenantId, { tenant: { select: { lifecycleStatus: true } }, ...roleInclude })
    return {
      userId,
      sessionId: chainId,
      tenantId: membership.tenantId,
      membershipId: membership.id,
      permissions: permissionsOfRole(membership.role),
      lifecycleStatus: membership.tenant.lifecycleStatus as TenantLifecycleStatus,
    }
  }

  /** 用户的有效企业成员关系：用于在重用告警里把审计写到用户所属的每个企业。 */
  async activeTenantIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.membership.findMany({ where: { userId, status: 'ACTIVE' }, select: { tenantId: true } })
    return rows.map(row => row.tenantId)
  }
}
