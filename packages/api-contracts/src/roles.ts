// 角色编辑器契约（P5-08，09 章 9.10 与 CR-096 补充；freeze/api.md `/roles*`）。
// 只放常量、纯函数与响应类型，没有 zod；请求体校验在 members-query.ts。权限树（模块 → 页面 → 动作）在 @nova/authz 的 permission-tree.ts。

export const ROLE_FIELD_KEYS = ['cost', 'profit', 'buyer'] as const
export type RoleFieldKey = (typeof ROLE_FIELD_KEYS)[number]
export const ROLE_FIELD_TIERS = ['VISIBLE', 'OWNER_ONLY', 'HIDDEN'] as const
export type RoleFieldTier = (typeof ROLE_FIELD_TIERS)[number]
export const ROLE_FIELD_TIER_LABEL: Record<RoleFieldTier, string> = { VISIBLE: '可见', OWNER_ONLY: '仅负责人可见', HIDDEN: '不可见' }
export const ROLE_FIELD_TIER_NOTE: Record<RoleFieldTier, string> = {
  VISIBLE: '拥有该角色的成员能看到所有商品的这类字段',
  OWNER_ONLY: '成员只能看到自己担任负责人的商品的这类字段；其他列表与汇总页面不显示（见下方说明）',
  HIDDEN: '成员在任何页面、导出里都看不到这类字段',
}

export type RoleFields = Record<RoleFieldKey, RoleFieldTier>

export const ROLE_NAME_MAX = 40
export const ROLE_DESCRIPTION_MAX = 200
/** 一个企业最多的自定义角色数，防止误操作刷出海量角色。 */
export const ROLE_CUSTOM_LIMIT = 50

export const ROLE_PRESET_BLOCKED = '预设角色不能直接修改，请复制后再改（点“复制为自定义角色”）'
export const ROLE_WRITE_BLOCKED_NO_PERMISSION = '没有“创建、编辑角色”权限（企业所有者与管理员有）'
export const ROLE_WRITE_BLOCKED_NOT_UNRESTRICTED = '修改角色会影响全部成员，需要“全部店铺”数据范围'
export const ROLE_EMPTY_PERMISSIONS = '至少选择一个权限点；没有任何权限的角色没有意义'

export interface RoleSummary {
  id: string
  name: string
  system: boolean
  description: string | null
  /** 具体权限点；通配（所有者）为 ['*']。 */
  permissions: string[]
  fields: RoleFields
}

export interface RoleEditorView extends RoleSummary {
  /** 预设角色的键（owner、admin……）；自定义角色为 null。 */
  presetKey: string | null
  version: number
  memberCount: number
  /** 还没有接受的邀请里用了这个角色的数量。 */
  invitationCount: number
  canEdit: boolean
  editBlockedReason: string | null
}

export interface RolesResponse {
  items: RoleEditorView[]
  canManage: boolean
  manageBlockedReason: string | null
  /** 自定义角色数量与上限。 */
  customCount: number
  customLimit: number
}

export interface RoleSaveResult {
  role: RoleEditorView
  changed: boolean
}

/**
 * 职责分离：创建/录入与审批必须由不同的人完成。一个角色同时有“发起”和“审批”两个不同的点位时，持有人会自己批准自己的单，
 * 所以自定义角色不允许同时勾选。返回冲突的点位对（所有者与管理员两个预设角色不可编辑，不在此限）。
 */
export function separationConflicts(permissions: readonly string[], pairs: readonly (readonly [string, string])[]): [string, string][] {
  const set = new Set(permissions)
  return pairs.filter(([maker, checker]) => maker !== checker && set.has(maker) && set.has(checker)).map(([maker, checker]) => [maker, checker])
}

export const separationMessage = (conflicts: readonly [string, string][], labelOf: (key: string) => string): string =>
  `职责分离：${conflicts.map(([maker, checker]) => `“${labelOf(maker)}”与“${labelOf(checker)}”`).join('、')}不能放在同一个角色里，否则同一个人可以自己批准自己的单`
