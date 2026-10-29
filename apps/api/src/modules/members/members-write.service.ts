import { Injectable, Logger } from '@nestjs/common'
import {
  MEMBER_ACTIONS,
  MEMBER_MANAGE,
  MemberDisableBodySchema,
  MemberEnableBodySchema,
  MemberRoleBodySchema,
  MemberScopesBodySchema,
  OWNER_ROLE_ID,
  scopeKindOf,
  type MemberChangeResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, assertUnrestricted } from '../auth'
import { MemberSystemService, type RoleWithFields } from './member-system.service'
import { MEMBER_INCLUDE, memberRowOf, memberSnapshot, scopeNamesOf, type MembershipRow } from './members-common'
import { OWNER_SCOPE_BLOCKED, assertMemberManageable, assertNotLastOwner, assertNotSelf, assertRoleGrantable, resolveScopeGrants } from './members-guards'

const grantKey = (grant: { legalEntityId: string | null; sellerAccountId: string | null }) =>
  grant.sellerAccountId ? `s:${grant.sellerAccountId}` : grant.legalEntityId ? `e:${grant.legalEntityId}` : 'all'

// 成员写入（P5-08）：停用、恢复、改角色、改数据范围。
// 四个动作共用的规则：需要成员管理权限与“全部店铺”数据范围；不能改自己；不能管理权限比自己高的成员；
// 业务数据与审计在同一个事务里提交；再次验证身份与幂等由 @Write 在进入这里之前统一处理。
@Injectable()
export class MembersWriteService {
  private readonly logger = new Logger(MembersWriteService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly system: MemberSystemService,
  ) {}

  async disable(req: RequestWithContext, id: string, rawBody: unknown): Promise<MemberChangeResult> {
    const { context, member, targetRole } = await this.prepare(req, id)
    const { reason } = MemberDisableBodySchema.parse(rawBody)
    if (member.status === 'DISABLED') return this.result(context.userId, member, false)
    await assertNotLastOwner(this.prisma, context.tenantId, { id: member.id, status: member.status, roleId: targetRole.id })
    const now = new Date()
    const before = memberSnapshot(member, await scopeNamesOf(this.prisma, context.tenantId, member.scopes))
    const changed = await this.prisma.$transaction(async tx => {
      const updated = await tx.membership.updateMany({
        where: { id, tenantId: context.tenantId, status: 'ACTIVE' },
        data: { status: 'DISABLED', disabledAt: now, disabledReason: reason, disabledBy: context.userId },
      })
      if (updated.count !== 1) return false
      await this.audit.record(req, { action: MEMBER_ACTIONS.disabled, resourceType: 'Membership', resourceId: id, before, after: { ...before, status: 'DISABLED' }, reason }, { client: tx })
      return true
    })
    if (changed) await this.revokeSessions(member.userId, context.tenantId, now)
    return this.result(context.userId, await this.reload(context.tenantId, id), changed)
  }

  async enable(req: RequestWithContext, id: string, rawBody: unknown): Promise<MemberChangeResult> {
    const { context, member } = await this.prepare(req, id)
    const { reason } = MemberEnableBodySchema.parse(rawBody)
    if (member.status === 'ACTIVE') return this.result(context.userId, member, false)
    const before = memberSnapshot(member, await scopeNamesOf(this.prisma, context.tenantId, member.scopes))
    const changed = await this.prisma.$transaction(async tx => {
      const updated = await tx.membership.updateMany({
        where: { id, tenantId: context.tenantId, status: 'DISABLED' },
        data: { status: 'ACTIVE', disabledAt: null, disabledReason: null, disabledBy: null },
      })
      if (updated.count !== 1) return false
      await this.audit.record(req, { action: MEMBER_ACTIONS.enabled, resourceType: 'Membership', resourceId: id, before, after: { ...before, status: 'ACTIVE' }, reason }, { client: tx })
      return true
    })
    return this.result(context.userId, await this.reload(context.tenantId, id), changed)
  }

