import {
  ROLE_PRESET_BLOCKED,
  ROLE_WRITE_BLOCKED_NOT_UNRESTRICTED,
  ROLE_WRITE_BLOCKED_NO_PERMISSION,
  ROLE_FIELD_KEYS,
  ROLE_MANAGE,
  permissionsActorLacks,
  type RoleEditorView,
  type RoleFieldTier,
  type RoleFields,
  type RoleSummary,
} from '@nova/api-contracts'
import { PERMISSION_CATALOG, effectivePermissions, fieldPermission, hasPermission, ownerFieldPermission } from '@nova/authz'
import { permissionsOfRole, usesLegacy } from '../auth'
import type { RoleWithFields } from './member-system.service'

// 角色的共用小件：把数据库里的角色整理成页面要的样子（权限点列表、字段三档、能不能编辑与原因）。

export const CATALOG_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map(entry => entry.key))

export const isPresetRole = (role: Pick<RoleWithFields, 'tenantId' | 'system'>) => role.tenantId === null && role.system

const storedKeys = (role: RoleWithFields): string[] => (Array.isArray(role.permissions) ? role.permissions.map(String) : [])

/** 角色的具体权限点：通配（所有者）为 ['*']；旧版角色（权限版本 1）展开旧映射后只留目录里认识的点位。 */
export function rolePermissionKeys(role: RoleWithFields): string[] {
  const stored = storedKeys(role)
  if (stored.includes('*')) return ['*']
  const source = usesLegacy(role) ? effectivePermissions(stored, [], { legacy: true }) : stored
  return source.filter(key => CATALOG_KEYS.has(key))
}

/** 字段权限三档：由角色的有效权限算出，所以旧映射带出的字段权限、通配与显式设置都按同一套规则显示。 */
export function roleFieldsOf(role: RoleWithFields): RoleFields {
  const effective = permissionsOfRole(role)
  const tierOf = (field: (typeof ROLE_FIELD_KEYS)[number]): RoleFieldTier =>
    effective.includes('*') || effective.includes(fieldPermission(field)) ? 'VISIBLE' : effective.includes(ownerFieldPermission(field)) ? 'OWNER_ONLY' : 'HIDDEN'
  return { cost: tierOf('cost'), profit: tierOf('profit'), buyer: tierOf('buyer') }
}

export const roleSummaryOf = (role: RoleWithFields): RoleSummary => ({
  id: role.id,
  name: role.name,
  system: role.system,
  description: role.description,
  permissions: rolePermissionKeys(role),
  fields: roleFieldsOf(role),
})

/** 操作者能不能改这个角色、不能的原因：预设与旧版角色只能复制；操作者没有的权限点也不能通过改角色授予别人。 */
export function roleEditBlock(role: RoleWithFields, actorPermissions: readonly string[], unrestricted: boolean): string | null {
  if (!hasPermission(actorPermissions, ROLE_MANAGE)) return ROLE_WRITE_BLOCKED_NO_PERMISSION
  if (!unrestricted) return ROLE_WRITE_BLOCKED_NOT_UNRESTRICTED
  if (isPresetRole(role)) return ROLE_PRESET_BLOCKED
  if (usesLegacy(role)) return '这是旧版角色（权限点沿用旧体系），不能直接修改；请复制为自定义角色后再改'
  const lacks = permissionsActorLacks(actorPermissions, rolePermissionKeys(role))
  return lacks.length > 0 ? '这个角色包含你自己没有的权限点，不能由你修改' : null
}

export function roleEditorViewOf(role: RoleWithFields, counts: { members: number; invitations: number }, actorPermissions: readonly string[], unrestricted: boolean): RoleEditorView {
  const block = roleEditBlock(role, actorPermissions, unrestricted)
  return {
    ...roleSummaryOf(role),
    presetKey: isPresetRole(role) && role.id.startsWith('preset-') ? role.id.slice('preset-'.length) : null,
    version: role.version,
    memberCount: counts.members,
    invitationCount: counts.invitations,
    canEdit: block === null,
    editBlockedReason: block,
  }
}

/** 审计快照：名称、说明、权限点（排序后）、字段三档；修改前后同形，差异由审计写入器算。 */
export const roleSnapshot = (role: RoleWithFields) => ({
  name: role.name,
  description: role.description,
  permissions: [...rolePermissionKeys(role)].sort(),
  fields: roleFieldsOf(role),
})
