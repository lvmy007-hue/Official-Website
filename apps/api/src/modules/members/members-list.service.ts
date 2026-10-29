import { Injectable } from '@nestjs/common'
import { MEMBER_INVITATION_LIMIT, MEMBER_READ, MemberListQuerySchema, scopeKindOf, scopeLabelOf, type MemberInvitationRow, type MemberListResponse, type MemberOption } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { MemberSystemService } from './member-system.service'
import { MEMBER_INCLUDE, inviteBlock, manageBlock, memberRowOf, readerScope, scopeNamesOf } from './members-common'

type SnapshotLike = { all?: boolean; legalEntityIds?: string[]; sellerAccountIds?: string[] }

// 成员列表（P5-08，09 章 9.10）：姓名、邮箱、状态、角色、数据范围、最近登录；另列待接受的邀请。
// 读取只要 member.read；能不能邀请、能不能管理由服务端给出（含原因），页面据此置灰。
@Injectable()
export class MembersListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly system: MemberSystemService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<MemberListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, unrestricted } = await readerScope(this.context, req, MEMBER_READ)
    const query = MemberListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const where: Prisma.MembershipWhereInput = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.roleId ? { roleId: query.roleId } : {}),
      ...(query.q ? { user: { OR: [{ displayName: { contains: query.q, mode: 'insensitive' } }, { email: { contains: query.q, mode: 'insensitive' } }] } } : {}),
    }
    const pendingWhere: Prisma.MemberInvitationWhereInput = { tenantId, status: 'PENDING', expiresAt: { gt: now } }
    const [rows, total, statusCounts, pending, invitations, roles] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        include: MEMBER_INCLUDE,
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.membership.count({ where }),
      this.prisma.membership.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.memberInvitation.count({ where: pendingWhere }),
      this.prisma.memberInvitation.findMany({ where: pendingWhere, orderBy: { createdAt: 'desc' }, take: MEMBER_INVITATION_LIMIT, include: { role: { select: { name: true } } } }),
      this.system.roles(tenantId),
    ])
    const snapshots = invitations.map(item => (item.scopeSnapshot ?? {}) as SnapshotLike)
    const grantsOfInvites = snapshots.flatMap(grantsOf)
    const [names, logins, inviters] = await Promise.all([
      scopeNamesOf(this.prisma, tenantId, [...rows.flatMap(row => row.scopes), ...grantsOfInvites]),
      this.system.lastLogins(rows.map(row => row.userId)),
      invitations.length ? this.prisma.user.findMany({ where: { id: { in: [...new Set(invitations.map(item => item.invitedBy))] } }, select: { id: true, displayName: true }, take: 500 }) : [],
    ])
    const inviterName = new Map(inviters.map(user => [user.id, user.displayName]))
    const countOf = (status: string) => statusCounts.find(group => group.status === status)?._count._all ?? 0
    const manage = manageBlock(context.permissions, unrestricted)
    const invite = inviteBlock(context.permissions, unrestricted)
    return {
      items: rows.map(row => memberRowOf(row, { selfUserId: context.userId, lastLogin: logins.get(row.userId), names })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      summary: { total: statusCounts.reduce((sum, group) => sum + group._count._all, 0), active: countOf('ACTIVE'), disabled: countOf('DISABLED'), pendingInvitations: pending },
      roles: roles.map(role => ({ id: role.id, name: role.name })),
      invitations: invitations.map((item, index): MemberInvitationRow => {
        const snapshot = snapshots[index] ?? {}
        const entityNames = (snapshot.legalEntityIds ?? []).map(id => names.entities.get(id) ?? '（已删除的主体）')
        const storeNames = (snapshot.sellerAccountIds ?? []).map(id => names.stores.get(id) ?? '（已删除的店铺）')
        // 旧邀请没有主体字段，且“没有任何店铺”表示全部（与接受邀请时的解读一致）
        const kind = snapshot.all === true || (entityNames.length === 0 && storeNames.length === 0) ? 'ALL' : scopeKindOf(grantsOf(snapshot))
        return {
          id: item.id,
          email: item.email,
          roleName: item.role.name,
          expiresAt: item.expiresAt.toISOString(),
          invitedByName: inviterName.get(item.invitedBy) ?? null,
          scopeLabel: scopeLabelOf(kind, entityNames, storeNames),
          createdAt: item.createdAt.toISOString(),
        }
      }),
      canInvite: invite === null,
      inviteBlockedReason: invite,
      canManage: manage === null,
      manageBlockedReason: manage,
    }
  }

  /** 选人用的轻量列表（待办指派、评论 @、改进跟进的负责人）：只需要 member.read，不含角色与范围。 */
  async options(req: RequestWithContext): Promise<MemberOption[]> {
    const context = await this.context.authorize(req, MEMBER_READ)
    const rows = await this.prisma.membership.findMany({
      where: { tenantId: context.tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1000,
      select: { status: true, user: { select: { id: true, displayName: true, email: true } } },
    })
    return rows.map(row => ({ status: row.status, user: row.user }))
  }
}

const grantsOf = (snapshot: SnapshotLike) => [
  ...(snapshot.legalEntityIds ?? []).map(legalEntityId => ({ legalEntityId, sellerAccountId: null })),
  ...(snapshot.sellerAccountIds ?? []).map(sellerAccountId => ({ legalEntityId: null, sellerAccountId })),
]
