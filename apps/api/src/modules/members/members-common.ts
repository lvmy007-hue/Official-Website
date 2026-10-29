import {
  MEMBER_INVITE,
  MEMBER_INVITE_BLOCKED_NO_PERMISSION,
  MEMBER_MANAGE,
  MEMBER_WRITE_BLOCKED_NOT_UNRESTRICTED,
  MEMBER_WRITE_BLOCKED_NO_PERMISSION,
  scopeKindOf,
  scopeLabelOf,
  type MemberRow,
  type MemberScopeSummary,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'

// 成员模块的共用小件：成员行转换、数据范围名称、写入前置条件。

/**
 * 读取成员列表与详情只要 member.read，不要求自己有数据范围授权（支持访问、尚未授权范围的成员也能看人）。
 * 这里只为了判断“能不能管理成员”：没有任何授权记录按“不是全部范围”处理，不抛 SCOPE_NOT_GRANTED。
 */
export async function readerScope(contexts: ContextService, req: RequestWithContext, permission: string) {
  const context = await contexts.authorize(req, permission)
  try {
    const { scope } = await contexts.resolveScoped(req, {})
    return { context, unrestricted: scope.unrestricted }
  } catch (error) {
    if (error instanceof AppError && error.code === 'SCOPE_NOT_GRANTED') return { context, unrestricted: false }
    throw error
  }
}

export const MEMBER_INCLUDE = {
  user: { select: { id: true, email: true, displayName: true } },
  role: { select: { id: true, name: true, system: true } },
  scopes: { select: { id: true, legalEntityId: true, sellerAccountId: true, createdAt: true, note: true } },
} satisfies Prisma.MembershipInclude

export type MembershipRow = Prisma.MembershipGetPayload<{ include: typeof MEMBER_INCLUDE }>

export interface ScopeNames {
  entities: Map<string, string>
  stores: Map<string, string>
}

type GrantIds = { legalEntityId: string | null; sellerAccountId: string | null }

/** 授权记录里出现的主体与店铺的名字（一次查完，避免逐行查询）。 */
export async function scopeNamesOf(prisma: PrismaService, tenantId: string, grants: readonly GrantIds[]): Promise<ScopeNames> {
  const entityIds = [...new Set(grants.flatMap(grant => (grant.legalEntityId ? [grant.legalEntityId] : [])))]
  const storeIds = [...new Set(grants.flatMap(grant => (grant.sellerAccountId ? [grant.sellerAccountId] : [])))]
  const [entities, stores] = await Promise.all([
    entityIds.length ? prisma.legalEntity.findMany({ where: { tenantId, id: { in: entityIds } }, select: { id: true, name: true }, take: 2000 }) : [],
    storeIds.length ? prisma.sellerAccount.findMany({ where: { tenantId, id: { in: storeIds } }, select: { id: true, displayName: true }, take: 2000 }) : [],
  ])
  return { entities: new Map(entities.map(item => [item.id, item.name])), stores: new Map(stores.map(item => [item.id, item.displayName])) }
}

export function scopeSummaryOf(grants: readonly GrantIds[], names: ScopeNames): MemberScopeSummary {
  const kind = scopeKindOf(grants)
  const entityNames = grants.flatMap(grant => (grant.legalEntityId && !grant.sellerAccountId ? [names.entities.get(grant.legalEntityId) ?? '（已删除的主体）'] : []))
  const storeNames = grants.flatMap(grant => (grant.sellerAccountId ? [names.stores.get(grant.sellerAccountId) ?? '（已删除的店铺）'] : []))
  return { kind, label: scopeLabelOf(kind, entityNames, storeNames), entityNames, storeNames }
}

export function memberRowOf(row: MembershipRow, extra: { selfUserId: string; lastLogin: Date | undefined; names: ScopeNames }): MemberRow {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.displayName,
    email: row.user.email,
    status: row.status,
    roleId: row.role.id,
    roleName: row.role.name,
    roleSystem: row.role.system,
    scope: scopeSummaryOf(row.scopes, extra.names),
    lastLoginAt: extra.lastLogin ? extra.lastLogin.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    isSelf: row.userId === extra.selfUserId,
  }
}

/** 能不能管理成员（停用、改角色、改范围）与不能的原因：要权限，并且要“全部店铺”数据范围。 */
export function manageBlock(permissions: readonly string[], unrestricted: boolean): string | null {
  if (!hasPermission(permissions, MEMBER_MANAGE)) return MEMBER_WRITE_BLOCKED_NO_PERMISSION
  return unrestricted ? null : MEMBER_WRITE_BLOCKED_NOT_UNRESTRICTED
}

export function inviteBlock(permissions: readonly string[], unrestricted: boolean): string | null {
  if (!hasPermission(permissions, MEMBER_INVITE)) return MEMBER_INVITE_BLOCKED_NO_PERMISSION
  return unrestricted ? null : MEMBER_WRITE_BLOCKED_NOT_UNRESTRICTED
}

/** 审计快照：成员的状态、角色与数据范围概括，修改前后同形。 */
export const memberSnapshot = (row: MembershipRow, names: ScopeNames) => ({ status: row.status, roleId: row.role.id, roleName: row.role.name, scope: scopeSummaryOf(row.scopes, names).label })