  async changeRole(req: RequestWithContext, id: string, rawBody: unknown): Promise<MemberChangeResult> {
    const { context, member, targetRole } = await this.prepare(req, id)
    const body = MemberRoleBodySchema.parse(rawBody)
    const newRole = await this.system.role(context.tenantId, body.roleId)
    if (!newRole) throw appError('VALIDATION_FAILED', '所选角色不存在', { fieldErrors: { roleId: ['所选角色不存在'] } })
    if (newRole.id === targetRole.id) return this.result(context.userId, member, false)
    assertRoleGrantable(context.permissions, newRole)
    await assertNotLastOwner(this.prisma, context.tenantId, { id: member.id, status: member.status, roleId: targetRole.id })
    if (newRole.id === OWNER_ROLE_ID && scopeKindOf(member.scopes) !== 'ALL') {
      throw appError('DATA_CONDITION_FAILED', '所有者必须拥有全部主体与店铺的数据范围：请先把这位成员的数据范围改为“全部主体与店铺”，再设为所有者')
    }
    const names = await scopeNamesOf(this.prisma, context.tenantId, member.scopes)
    const before = memberSnapshot(member, names)
    await this.prisma.$transaction(async tx => {
      await tx.membership.update({ where: { id }, data: { roleId: newRole.id } })
      await this.audit.record(
        req,
        { action: MEMBER_ACTIONS.roleChanged, resourceType: 'Membership', resourceId: id, before, after: { ...before, roleId: newRole.id, roleName: newRole.name }, reason: body.reason },
        { client: tx },
      )
    })
    return this.result(context.userId, await this.reload(context.tenantId, id), true)
  }

  async changeScopes(req: RequestWithContext, id: string, rawBody: unknown): Promise<MemberChangeResult> {
    const { context, member, targetRole } = await this.prepare(req, id)
    const body = MemberScopesBodySchema.parse(rawBody)
    if (targetRole.id === OWNER_ROLE_ID && !body.scope.all) throw appError('VALIDATION_FAILED', OWNER_SCOPE_BLOCKED, { fieldErrors: { scope: [OWNER_SCOPE_BLOCKED] } })
    const grants = await resolveScopeGrants(this.prisma, context.tenantId, body.scope)
    const current = new Set(member.scopes.map(grantKey))
    const next = new Set(grants.map(grantKey))
    if (current.size === next.size && [...next].every(key => current.has(key))) return this.result(context.userId, member, false)
    const beforeNames = await scopeNamesOf(this.prisma, context.tenantId, member.scopes)
    const afterNames = await scopeNamesOf(this.prisma, context.tenantId, grants)
    const before = memberSnapshot(member, beforeNames)
    const afterScope = memberSnapshot({ ...member, scopes: grants.map((grant, index) => ({ id: `new-${index}`, createdAt: new Date(), note: null, ...grant })) }, afterNames).scope
    await this.prisma.$transaction(async tx => {
      await tx.membershipScope.deleteMany({ where: { tenantId: context.tenantId, membershipId: id } })
      for (const grant of grants) {
        await tx.membershipScope.create({
          data: { tenantId: context.tenantId, membershipId: id, legalEntityId: grant.legalEntityId, sellerAccountId: grant.sellerAccountId, grantedBy: context.userId, note: '成员管理页调整' },
        })
      }
      await this.audit.record(
        req,
        { action: MEMBER_ACTIONS.scopesChanged, resourceType: 'Membership', resourceId: id, before, after: { ...before, scope: afterScope }, reason: body.reason },
        { client: tx },
      )
    })
    return this.result(context.userId, await this.reload(context.tenantId, id), true)
  }

  /** 四个动作共用的前置：权限与范围、读取成员与其当前角色、不能改自己、不能管理权限比自己高的成员。 */
  private async prepare(req: RequestWithContext, id: string) {
    const { context, scope } = await this.context.authorizeScoped(req, MEMBER_MANAGE, {})
    assertUnrestricted(scope)
    const member = await this.reload(context.tenantId, id)
    const targetRole = await this.system.role(context.tenantId, member.roleId)
    if (!targetRole) throw appError('RESOURCE_NOT_FOUND', '成员的角色不存在')
    assertNotSelf(context.userId, member)
    assertMemberManageable(context.permissions, member, targetRole as RoleWithFields)
    return { context, member, targetRole }
  }

  private async reload(tenantId: string, id: string): Promise<MembershipRow> {
    const member = await this.prisma.membership.findFirst({ where: { id, tenantId }, include: MEMBER_INCLUDE })
    if (!member) throw appError('RESOURCE_NOT_FOUND', '成员不存在')
    return member
  }

  private async result(selfUserId: string, member: MembershipRow, changed: boolean): Promise<MemberChangeResult> {
    const [names, logins] = await Promise.all([scopeNamesOf(this.prisma, member.tenantId, member.scopes), this.system.lastLogins([member.userId])])
    return { member: memberRowOf(member, { selfUserId, lastLogin: logins.get(member.userId), names }), changed }
  }

  /** 停用后吊销登录会话；失败不回滚停用（成员状态检查在每个请求里都做，停用已经生效），但要留日志以便补救。 */
  private async revokeSessions(userId: string, tenantId: string, now: Date) {
    try {
      await this.system.revokeSessionsUnlessElsewhere(userId, tenantId, now)
    } catch (error) {
      this.logger.warn(`停用成员后吊销会话失败（成员已停用，访问仍会被拒绝）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
