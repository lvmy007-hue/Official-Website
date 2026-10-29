import { Injectable } from '@nestjs/common'
import {
  ROLE_ACTIONS,
  ROLE_CUSTOM_LIMIT,
  ROLE_EMPTY_PERMISSIONS,
  ROLE_FIELD_KEYS,
  ROLE_MANAGE,
  ROLE_WRITE_BLOCKED_NOT_UNRESTRICTED,
  RoleCreateBodySchema,
  RoleUpdateBodySchema,
  separationConflicts,
  separationMessage,
  type RoleFields,
  type RoleFieldTier,
  type RoleSaveResult,
  type RolesResponse,
} from '@nova/api-contracts'
import { FIELD_META, PERMISSION_CATALOG, SEPARATION_OF_DUTIES, fieldPermission, ownerFieldPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, assertUnrestricted } from '../auth'
import { MemberSystemService, type RoleWithFields } from './member-system.service'
import { readerScope } from './members-common'
import { CATALOG_KEYS, isPresetRole, roleEditBlock, roleEditorViewOf, roleFieldsOf, rolePermissionKeys, roleSnapshot } from './roles-common'

const ALL_KEYS = PERMISSION_CATALOG.map(entry => entry.key)
const labelOf = (key: string) => PERMISSION_CATALOG.find(entry => entry.key === key)?.label.replace(/（.*$/, '') ?? key
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
const duplicateName = (name: string) => appError('CONFLICT', `角色名称“${name}”已存在`, { fieldErrors: { name: ['名称已被其他角色使用'] } })

const tierRows = (fields: RoleFields) => ROLE_FIELD_KEYS.map(fieldKey => ({ fieldKey, allowed: fields[fieldKey] !== 'HIDDEN', ownerOnly: fields[fieldKey] === 'OWNER_ONLY' }))

/** 权限点校验：不含通配、都在权限目录里、不违反职责分离、每一项操作者自己都有。 */
function checkPermissions(actorPermissions: readonly string[], keys: readonly string[]): string[] {
  const unique = [...new Set(keys)]
  if (unique.includes('*')) throw appError('VALIDATION_FAILED', '不能创建拥有全部权限的角色', { fieldErrors: { permissions: ['“全部权限”只属于企业所有者角色'] } })
  const unknown = unique.filter(key => !CATALOG_KEYS.has(key))
  if (unknown.length > 0)
    throw appError('VALIDATION_FAILED', `包含不认识的权限点：${unknown.slice(0, 5).join('、')}`, { fieldErrors: { permissions: [`不认识的权限点：${unknown.slice(0, 5).join('、')}`] } })
  if (unique.length === 0) throw appError('VALIDATION_FAILED', ROLE_EMPTY_PERMISSIONS, { fieldErrors: { permissions: [ROLE_EMPTY_PERMISSIONS] } })
  const conflicts = separationConflicts(unique, SEPARATION_OF_DUTIES)
  if (conflicts.length > 0) {
    const message = separationMessage(conflicts, labelOf)
    throw appError('VALIDATION_FAILED', message, { fieldErrors: { permissions: [message] }, details: { conflicts: conflicts.map(pair => pair.join('+')).join(',') } })
  }
  if (!actorPermissions.includes('*')) {
    const lacks = unique.filter(key => !actorPermissions.includes(key))
    if (lacks.length > 0)
      throw appError('TENANT_ACCESS_DENIED', `不能授予你自己没有的权限点：${lacks.slice(0, 5).join('、')}${lacks.length > 5 ? ` 等 ${lacks.length} 个` : ''}`, {
        details: { lacks: lacks.slice(0, 20).join(',') },
      })
  }
  return unique.sort()
}

