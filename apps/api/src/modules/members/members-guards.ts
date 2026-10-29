import { LAST_OWNER_BLOCKED, MEMBER_SELF_BLOCKED, OWNER_ROLE_ID, permissionsActorLacks, scopeInputProblem, type ScopeInput } from '@nova/api-contracts'
import { appError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import type { RoleWithFields } from './member-system.service'
import type { MembershipRow } from './members-common'
import { rolePermissionKeys } from './roles-common'

// 成员写入的前置条件（越权、自锁、最后一位所有者、范围核对）。每一条都是服务端规则，页面置灰只是提示。

const lacksMessage = (lacks: string[]) =>
  lacks.includes('*') ? '只有企业所有者能把“所有者”角色授予别人' : `不能授予你自己没有的权限点：${lacks.slice(0, 5).join('、')}${lacks.length > 5 ? ` 等 ${lacks.length} 个` : ''}`

/** 不能授予自己没有的权限：把角色分配给别人时，角色里的每个权限点操作者自己都必须拥有。 */
export function assertRoleGrantable(actorPermissions: readonly string[], role: RoleWithFields) {
  const lacks = permissionsActorLacks(actorPermissions, rolePermissionKeys(role))
  if (lacks.length > 0) throw appError('TENANT_ACCESS_DENIED', lacksMessage(lacks), { details: { lacks: lacks.slice(0, 20).join(',') } })
}

/** 不能管理权限比自己高的成员（例如管理员不能停用所有者）：对方当前角色的权限点操作者必须都有。 */
export function assertMemberManageable(actorPermissions: readonly string[], target: MembershipRow, targetRole: RoleWithFields) {
  const lacks = permissionsActorLacks(actorPermissions, rolePermissionKeys(targetRole))
  if (lacks.length > 0) throw appError('TENANT_ACCESS_DENIED', `${target.user.displayName} 的角色权限高于你，不能由你管理`, { details: { lacks: lacks.slice(0, 20).join(',') } })
}

/** 不能改自己：停用自己、改自己的角色或数据范围都会把自己锁在门外（要改请另一位管理员操作）。 */
export function assertNotSelf(actorUserId: string, target: Pick<MembershipRow, 'userId'>) {
  if (target.userId === actorUserId) throw appError('DATA_CONDITION_FAILED', MEMBER_SELF_BLOCKED)
}

/** 企业必须保留至少一位使用中的所有者：把最后一位所有者停用或换角色之前拦下。 */
export async function assertNotLastOwner(prisma: PrismaService, tenantId: string, target: { id: string; status: string; roleId: string }) {
  if (target.roleId !== OWNER_ROLE_ID || target.status !== 'ACTIVE') return
  const others = await prisma.membership.count({ where: { tenantId, roleId: OWNER_ROLE_ID, status: 'ACTIVE', id: { not: target.id } } })
  if (others === 0) throw appError('DATA_CONDITION_FAILED', LAST_OWNER_BLOCKED)
}

export const OWNER_SCOPE_BLOCKED = '所有者必须拥有全部主体与店铺的数据范围，不能缩小'

/**
 * 核对数据范围请求：全部与具体列表二选一；具体的主体与店铺必须都属于本企业。
 * 返回要写入的授权行（全部为两列都空的一行）。
 */
export async function resolveScopeGrants(prisma: PrismaService, tenantId: string, scope: ScopeInput): Promise<{ legalEntityId: string | null; sellerAccountId: string | null }[]> {
  const problem = scopeInputProblem(scope)
  if (problem) throw appError('VALIDATION_FAILED', problem, { fieldErrors: { scope: [problem] } })
  if (scope.all) return [{ legalEntityId: null, sellerAccountId: null }]
  const entityIds = [...new Set(scope.legalEntityIds)]
  const storeIds = [...new Set(scope.sellerAccountIds)]
  const [entities, stores] = await Promise.all([
    entityIds.length ? prisma.legalEntity.findMany({ where: { tenantId, id: { in: entityIds } }, select: { id: true }, take: 2000 }) : [],
    storeIds.length ? prisma.sellerAccount.findMany({ where: { tenantId, id: { in: storeIds } }, select: { id: true }, take: 2000 }) : [],
  ])
  const missingEntities = entityIds.filter(id => !entities.some(item => item.id === id))
  const missingStores = storeIds.filter(id => !stores.some(item => item.id === id))
  if (missingEntities.length || missingStores.length) {
    const message = '所选主体或店铺不存在，或不属于本企业'
    throw appError('VALIDATION_FAILED', message, {
      fieldErrors: { ...(missingEntities.length ? { legalEntityIds: [message] } : {}), ...(missingStores.length ? { sellerAccountIds: [message] } : {}) },
    })
  }
  return [...entityIds.map(legalEntityId => ({ legalEntityId, sellerAccountId: null })), ...storeIds.map(sellerAccountId => ({ legalEntityId: null, sellerAccountId }))]
}
