import type { RoleSummary } from './roles.js'

// 成员契约（P5-08，09 章 9.10；freeze/api.md `/members*`）。
// 本文件只放常量、标签、纯函数与响应类型，没有 zod（前端首屏路径可以安全引用）；请求体与查询参数在 members-query.ts。

export const MEMBER_READ = 'member.read'
export const MEMBER_INVITE = 'member.invite'
export const MEMBER_MANAGE = 'member.manage'
export const ROLE_MANAGE = 'role.manage'
export const AUDIT_READ = 'audit.read'
/** 再次验证身份的动作名（write.ts 的 STEP_UP_ACTIONS）。 */
export const MEMBER_STEP_UP = 'member.manage'
export const ROLE_STEP_UP = 'role.manage'

export const MEMBER_STATUSES = ['ACTIVE', 'DISABLED'] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]
export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = { ACTIVE: '使用中', DISABLED: '已停用' }
export const memberStatusLabel = (status: string): string => MEMBER_STATUS_LABEL[status as MemberStatus] ?? status

export const MEMBER_ACTIONS = {
  invited: 'MEMBER_INVITED',
  disabled: 'MEMBER_DISABLED',
  enabled: 'MEMBER_ENABLED',
  roleChanged: 'MEMBER_ROLE_CHANGED',
  scopesChanged: 'MEMBER_SCOPES_CHANGED',
} as const
export const ROLE_ACTIONS = { created: 'ROLE_CREATED', updated: 'ROLE_UPDATED' } as const
export const MEMBER_ACTION_LABEL: Record<string, string> = {
  MEMBER_INVITED: '邀请成员',
  MEMBER_INVITATION_ACCEPTED: '接受邀请',
  FIRST_ADMIN_ACTIVATED: '首个管理员激活',
  MEMBER_DISABLED: '停用成员',
  MEMBER_ENABLED: '恢复成员',
  MEMBER_ROLE_CHANGED: '修改角色',
  MEMBER_SCOPES_CHANGED: '修改数据范围',
  ROLE_CREATED: '新建角色',
  ROLE_UPDATED: '修改角色',
}
export const memberActionLabel = (action: string): string => MEMBER_ACTION_LABEL[action] ?? action

/** 各区块的行数上限；超过时接口标记 truncated，页面提示“只显示前 N 条”。 */
export const MEMBER_LIST_LIMIT = 200
export const MEMBER_INVITATION_LIMIT = 100
export const MEMBER_SESSION_LIMIT = 30
export const MEMBER_AUDIT_LIMIT = 50
/** 邀请的有效期与预设所有者角色编号。 */
export const OWNER_ROLE_ID = 'preset-owner'

/** 成员数据范围的概括：全部、指定主体、指定店铺、两者都有、未授权。 */
export const SCOPE_KINDS = ['ALL', 'ENTITIES', 'STORES', 'MIXED', 'NONE'] as const
export type ScopeKind = (typeof SCOPE_KINDS)[number]
export const SCOPE_KIND_LABEL: Record<ScopeKind, string> = { ALL: '全部主体与店铺', ENTITIES: '指定主体', STORES: '指定店铺', MIXED: '指定主体与店铺', NONE: '尚未授权' }

export interface ScopeGrantInput {
  legalEntityId: string | null
  sellerAccountId: string | null
}

/** 由授权记录算出范围种类：任一行两列都空即“全部”；只有主体行、只有店铺行、两者都有。 */
export function scopeKindOf(grants: readonly ScopeGrantInput[]): ScopeKind {
  if (grants.length === 0) return 'NONE'
  if (grants.some(grant => !grant.legalEntityId && !grant.sellerAccountId)) return 'ALL'
  const hasEntity = grants.some(grant => grant.legalEntityId && !grant.sellerAccountId)
  const hasStore = grants.some(grant => grant.sellerAccountId)
  return hasEntity && hasStore ? 'MIXED' : hasEntity ? 'ENTITIES' : 'STORES'
}

export interface MemberScopeSummary {
  kind: ScopeKind
  label: string
  entityNames: string[]
  storeNames: string[]
}

/** 范围的一句话：指定主体与店铺时带上名字（最多列 3 个，其余写“等 N 个”）。 */
export function scopeLabelOf(kind: ScopeKind, entityNames: readonly string[], storeNames: readonly string[]): string {
  const names = [...entityNames, ...storeNames]
  if (kind === 'ALL' || kind === 'NONE' || names.length === 0) return SCOPE_KIND_LABEL[kind]
  const shown = names.slice(0, 3).join('、')
  return `${SCOPE_KIND_LABEL[kind]}：${shown}${names.length > 3 ? `等 ${names.length} 个` : ''}`
}

/** 邀请与修改数据范围的请求体形态（members-query.ts 的校验结果与它同形）。 */
export interface ScopeInput {
  all: boolean
  legalEntityIds: string[]
  sellerAccountIds: string[]
}

export const SCOPE_EMPTY_MESSAGE = '请选择“全部主体与店铺”，或至少选一个主体或店铺；没有任何授权的成员看不到任何数据'

/** 范围请求体的内在一致性：全部与具体列表二选一，具体列表至少一项。返回问题文字，没问题返回 null。 */
export function scopeInputProblem(input: ScopeInput): string | null {
  const specific = input.legalEntityIds.length + input.sellerAccountIds.length
  if (input.all && specific > 0) return '选了“全部主体与店铺”就不要再选具体的主体或店铺'
  if (!input.all && specific === 0) return SCOPE_EMPTY_MESSAGE
  return null
}