/** 字段权限校验：买家信息没有“仅负责人可见”；给出可见或仅负责人可见的字段，操作者自己必须能看到。 */
function checkFields(actorPermissions: readonly string[], fields: RoleFields) {
  for (const field of ROLE_FIELD_KEYS) {
    const tier = fields[field]
    if (tier === 'OWNER_ONLY' && !FIELD_META[field].ownerOnlyAllowed)
      throw appError('VALIDATION_FAILED', `${FIELD_META[field].label}不支持“仅负责人可见”`, { fieldErrors: { [`fields.${field}`]: ['该字段不支持“仅负责人可见”'] } })
    if (tier === 'HIDDEN' || actorPermissions.includes('*')) continue
    if (!actorPermissions.includes(fieldPermission(field)) && !(tier === 'OWNER_ONLY' && actorPermissions.includes(ownerFieldPermission(field)))) {
      throw appError('TENANT_ACCESS_DENIED', `不能授予你自己看不到的字段：${FIELD_META[field].label}`, { details: { field } })
    }
  }
}

// 角色编辑器（P5-08，09 章 9.10）：列表、新建（可复制）、修改。预设角色与旧版角色不可改，只能复制为自定义角色。
// 修改用角色的权限版本号做乐观锁，每次修改版本加一（同时让权限缓存失效）。
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly system: MemberSystemService,
  ) {}

  async list(req: RequestWithContext, now = new Date()): Promise<RolesResponse> {
    const { context, unrestricted } = await readerScope(this.context, req, ROLE_MANAGE)
    const tenantId = context.tenantId
    const [roles, members, invitations] = await Promise.all([
      this.system.roles(tenantId),
      this.prisma.membership.groupBy({ by: ['roleId'], where: { tenantId }, _count: { _all: true }, orderBy: { roleId: 'asc' } }),
      this.prisma.memberInvitation.groupBy({ by: ['roleId'], where: { tenantId, status: 'PENDING', expiresAt: { gt: now } }, _count: { _all: true }, orderBy: { roleId: 'asc' } }),
    ])
    const memberCount = new Map(members.map(group => [group.roleId, group._count._all]))
    const invitationCount = new Map(invitations.map(group => [group.roleId, group._count._all]))
    const items = roles.map(role => roleEditorViewOf(role, { members: memberCount.get(role.id) ?? 0, invitations: invitationCount.get(role.id) ?? 0 }, context.permissions, unrestricted))
    // 页面级的“能不能新建、修改角色”：已通过 role.manage 鉴权，所以只剩数据范围这一条（逐个角色的原因在每行的 editBlockedReason 里）
    const manageBlocked = unrestricted ? null : ROLE_WRITE_BLOCKED_NOT_UNRESTRICTED
    return { items, canManage: manageBlocked === null, manageBlockedReason: manageBlocked, customCount: roles.filter(role => !isPresetRole(role)).length, customLimit: ROLE_CUSTOM_LIMIT }
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<RoleSaveResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ROLE_MANAGE, {})
    assertUnrestricted(scope)
    const body = RoleCreateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const roles = await this.system.roles(tenantId)
    if (roles.filter(role => !isPresetRole(role)).length >= ROLE_CUSTOM_LIMIT) throw appError('DATA_CONDITION_FAILED', `自定义角色最多 ${ROLE_CUSTOM_LIMIT} 个，请先整理不用的角色`)
    const base = body.copyFromRoleId ? roles.find(role => role.id === body.copyFromRoleId) : undefined
    if (body.copyFromRoleId && !base) throw appError('VALIDATION_FAILED', '要复制的角色不存在', { fieldErrors: { copyFromRoleId: ['要复制的角色不存在'] } })
    const basePermissions = base ? (rolePermissionKeys(base).includes('*') ? ALL_KEYS : rolePermissionKeys(base)) : []
    const permissions = checkPermissions(context.permissions, body.permissions ?? basePermissions)
    const fields: RoleFields = { ...(base ? roleFieldsOf(base) : { cost: 'HIDDEN', profit: 'HIDDEN', buyer: 'HIDDEN' }), ...stripUndefined(body.fields) }
    checkFields(context.permissions, fields)
    this.assertNameFree(roles, body.name)
    try {
      const created = await this.prisma.$transaction(async tx => {
        const role = await tx.role.create({
          data: { tenantId, name: body.name, description: body.description || null, permissions, resourceScope: {}, version: 2, fieldPermissions: { create: tierRows(fields) } },
          include: { fieldPermissions: { select: { fieldKey: true, allowed: true, ownerOnly: true } } },
        })
        await this.audit.record(req, { action: ROLE_ACTIONS.created, resourceType: 'Role', resourceId: role.id, after: { ...roleSnapshot(role), copiedFrom: base ? base.name : null } }, { client: tx })
        return role
      })
      return { role: roleEditorViewOf(created, { members: 0, invitations: 0 }, context.permissions, true), changed: true }
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName(body.name)
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<RoleSaveResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ROLE_MANAGE, {})
    assertUnrestricted(scope)
    const { version, reason, ...changes } = RoleUpdateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const roles = await this.system.roles(tenantId)
    const before = roles.find(role => role.id === id)
    if (!before) throw appError('RESOURCE_NOT_FOUND', '角色不存在')
    const block = roleEditBlock(before, context.permissions, true)
    if (block) throw appError('DATA_CONDITION_FAILED', block)

    const permissions = changes.permissions ? checkPermissions(context.permissions, changes.permissions) : [...rolePermissionKeys(before)].sort()
    const fields: RoleFields = { ...roleFieldsOf(before), ...stripUndefined(changes.fields) }
    checkFields(context.permissions, fields)
    const name = changes.name ?? before.name
    const description = changes.description !== undefined ? changes.description || null : before.description
    if (name !== before.name) this.assertNameFree(roles, name, id)
    const unchanged =
      name === before.name &&
      description === before.description &&
      permissions.join('\n') === [...rolePermissionKeys(before)].sort().join('\n') &&
      ROLE_FIELD_KEYS.every(field => fields[field] === roleFieldsOf(before)[field])
    const counts = await this.counts(tenantId, id)
    if (unchanged) return { role: roleEditorViewOf(before, counts, context.permissions, true), changed: false }
    try {
      const after = await this.prisma.$transaction(async tx => {
        await updateWithVersion(tx.role, { id, tenantId }, version, { name, description, permissions }, { label: '角色' })
        for (const row of tierRows(fields)) {
          await tx.fieldPermission.upsert({
            where: { roleId_fieldKey: { roleId: id, fieldKey: row.fieldKey } },
            create: { roleId: id, ...row },
            update: { allowed: row.allowed, ownerOnly: row.ownerOnly },
          })
        }
        const fresh = await tx.role.findFirstOrThrow({ where: { id, tenantId }, include: { fieldPermissions: { select: { fieldKey: true, allowed: true, ownerOnly: true } } } })
        await this.audit.record(req, { action: ROLE_ACTIONS.updated, resourceType: 'Role', resourceId: id, before: roleSnapshot(before), after: roleSnapshot(fresh), reason }, { client: tx })
        return fresh
      })
      return { role: roleEditorViewOf(after, counts, context.permissions, true), changed: true }
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName(name)
      throw error
    }
  }

  private assertNameFree(roles: readonly RoleWithFields[], name: string, exceptId?: string) {
    if (roles.some(role => role.id !== exceptId && role.name.trim().toLowerCase() === name.trim().toLowerCase())) throw duplicateName(name)
  }

  private async counts(tenantId: string, roleId: string) {
    const [members, invitations] = await Promise.all([
      this.prisma.membership.count({ where: { tenantId, roleId } }),
      this.prisma.memberInvitation.count({ where: { tenantId, roleId, status: 'PENDING', expiresAt: { gt: new Date() } } }),
    ])
    return { members, invitations }
  }
}

function stripUndefined(fields: Partial<Record<keyof RoleFields, RoleFieldTier | undefined>> | undefined): Partial<RoleFields> {
  return Object.fromEntries(Object.entries(fields ?? {}).filter(([, value]) => value !== undefined)) as Partial<RoleFields>
}
