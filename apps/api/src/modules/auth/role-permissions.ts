import { FIELD_KEYS, effectivePermissions, type FieldGrant, type FieldKey } from '@nova/authz'

// 角色 → 有效权限点（P1-13）：角色保存的点位展开旧映射、加上基础权限、叠加字段权限显式设置。
// 结果同时用于鉴权与 /auth/me 返回，前后端看到的是同一份。

export const roleInclude = {
  role: { include: { fieldPermissions: { select: { fieldKey: true, allowed: true, ownerOnly: true } } } },
} as const

type RoleLike = {
  permissions: unknown
  fieldPermissions?: { fieldKey: string; allowed: boolean; ownerOnly?: boolean | null }[] | null
  system?: boolean | null
  version?: number | null
}

/** 权限版本 2 起（迁移后的角色、预设角色、新建角色）保存的就是新体系点位，不再按旧映射展开；仅版本 1 的非预设旧角色才展开。 */
export const usesLegacy = (role: RoleLike) => !role.system && (role.version ?? 1) < 2

const isFieldKey = (value: string): value is FieldKey => (FIELD_KEYS as readonly string[]).includes(value)

export function permissionsOfRole(role: RoleLike): string[] {
  const stored = Array.isArray(role.permissions) ? role.permissions.map(String) : []
  // “仅负责人可见”（P5-08）：ownerOnly 的字段权限在有效权限里只留 field.X.own 标记，没有处理负责人的接口一律按“看不到”处理
  const grants: FieldGrant[] = (role.fieldPermissions ?? [])
    .filter(item => isFieldKey(item.fieldKey))
    .map(item => ({ fieldKey: item.fieldKey as FieldKey, allowed: item.allowed, ownerOnly: item.ownerOnly === true }))
  return effectivePermissions(stored, grants, { legacy: usesLegacy(role) })
}
