import { FIELD_KEYS, effectivePermissions, type FieldGrant, type FieldKey } from '@nova/authz'
import type { PrismaClient } from '@prisma/client'

// 导出发起人“此刻”的权限与数据范围：导出任务排队期间权限可能被收回，生成文件时必须重新计算，取更严格的一方。
// 计算方式与接口服务一致（角色点位 + 旧点位映射 + 字段权限显式设置；店铺授权记录 → 范围）。

const isFieldKey = (value: string): value is FieldKey => (FIELD_KEYS as readonly string[]).includes(value)

interface RoleLike {
  permissions: unknown
  fieldPermissions?: { fieldKey: string; allowed: boolean }[] | null
  system?: boolean | null
  version?: number | null
}

export function permissionsOfRole(role: RoleLike): string[] {
  const stored = Array.isArray(role.permissions) ? role.permissions.map(String) : []
  const grants: FieldGrant[] = (role.fieldPermissions ?? []).filter(item => isFieldKey(item.fieldKey)).map(item => ({ fieldKey: item.fieldKey as FieldKey, allowed: item.allowed }))
  // 权限版本 2 起保存的就是新体系点位；仅版本 1 的非预设旧角色才展开旧映射
  return effectivePermissions(stored, grants, { legacy: !role.system && (role.version ?? 1) < 2 })
}

export interface ExportActor {
  permissions: string[]
  /** 当前允许访问的店铺；null 表示全部 */
  storeIds: string[] | null
}

/** 发起人已不在企业内（停用或移除）返回 null。 */
export async function loadActor(db: PrismaClient, tenantId: string, userId: string): Promise<ExportActor | null> {
  const membership = await db.membership.findFirst({
    where: { tenantId, userId, status: 'ACTIVE' },
    include: { role: { include: { fieldPermissions: { select: { fieldKey: true, allowed: true } } } } },
  })
  if (!membership) return null
  const grants = await db.membershipScope.findMany({ where: { tenantId, membershipId: membership.id }, select: { legalEntityId: true, sellerAccountId: true } })
  const permissions = permissionsOfRole(membership.role)
  if (grants.some(grant => !grant.legalEntityId && !grant.sellerAccountId)) return { permissions, storeIds: null }
  const entityIds = grants.filter(grant => grant.legalEntityId && !grant.sellerAccountId).map(grant => grant.legalEntityId as string)
  const storeIds = grants.filter(grant => grant.sellerAccountId).map(grant => grant.sellerAccountId as string)
  if (entityIds.length === 0 && storeIds.length === 0) return { permissions, storeIds: [] }
  const stores = await db.sellerAccount.findMany({ where: { tenantId, OR: [{ legalEntityId: { in: entityIds } }, { id: { in: storeIds } }] }, select: { id: true } })
  return { permissions, storeIds: stores.map(store => store.id) }
}

/** 发起时保存的范围 与 发起人当前的范围 取交集；null 表示不限店铺；空数组表示没有可导出的店铺。 */
export function intersectScope(saved: { unrestricted: boolean; storeIds: readonly string[] }, current: string[] | null): string[] | null {
  if (saved.unrestricted) return current
  if (current === null) return [...saved.storeIds]
  const allowed = new Set(current)
  return saved.storeIds.filter(id => allowed.has(id))
}
