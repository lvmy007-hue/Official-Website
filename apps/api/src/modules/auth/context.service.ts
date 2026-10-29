import { Injectable } from '@nestjs/common'
import { READABLE_STATUSES, permissionDeniedMessage, type TenantLifecycleStatus } from '@nova/api-contracts'
import { hasPermission, PERMISSION_CATALOG } from '@nova/authz'
import { bindTenantContext } from '@nova/tenancy'
import { bindTenant } from '../../platform/observability'
import { SystemPrismaService } from '../../platform/prisma.service'
import { ApiContext, appError, AppError, RequestWithContext } from '../../platform/http'
import { AuthService } from './auth.service'
import { INTERNAL_ACCESS_SESSION_ID, readInternalAccessConfig } from './internal-access'
import { InternalAccessService } from './internal-access.service'
import { MfaService } from './mfa.service'
import { SUPPORT_USER_PREFIX } from './platform-token'
import { permissionsOfRole, roleInclude } from './role-permissions'
import { ResolvedScope } from './scope'
import { ScopeService } from './scope.service'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** 支持访问只授予“查看”类权限点（不含任何字段权限：看不到成本、利润、买家信息） */
const SUPPORT_PERMISSIONS = PERMISSION_CATALOG.filter(entry => entry.kind === '查看').map(entry => entry.key)

