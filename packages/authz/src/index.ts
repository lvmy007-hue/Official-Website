import { PERMISSION_CATALOG } from './catalog'

export { PERMISSION_CATALOG, ROLE_KEYS } from './catalog'
export type { PermissionEntry, PermissionKind, RoleKey } from './catalog'

// 权限体系（P1-13，依据 11 章 11.1、freeze/permissions.md）。
// 权限点只表示“能不能做”；能看到哪些店铺由数据范围决定（P1-12）；成本、利润、买家信息另有字段权限。

/** 旧的 16 个权限点（保留识别 12 个月，见 LEGACY_SUNSET_DATE）。 */
export const PERMISSIONS = {
  ENTITY_READ: 'entity.read',
  ENTITY_WRITE: 'entity.write',
  SELLER_READ: 'seller.read',
  SELLER_WRITE: 'seller.write',
  CONNECTION_MANAGE: 'connection.manage',
  ORDERS_READ: 'orders.read',
  REFUNDS_READ: 'refunds.read',
  FINANCE_READ: 'finance.read',
  ADS_READ: 'ads.read',
  ADS_REPORT: 'ads.report',
  SYNC_MANAGE: 'sync.manage',
  EXPORT_CREATE: 'export.create',
  MEMBER_READ: 'member.read',
  MEMBER_INVITE: 'member.invite',
  ROLE_MANAGE: 'role.manage',
  AUDIT_READ: 'audit.read',
} as const

export const hasPermission = (permissions: readonly string[], required: string) => permissions.includes('*') || permissions.includes(required)

// ---- 基础权限：所有登录成员自动具备，仅作用于本人数据 ----

export const BASE_PERMISSIONS = ['my.workitems', 'my.exports', 'my.notifications', 'profile.manage', 'view.manage', 'metrics.read'] as const

// ---- 字段级敏感权限 ----

export const FIELD_KEYS = ['cost', 'profit', 'buyer'] as const
export type FieldKey = (typeof FIELD_KEYS)[number]
export const fieldPermission = (field: FieldKey) => `field.${field}`
export const FIELD_PERMISSIONS: readonly string[] = FIELD_KEYS.map(fieldPermission)

/** 当前权限集合是否可以看到该敏感字段（所有者的通配权限视为拥有）。 */
export const canSeeField = (permissions: readonly string[], field: FieldKey) => hasPermission(permissions, fieldPermission(field))

// ---- 旧 16 个权限的映射 ----

/** 旧点位保留识别的截止日期：迁移完成日（2026-10-21）起 12 个月，之后移除映射与识别。 */
export const LEGACY_SUNSET_DATE = '2027-10-21'

export const LEGACY_PERMISSION_MAP: Readonly<Record<string, readonly string[]>> = {
  'entity.read': ['entity.read'],
  'entity.write': ['entity.write'],
  'seller.read': ['products.read', 'inventory.read', 'inbound.read', 'purchase.read', 'supplier.read', 'warehouse.read', 'reports.read', 'connection.read', 'sync.read'],
  'seller.write': ['inbound.plan.write', 'purchase.order.write', 'reports.create'],
  'connection.manage': ['connection.manage', 'notifications.manage'],
  'orders.read': ['orders.read', 'returns.read'],
  'refunds.read': ['returns.read', 'reimbursements.read'],
  // 仅 finance.read 因历史上可见利润类数据而映射为 field.profit；旧体系没有成本与买家信息的概念，默认不放开。
  'finance.read': ['finance.read', 'profit.read', 'field.profit'],
  'ads.read': ['ads.read'],
  'ads.report': ['ads.report'],
  'sync.manage': ['sync.manage', 'sync.read'],
  'export.create': ['export.create'],
  'member.read': ['member.read'],
  'member.invite': ['member.invite'],
  'role.manage': ['role.manage', 'member.manage'],
  'audit.read': ['audit.read'],
}

export const LEGACY_PERMISSION_KEYS = Object.keys(LEGACY_PERMISSION_MAP)

/** 字段权限的显式设置（FieldPermission 表）：allowed 为假表示明确拒绝，优先于旧映射产生的字段权限。 */
export interface FieldGrant {
  fieldKey: FieldKey
  allowed: boolean
  /** 仅负责人可见（P5-08）：只有商品负责人能看到该商品的这类字段；allowed 为真时才有意义。 */
  ownerOnly?: boolean
}