// ---- 无权限提示（CR-096：统一写明缺哪个权限点，并指向角色编辑器）----

export const PERMISSION_ADMIN_HINT = '请联系企业管理员在“成员与角色”的角色编辑器里为你的角色开通该权限点'
export const permissionDeniedMessage = (permission: string): string => `缺少权限点 ${permission}。${PERMISSION_ADMIN_HINT}`

// ---- 写入前置条件 ----

export const MEMBER_WRITE_BLOCKED_NO_PERMISSION = '没有“停用成员、修改角色、授权数据范围”权限（企业所有者与管理员有）'
export const MEMBER_INVITE_BLOCKED_NO_PERMISSION = '没有“邀请成员”权限（企业所有者与管理员有）'
export const MEMBER_WRITE_BLOCKED_NOT_UNRESTRICTED = '管理成员会影响企业全部数据，需要“全部店铺”数据范围'
export const MEMBER_SELF_BLOCKED = '不能修改自己的账号：请另一位管理员操作，避免把自己锁在门外'
export const LAST_OWNER_BLOCKED = '企业必须保留至少一位使用中的所有者：请先指定另一位所有者'

/**
 * 不能授予自己没有的权限：把角色分配给别人（或创建、编辑角色）时，角色里的每个权限点操作者自己都必须拥有；
 * 通配角色（所有者）只有通配持有人能授予。返回操作者缺少的权限点（空数组表示可以授予）。
 */
export function permissionsActorLacks(actorPermissions: readonly string[], granted: readonly string[]): string[] {
  const actorWildcard = actorPermissions.includes('*')
  if (granted.includes('*')) return actorWildcard ? [] : ['*']
  return granted.filter(key => !actorWildcard && !actorPermissions.includes(key))
}

export interface MemberRow {
  /** Membership.id */
  id: string
  userId: string
  name: string
  email: string
  status: string
  roleId: string
  roleName: string
  roleSystem: boolean
  scope: MemberScopeSummary
  /** 最近一次登录；从未登录过为 null（页面写“尚未登录”）。 */
  lastLoginAt: string | null
  createdAt: string
  isSelf: boolean
}

export interface MemberInvitationRow {
  id: string
  email: string
  roleName: string
  expiresAt: string
  invitedByName: string | null
  scopeLabel: string
  createdAt: string
}

export interface MemberListResponse {
  items: MemberRow[]
  total: number
  page: number
  pageSize: number
  /** 各状态人数（整个企业，不受筛选与分页影响）与待接受的邀请数。 */
  summary: { total: number; active: number; disabled: number; pendingInvitations: number }
  /** 角色筛选项：本企业能用的全部角色（含预设）。 */
  roles: { id: string; name: string }[]
  invitations: MemberInvitationRow[]
  canInvite: boolean
  inviteBlockedReason: string | null
  canManage: boolean
  manageBlockedReason: string | null
}

export interface MemberOption {
  status: string
  user: { id: string; displayName: string; email: string }
}

export interface MemberGrantView {
  id: string
  kind: 'ALL' | 'ENTITY' | 'STORE'
  /** 主体或店铺的编号（范围为“全部”时为 null），用来回填“修改数据范围”表单。 */
  refId: string | null
  name: string
  grantedAt: string
  note: string | null
}

export interface MemberSessionView {
  id: string
  loginAt: string
  lastSeenAt: string
  ipMasked: string | null
  device: string | null
  state: 'ACTIVE' | 'EXPIRED' | 'REVOKED'
}

export interface MemberAuditView {
  id: string
  occurredAt: string
  action: string
  actionLabel: string
  resourceType: string
  result: string
  /** 为真表示这个成员是操作人；为假表示别人对这个成员做的操作。 */
  asActor: boolean
  operator: string
  reason: string | null
}

export interface MemberDetail {
  member: MemberRow & { disabledAt: string | null; disabledReason: string | null }
  role: RoleSummary
  /** 修改角色时的可选项：本企业能用的全部角色（含预设）。 */
  roles: { id: string; name: string }[]
  grants: MemberGrantView[]
  /** 登录与会话记录：来自用户级的会话表，最多 MEMBER_SESSION_LIMIT 条登录。 */
  sessions: MemberSessionView[]
  sessionsTruncated: boolean
  /** RESTRICTED：没有审计查看权限（audit.read），items 恒为空。 */
  audit: { state: 'OK' | 'RESTRICTED'; items: MemberAuditView[]; truncated: boolean }
  canManage: boolean
  manageBlockedReason: string | null
  /** 各动作能不能做及原因（页面据此置灰并写原因）。 */
  actions: { disable: string | null; enable: string | null; role: string | null; scopes: string | null }
}

export interface InviteResult {
  invitationId: string
  email: string
  expiresAt: string
  /** 邮件通道未配置时，链接只在这次响应里出现一次，由管理员复制后交付；已发邮件则为 null。 */
  link: string | null
  emailed: boolean
  replacedPrevious: number
  /** 软提示（例如成员数将超过报价约定的人数）；不阻止邀请。 */
  warnings: string[]
}

export interface MemberChangeResult {
  member: MemberRow
  changed: boolean
}

// ---- 邀请与停用的行为约定 ----

export const INVITE_EMAIL_TAKEN = '该邮箱已经是本企业成员，或已注册了账号，暂不能再邀请；如需调整，请直接修改成员或联系对方登录后处理'
