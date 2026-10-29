import { Injectable } from '@nestjs/common'
import { hash } from 'bcryptjs'
import { InviteAcceptBodySchema, READABLE_STATUSES, passwordProblems, type TenantLifecycleStatus } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { RateLimitService } from '../../platform/rate-limit.service'
import { hashInviteToken, isWellFormedInviteToken } from './invitation-token'

const PRESET_OWNER_ROLE = 'preset-owner'

type Resolved = {
  kind: 'TENANT' | 'MEMBER'
  invitationId: string
  tenantId: string
  tenantName: string
  email: string
  roleId: string
  scope: { all: boolean; legalEntityIds: string[]; sellerAccountIds: string[] }
}

// 接受邀请（公开接口，无需登录）：令牌一次性、72 小时有效；用户设置姓名与密码后账号立即可用。
// 首个管理员的邀请由平台开通企业时生成，接受后绑定“所有者”预设角色与全部店铺数据范围，并必须绑定多因素认证（登录后引导）。
// 任何无效情形（不存在、过期、已使用、已撤销、企业已停用）对外统一返回 INVITATION_INVALID，不泄露具体原因。
@Injectable()
export class InvitationService {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private invalid() {
    return appError('INVITATION_INVALID', '邀请链接无效或已过期，请联系邀请你的人重新发送')
  }

  private async resolve(token: string): Promise<Resolved> {
    if (!isWellFormedInviteToken(token)) throw this.invalid()
    const tokenHash = hashInviteToken(token)
    const now = new Date()
    const tenantInvite = await this.system.tenantInvitation.findUnique({ where: { tokenHash }, include: { tenant: { select: { name: true, lifecycleStatus: true } } } })
    if (tenantInvite) {
      if (tenantInvite.status !== 'PENDING' || tenantInvite.expiresAt <= now || !READABLE_STATUSES.includes(tenantInvite.tenant.lifecycleStatus as TenantLifecycleStatus)) throw this.invalid()
      return {
        kind: 'TENANT',
        invitationId: tenantInvite.id,
        tenantId: tenantInvite.tenantId,
        tenantName: tenantInvite.tenant.name,
        email: tenantInvite.email,
        roleId: PRESET_OWNER_ROLE,
        scope: { all: true, legalEntityIds: [], sellerAccountIds: [] },
      }
    }
    const memberInvite = await this.system.memberInvitation.findUnique({ where: { tokenHash }, include: { tenant: { select: { name: true, lifecycleStatus: true } } } })
    if (!memberInvite || memberInvite.status !== 'PENDING' || memberInvite.expiresAt <= now || !READABLE_STATUSES.includes(memberInvite.tenant.lifecycleStatus as TenantLifecycleStatus))
      throw this.invalid()
    const snapshot = (memberInvite.scopeSnapshot ?? {}) as { all?: boolean; legalEntityIds?: string[]; sellerAccountIds?: string[] }
    const sellerAccountIds = Array.isArray(snapshot.sellerAccountIds) ? snapshot.sellerAccountIds : []
    // 成员管理页（P5-08）邀请时可以指定主体；旧快照没有 legalEntityIds，“没有任何店铺”表示全部范围，所以主体与店铺都为空时仍按全部处理
    const legalEntityIds = Array.isArray(snapshot.legalEntityIds) ? snapshot.legalEntityIds : []
    const scope = { all: snapshot.all === true || (sellerAccountIds.length === 0 && legalEntityIds.length === 0), legalEntityIds, sellerAccountIds }
    return { kind: 'MEMBER', invitationId: memberInvite.id, tenantId: memberInvite.tenantId, tenantName: memberInvite.tenant.name, email: memberInvite.email, roleId: memberInvite.roleId, scope }
  }

  /** 打开邀请页时预览：只返回企业名称与受邀邮箱，不返回令牌之外的任何内部标识 */
  async preview(req: RequestWithContext, token: string) {
    await this.rateLimit.check('invite-preview', req.ip ?? 'unknown', 30, 60)
    const invite = await this.resolve(token)
    return { tenantName: invite.tenantName, email: invite.email, firstAdmin: invite.kind === 'TENANT' }
  }

  async accept(req: RequestWithContext, token: string, rawBody: unknown) {
    await this.rateLimit.check('invite-accept', req.ip ?? 'unknown', 10, 60)
    const invite = await this.resolve(token)
    const parsed = InviteAcceptBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of parsed.error.issues) (fieldErrors[issue.path.join('.') || 'password'] ??= []).push(issue.message)
      throw appError('PASSWORD_TOO_WEAK', fieldErrors.password?.[0] ?? '提交的内容不符合要求', { fieldErrors })
    }
    const problems = passwordProblems(parsed.data.password, { email: invite.email })
    if (problems.length) throw appError('PASSWORD_TOO_WEAK', problems[0], { fieldErrors: { password: problems } })
    if (await this.system.user.findUnique({ where: { email: invite.email }, select: { id: true } }))
      throw appError('INVITATION_EMAIL_REGISTERED', '该邮箱已注册，请直接登录；如需加入其他企业，请联系对方管理员')

    const passwordHash = await hash(parsed.data.password, 12)
    const now = new Date()
    const result = await this.system.$transaction(async tx => {
      // 原子占用邀请：并发的两次接受只会有一次成功，令牌不会被重复使用
      const consumed =
        invite.kind === 'TENANT'
          ? await tx.tenantInvitation.updateMany({ where: { id: invite.invitationId, status: 'PENDING', expiresAt: { gt: now } }, data: { status: 'ACCEPTED', acceptedAt: now } })
          : await tx.memberInvitation.updateMany({ where: { id: invite.invitationId, status: 'PENDING', expiresAt: { gt: now } }, data: { status: 'ACCEPTED', acceptedAt: now } })
      if (consumed.count !== 1) throw this.invalid()
      const user = await tx.user.create({ data: { email: invite.email, displayName: parsed.data.displayName, passwordHash } })
      const membership = await tx.membership.create({ data: { userId: user.id, tenantId: invite.tenantId, roleId: invite.roleId } })
      const grants: { legalEntityId: string | null; sellerAccountId: string | null }[] = invite.scope.all
        ? [{ legalEntityId: null, sellerAccountId: null }]
        : [
            ...invite.scope.legalEntityIds.map(legalEntityId => ({ legalEntityId, sellerAccountId: null })),
            ...invite.scope.sellerAccountIds.map(sellerAccountId => ({ legalEntityId: null, sellerAccountId })),
          ]
      const note = invite.kind === 'TENANT' ? '首个管理员' : '邀请时授予'
      for (const grant of grants)
        await tx.membershipScope.create({
          data: { tenantId: invite.tenantId, membershipId: membership.id, legalEntityId: grant.legalEntityId, sellerAccountId: grant.sellerAccountId, grantedBy: user.id, note },
        })
      await tx.auditEvent.create({
        data: {
          tenantId: invite.tenantId,
          actorId: user.id,
          action: invite.kind === 'TENANT' ? 'FIRST_ADMIN_ACTIVATED' : 'MEMBER_INVITATION_ACCEPTED',
          resourceType: 'Membership',
          resourceId: membership.id,
          requestId: req.requestId,
          source: 'API',
          result: 'SUCCEEDED',
          ip: req.ip?.slice(0, 64),
          userAgent: req.header('user-agent')?.slice(0, 300),
          detail: { roleId: invite.roleId, scopeAll: invite.scope.all },
        },
      })
      return { userId: user.id }
    })
    void result
    return { email: invite.email, tenantName: invite.tenantName, mfaEnrollmentRequired: invite.kind === 'TENANT' }
  }
}