/** 字段权限的三档：可见、仅负责人可见、不可见。 */
export type FieldTier = 'VISIBLE' | 'OWNER_ONLY' | 'HIDDEN'
export const FIELD_TIERS: readonly FieldTier[] = ['VISIBLE', 'OWNER_ONLY', 'HIDDEN']
export const fieldTierOf = (grant: { allowed: boolean; ownerOnly?: boolean } | null | undefined): FieldTier => (!grant || !grant.allowed ? 'HIDDEN' : grant.ownerOnly ? 'OWNER_ONLY' : 'VISIBLE')

/** “仅负责人可见”档位在有效权限里的标记：不等于 field.X，所以没有处理负责人的接口一律按“看不到”处理（宁可少给）。 */
export const ownerFieldPermission = (field: FieldKey) => `field.${field}.own`

/**
 * 针对某个具体对象（商品）：这个人是对象的负责人时，把“仅负责人可见”的字段权限升级成完整的字段权限。
 * 只在已经按负责人识别过对象的接口里调用（例如 ASIN 360 的各页签）。
 */
export function withOwnedFields(permissions: readonly string[]): string[] {
  if (permissions.includes('*')) return [...permissions]
  const result = new Set(permissions)
  for (const field of FIELD_KEYS) if (result.has(ownerFieldPermission(field))) result.add(fieldPermission(field))
  return [...result]
}

/**
 * 计算成员的有效权限点：
 * 角色保存的点位（含旧点位）→ 展开旧映射 → 加上基础权限 → 叠加字段权限显式设置。
 * 通配（所有者）原样保留，由 hasPermission 判定为拥有一切。旧点位本身仍保留在结果里。
 */
export function effectivePermissions(
  stored: readonly string[],
  fieldGrants: readonly FieldGrant[] = [],
  /**
   * 是否按旧映射展开（默认是，仅限尚未迁移的旧角色）。
   * 迁移后的角色（权限版本 2 起）保存的就是新体系点位，以 FieldPermission 为准：
   * finance.read 等点位名称与旧点位重名，若再展开会凭空多出利润读取与利润字段权限。
   */
  options: { legacy?: boolean } = {},
): string[] {
  const result = new Set<string>(stored)
  if (options.legacy ?? true) for (const key of stored) for (const mapped of LEGACY_PERMISSION_MAP[key] ?? []) result.add(mapped)
  for (const base of BASE_PERMISSIONS) result.add(base)
  for (const grant of fieldGrants) {
    const key = fieldPermission(grant.fieldKey)
    if (grant.allowed && grant.ownerOnly) {
      result.delete(key)
      result.add(ownerFieldPermission(grant.fieldKey))
    } else if (grant.allowed) result.add(key)
    else result.delete(key)
  }
  return [...result]
}

// ---- 权限点校验 ----

// 首次使用时才建集合：前端首屏只用 hasPermission 等判断，不用权限清单，模块顶层不求值才能让构建把清单整体摇掉（首屏预算）。
let known: Set<string> | undefined
const KNOWN = {
  has: (key: string) => (known ??= new Set<string>(['*', ...PERMISSION_CATALOG.map(entry => entry.key), ...FIELD_PERMISSIONS, ...BASE_PERMISSIONS, ...LEGACY_PERMISSION_KEYS])).has(key),
}

export const isKnownPermission = (key: string) => KNOWN.has(key)

/** 编辑角色时校验：返回不认识的权限点（空数组表示全部合法）。 */
export const unknownPermissions = (keys: readonly string[]) => keys.filter(key => !KNOWN.has(key))

// ---- 职责分离约束（后端强制，自定义角色同样适用）----

/** 创建/录入与审批必须由不同的人完成的权限对：[发起动作, 审批动作]。 */
export const SEPARATION_OF_DUTIES: readonly (readonly [string, string])[] = [
  ['purchase.order.write', 'purchase.order.approve'],
  ['warehouse.stockcount.write', 'warehouse.stockcount.approve'],
  ['finance.policy.write', 'finance.policy.write'],
]

// ---- 导出与响应过滤：按字段权限生成可见字段集合 ----

/** 返回该权限集合可见的敏感字段键，供导出任务与序列化层使用。 */
export const visibleFields = (permissions: readonly string[]): FieldKey[] => FIELD_KEYS.filter(field => canSeeField(permissions, field))

export * from './platform'
export * from './permission-tree'
export * from './presets'