// 请求上下文：从登录态解析租户与权限，并提供权限校验。所有领域模块通过它取得上下文，
// 禁止各自解析令牌或直接读取成员关系。
@Injectable()
export class ContextService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly auth: AuthService,
    private readonly scopes: ScopeService,
    private readonly mfa: MfaService,
    private readonly internalAccess: InternalAccessService,
  ) {}

  // 同一请求内只解析一次：写接口的拦截器与领域服务共用同一份上下文。
  async resolve(req: RequestWithContext): Promise<ApiContext> {
    if (req.apiContext) return req.apiContext
    const value = await this.load(req)
    req.apiContext = value
    return value
  }

  private async load(req: RequestWithContext): Promise<ApiContext> {
    if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效')
    if (req.accessMode === 'SUPPORT' && req.support) return this.loadSupport(req, req.support)
    // 内部访问模式（P1-18）：来源已由守卫校验，这里按配置绑定固定的内部租户与角色；不接受请求头指定租户
    if (req.accessMode === 'INTERNAL_DIRECT' && req.user.sessionId === INTERNAL_ACCESS_SESSION_ID) {
      const config = readInternalAccessConfig()
      if (!config.enabled) throw new AppError(401, 'AUTH_REQUIRED', '需要登录')
      const principal = await this.internalAccess.principal(config)
      req.user = { userId: principal.userId, sessionId: INTERNAL_ACCESS_SESSION_ID }
      req.tenantId = principal.tenantId
      bindTenant(principal.tenantId, principal.userId)
      bindTenantContext(principal.tenantId)
      return {
        userId: principal.userId,
        sessionId: INTERNAL_ACCESS_SESSION_ID,
        tenantId: principal.tenantId,
        membershipId: principal.membershipId,
        permissions: principal.permissions,
        accessMode: 'INTERNAL_DIRECT',
      }
    }
    if (process.env.APP_MODE === 'development' && process.env.LOCAL_NO_AUTH === 'true' && req.user.sessionId === 'local-dev-session') {
      const tenantId = process.env.LOCAL_DEV_TENANT_ID ?? 'local-dev-tenant'
      const membership = await this.prisma.membership.findFirst({
        where: { userId: req.user.userId, tenantId, status: 'ACTIVE' },
        include: roleInclude,
      })
      if (!membership) throw new AppError(503, 'LOCAL_WORKSPACE_NOT_READY', '本地工作区尚未初始化，请重新启动服务')
      const permissions = permissionsOfRole(membership.role)
      req.tenantId = tenantId
      bindTenant(tenantId, req.user.userId)
      bindTenantContext(tenantId)
      return { userId: req.user.userId, sessionId: req.user.sessionId, tenantId, membershipId: membership.id, permissions }
    }
    const value = await this.auth.context(req.user.userId, req.user.sessionId, req.header('x-tenant-context') ?? undefined)
    // 企业暂停：只读（认证接口除外，成员仍可退出登录、查看自己）；停用与注销在 AuthService 里已经拒绝
    if (value.lifecycleStatus === 'SUSPENDED' && !SAFE_METHODS.has(req.method) && !req.path.startsWith('/api/v1/auth/')) {
      throw appError('TENANT_SUSPENDED', '企业已被暂停，当前只读，不能修改数据；请联系平台运营')
    }
    // 管理员必须先绑定多因素认证（P1-17）：未绑定时只允许认证相关接口（获取绑定信息、提交验证码、查看自己、注销），其余一律拒绝
    if (!req.path.startsWith('/api/v1/auth/') && (await this.mfa.enrollmentRequired(value.userId, value.permissions))) {
      throw appError('MFA_ENROLLMENT_REQUIRED', '管理员账号必须先绑定多因素认证（动态验证码）后才能继续使用', { details: { enrollPath: '/app/profile' } })
    }
    req.tenantId = value.tenantId
    bindTenant(value.tenantId, value.userId)
    // 租户确定之后，本次请求的全部数据库访问都带着它（应用层补条件 + 行级安全变量）
    bindTenantContext(value.tenantId)
    return value
  }

  // 平台支持访问（P1-19）：授权必须仍然有效（企业所有者授权、本人领取、未到期、未撤销），只读，且每个请求都写入企业审计。
  // 看不到成本、利润、买家信息（不授予字段权限）；平台账号被停用后立即失效。
  private async loadSupport(req: RequestWithContext, claim: { adminId: string; accessId: string; tenantId: string }): Promise<ApiContext> {
    const now = new Date()
    const [grant, admin, tenant] = await Promise.all([
      this.prisma.platformSupportAccess.findFirst({
        where: { id: claim.accessId, tenantId: claim.tenantId, platformAdminId: claim.adminId, revokedAt: null, startsAt: { lte: now }, expiresAt: { gt: now } },
        select: { id: true },
      }),
      this.prisma.platformAdmin.findUnique({ where: { id: claim.adminId }, select: { status: true } }),
      this.prisma.tenant.findUnique({ where: { id: claim.tenantId }, select: { lifecycleStatus: true } }),
    ])
    if (!grant || admin?.status !== 'ACTIVE' || !tenant || !READABLE_STATUSES.includes(tenant.lifecycleStatus as TenantLifecycleStatus)) {
      throw appError('SUPPORT_ACCESS_NOT_GRANTED', '企业尚未授权支持访问，或授权已过期、已撤销')
    }
    const readOnly = SAFE_METHODS.has(req.method)
    await this.prisma.auditEvent.create({
      data: {
        tenantId: claim.tenantId,
        actorId: null,
        action: 'SUPPORT_ACCESS_REQUEST',
        resourceType: 'PlatformSupportAccess',
        resourceId: claim.accessId,
        requestId: req.requestId,
        source: 'API',
        result: readOnly ? 'SUCCEEDED' : 'DENIED',
        // 只记路径，不记查询串（可能含搜索词）；平台人员编号用于企业核对“谁看了什么”
        detail: { platformAdminId: claim.adminId, method: req.method, path: req.path },
        ip: req.ip,
        userAgent: req.header('user-agent'),
      },
    })
    // 写请求同样先记录（结果为 DENIED）再拒绝：企业能看到平台人员尝试过什么
    if (!readOnly) throw appError('SUPPORT_ACCESS_READ_ONLY', '支持访问是只读的，不能修改数据')
    req.tenantId = claim.tenantId
    bindTenant(claim.tenantId, `${SUPPORT_USER_PREFIX}${claim.adminId}`)
    bindTenantContext(claim.tenantId)
    return {
      userId: `${SUPPORT_USER_PREFIX}${claim.adminId}`,
      sessionId: claim.accessId,
      tenantId: claim.tenantId,
      membershipId: `${SUPPORT_USER_PREFIX}${claim.accessId}`,
      permissions: SUPPORT_PERMISSIONS,
      accessMode: 'SUPPORT',
      lifecycleStatus: tenant.lifecycleStatus as TenantLifecycleStatus,
    }
  }

  require(context: ApiContext, permission: string) {
    if (!hasPermission(context.permissions, permission)) {
      // 统一的无权限提示（P5-08，CR-096）：写明缺哪个权限点，并指向角色编辑器；details.permission 供前端直接显示
      throw new AppError(403, 'TENANT_ACCESS_DENIED', permissionDeniedMessage(permission), false, undefined, { permission })
    }
  }

  // 解析上下文并要求指定权限，是领域服务最常用的入口。
  async authorize(req: RequestWithContext, permission: string): Promise<ApiContext> {
    const context = await this.resolve(req)
    this.require(context, permission)
    return context
  }

  // 只要求登录（基础能力，没有对应权限点的接口，如数据新鲜度），按请求参数解析数据范围。
  async resolveScoped(req: RequestWithContext, query: unknown): Promise<{ context: ApiContext; scope: ResolvedScope }> {
    const context = await this.resolve(req)
    const scope = await this.scopes.resolve(context, query)
    return { context, scope }
  }

  // 要求权限，并按请求参数解析数据范围（主体、店铺、站点与成员授权取交集）。
  // 先鉴权、后解析参数；范围为空返回 403。所有按店铺归属的查询必须使用它返回的范围。
  async authorizeScoped(req: RequestWithContext, permission: string, query: unknown): Promise<{ context: ApiContext; scope: ResolvedScope }> {
    const context = await this.authorize(req, permission)
    const scope = await this.scopes.resolve(context, query)
    return { context, scope }
  }
}
