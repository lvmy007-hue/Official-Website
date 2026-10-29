import { Injectable } from '@nestjs/common'
import {
  AUDIT_READ,
  LAST_OWNER_BLOCKED,
  MEMBER_AUDIT_LIMIT,
  MEMBER_READ,
  MEMBER_SELF_BLOCKED,
  MEMBER_SESSION_LIMIT,
  OWNER_ROLE_ID,
  memberActionLabel,
  permissionsActorLacks,
  type MemberAuditView,
  type MemberDetail,
  type MemberGrantView,
  type MemberSessionView,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { MemberSystemService } from './member-system.service'
import { MEMBER_INCLUDE, manageBlock, memberRowOf, readerScope, scopeNamesOf } from './members-common'
import { rolePermissionKeys, roleSummaryOf } from './roles-common'

const SESSION_ROW_LIMIT = 400
const DEVICE_MAX = 120

type SessionRow = { id: string; rotationChainId: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; revokedAt: Date | null; ipMasked: string | null; userAgent: string | null }

/** 刷新会换会话行，所以按同一次登录（轮换链）合并成一条：最早的创建时间为登录时间，最近的活动时间为最后活动。 */
export function sessionViews(rows: readonly SessionRow[], now: Date, limit: number): { items: MemberSessionView[]; truncated: boolean } {
  const chains = new Map<string, SessionRow[]>()
  for (const row of rows) chains.set(row.rotationChainId, [...(chains.get(row.rotationChainId) ?? []), row])
  const views = [...chains.values()].map((chain): MemberSessionView => {
    const first = chain.reduce((a, b) => (b.createdAt < a.createdAt ? b : a))
    const latest = chain.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
    const live = chain.some(row => row.revokedAt === null && row.expiresAt > now)
    const state = live ? 'ACTIVE' : chain.some(row => row.revokedAt !== null) ? 'REVOKED' : 'EXPIRED'
    return {
      id: first.id,
      loginAt: first.createdAt.toISOString(),
      lastSeenAt: chain.reduce((a, b) => (b.lastSeenAt > a ? b.lastSeenAt : a), first.lastSeenAt).toISOString(),
      ipMasked: latest.ipMasked,
      device: latest.userAgent ? latest.userAgent.slice(0, DEVICE_MAX) : null,
      state,
    }
  })
  views.sort((a, b) => (a.loginAt < b.loginAt ? 1 : -1))
  return { items: views.slice(0, limit), truncated: views.length > limit || rows.length >= SESSION_ROW_LIMIT }
}

// 成员详情（P5-08）：基本信息、角色与字段权限、数据范围授权、登录与会话、与该成员有关的审计、各动作能不能做及原因。
@Injectable()
export class MembersDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly system: MemberSystemService,
  ) {}

  async detail(req: RequestWithContext, id: string, now = new Date()): Promise<MemberDetail> {
    const { context, unrestricted } = await readerScope(this.context, req, MEMBER_READ)
    const tenantId = context.tenantId
    const member = await this.prisma.membership.findFirst({ where: { id, tenantId }, include: MEMBER_INCLUDE })
    if (!member) throw appError('RESOURCE_NOT_FOUND', '成员不存在')
    const canAudit = hasPermission(context.permissions, AUDIT_READ)
    const [roles, names, logins, sessionRows, owners, auditRows] = await Promise.all([
      this.system.roles(tenantId),
      scopeNamesOf(this.prisma, tenantId, member.scopes),
      this.system.lastLogins([member.userId]),
      this.system.sessionRows(member.userId, SESSION_ROW_LIMIT),
      this.prisma.membership.count({ where: { tenantId, roleId: OWNER_ROLE_ID, status: 'ACTIVE', id: { not: member.id } } }),
      canAudit
        ? this.prisma.auditEvent.findMany({
            where: { tenantId, OR: [{ resourceType: 'Membership', resourceId: member.id }, { actorId: member.userId }] },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: MEMBER_AUDIT_LIMIT + 1,
            select: { id: true, occurredAt: true, action: true, resourceType: true, result: true, actorId: true, reason: true },
          })
        : [],
    ])
    const role = roles.find(item => item.id === member.roleId)
    if (!role) throw appError('RESOURCE_NOT_FOUND', '成员的角色不存在')
    const row = memberRowOf(member, { selfUserId: context.userId, lastLogin: logins.get(member.userId), names })

    const actorIds = [...new Set(auditRows.flatMap(event => (event.actorId ? [event.actorId] : [])))]
    const actors = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true }, take: 200 }) : []
    const actorName = new Map(actors.map(user => [user.id, user.displayName]))
    const shown = auditRows.slice(0, MEMBER_AUDIT_LIMIT)
    const audit: MemberAuditView[] = shown.map(event => ({
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      action: event.action,
      actionLabel: memberActionLabel(event.action),
      resourceType: event.resourceType,
      result: event.result,
      asActor: event.actorId === member.userId,
      operator: event.actorId ? (actorName.get(event.actorId) ?? '（已删除的用户）') : '系统',
      reason: event.reason,
    }))

    const grants: MemberGrantView[] = member.scopes
      .map((grant): MemberGrantView => {
        const kind = grant.sellerAccountId ? 'STORE' : grant.legalEntityId ? 'ENTITY' : 'ALL'
        const name =
          kind === 'STORE'
            ? (names.stores.get(grant.sellerAccountId ?? '') ?? '（已删除的店铺）')
            : kind === 'ENTITY'
              ? (names.entities.get(grant.legalEntityId ?? '') ?? '（已删除的主体）')
              : '全部主体与店铺'
        return { id: grant.id, kind, refId: grant.sellerAccountId ?? grant.legalEntityId, name, grantedAt: grant.createdAt.toISOString(), note: grant.note }
      })
      .sort((a, b) => (a.grantedAt < b.grantedAt ? -1 : 1))

    // 各动作能不能做：与写接口用同一套规则（权限、不能改自己、不能管理权限比自己高的成员、最后一位所有者）
    const block = manageBlock(context.permissions, unrestricted)
    const above = permissionsActorLacks(context.permissions, rolePermissionKeys(role)).length > 0
    const common = block ?? (row.isSelf ? MEMBER_SELF_BLOCKED : above ? `${row.name} 的角色权限高于你，不能由你管理` : null)
    const lastOwner = member.roleId === OWNER_ROLE_ID && member.status === 'ACTIVE' && owners === 0
    const sessions = sessionViews(sessionRows, now, MEMBER_SESSION_LIMIT)
    return {
      member: { ...row, disabledAt: member.disabledAt ? member.disabledAt.toISOString() : null, disabledReason: member.disabledReason },
      role: roleSummaryOf(role),
      roles: roles.map(item => ({ id: item.id, name: item.name })),
      grants,
      sessions: sessions.items,
      sessionsTruncated: sessions.truncated,
      audit: canAudit ? { state: 'OK', items: audit, truncated: auditRows.length > MEMBER_AUDIT_LIMIT } : { state: 'RESTRICTED', items: [], truncated: false },
      canManage: block === null,
      manageBlockedReason: block,
      actions: {
        disable: common ?? (member.status === 'DISABLED' ? '这位成员已经是停用状态' : lastOwner ? LAST_OWNER_BLOCKED : null),
        enable: common ?? (member.status === 'ACTIVE' ? '这位成员正在使用中' : null),
        role: common ?? (lastOwner ? LAST_OWNER_BLOCKED : null),
        scopes: common,
      },
    }
  }
}
