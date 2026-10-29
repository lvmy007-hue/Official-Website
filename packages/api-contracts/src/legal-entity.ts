// 法律主体契约（P5-07，09 章 9.9；freeze/api.md `/entities*`）。
// 本文件只放常量、标签、纯函数与响应类型，没有 zod（前端首屏路径可以安全引用）；请求体与查询参数的校验在 legal-entity-query.ts，创建主体沿用 core-schemas.ts 的 LegalEntityCreateSchema。

export const ENTITY_READ = 'entity.read'
export const ENTITY_WRITE = 'entity.write'
/** 详情里“被授权成员”一节需要的权限；没有时该节显示“无权查看”，不显示空列表。 */
export const ENTITY_MEMBERS_PERMISSION = 'member.read'

export const LEGAL_ENTITY_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type LegalEntityStatus = (typeof LEGAL_ENTITY_STATUSES)[number]
export const LEGAL_ENTITY_STATUS_LABEL: Record<LegalEntityStatus, string> = { ACTIVE: '使用中', INACTIVE: '已停用' }

export const LEGAL_ENTITY_ACTIONS = { created: 'LEGAL_ENTITY_CREATED', updated: 'LEGAL_ENTITY_UPDATED' } as const
export const LEGAL_ENTITY_ACTION_LABEL: Record<string, string> = { LEGAL_ENTITY_CREATED: '新增主体', LEGAL_ENTITY_UPDATED: '修改资料' }

/** 详情各区块的行数上限；超过时接口标记 truncated，页面提示“只显示前 N 条”。 */
export const ENTITY_STORE_LIMIT = 200
export const ENTITY_ADS_ACCOUNT_LIMIT = 200
export const ENTITY_MEMBER_LIMIT = 200
export const ENTITY_CHANGE_LIMIT = 50

export const ENTITY_FIELDS = ['name', 'registeredCountry', 'registrationNo', 'status'] as const
export type EntityField = (typeof ENTITY_FIELDS)[number]
export const ENTITY_FIELD_LABEL: Record<EntityField, string> = { name: '主体名称', registeredCountry: '注册地', registrationNo: '注册号', status: '状态' }

export const ENTITY_ACCESS_KINDS = ['ALL', 'ENTITY', 'STORES'] as const
export type EntityAccessKind = (typeof ENTITY_ACCESS_KINDS)[number]
export const ENTITY_ACCESS_LABEL: Record<EntityAccessKind, string> = { ALL: '全部主体与店铺', ENTITY: '整个主体', STORES: '指定店铺' }

export const ENTITY_WRITE_BLOCKED_NO_PERMISSION = '没有“新增、修改法律主体”权限（企业所有者与管理员有）'
export const ENTITY_WRITE_BLOCKED_NOT_UNRESTRICTED = '新增或修改法律主体会影响企业全部店铺，需要“全部店铺”数据范围'

export interface LegalEntityRow {
  id: string
  name: string
  registeredCountry: string
  registrationNo: string | null
  status: string
  /** 乐观锁版本号：修改时原样带回。 */
  version: number
  /** 当前账号数据范围内的店铺数与广告账户数；没有就是 0 家，不是“未知”。 */
  storeCount: number
  adsAccountCount: number
  createdAt: string
}

export interface LegalEntityListResponse {
  items: LegalEntityRow[]
  total: number
  page: number
  pageSize: number
  /** 各状态的主体数（全部符合数据范围的主体，不受筛选与分页影响）。 */
  summary: { total: number; active: number; inactive: number }
  canWrite: boolean
  writeBlockedReason: string | null
}

export interface EntityStoreView {
  id: string
  displayName: string
  sellerId: string
  logicalRegion: string
  /** 卖家授权连接的状态；没有连接记录为 null。 */
  connectionState: string | null
}

export interface EntityAdsAccountView {
  /** 广告档案编号（AdsProfile.id）。 */
  id: string
  displayName: string
  profileId: string
  countryCode: string
  status: string
  bindingStatus: string
  storeName: string | null
}

export interface EntityMemberView {
  membershipId: string
  name: string
  email: string
  roleName: string
  status: string
  access: EntityAccessKind
  /** access 为 STORES 时，该成员在本主体下被授权的店铺名。 */
  storeNames: string[]
}

export interface EntityChangeItem {
  field: EntityField
  label: string
  before: string | null
  after: string | null
}

export interface EntityChangeView {
  id: string
  occurredAt: string
  actor: string
  action: string
  actionLabel: string
  reason: string | null
  changes: EntityChangeItem[]
}

export interface LegalEntityDetail {
  entity: LegalEntityRow & { updatedAt: string }
  stores: EntityStoreView[]
  storesTruncated: boolean
  adsAccounts: EntityAdsAccountView[]
  adsAccountsTruncated: boolean
  /** RESTRICTED：没有成员查看权限，items 恒为空，页面显示“无权查看”。 */
  members: { state: 'OK' | 'RESTRICTED'; items: EntityMemberView[]; truncated: boolean }
  changes: EntityChangeView[]
  canWrite: boolean
  writeBlockedReason: string | null
  /** 停用的前置条件：名下没有店铺。canDeactivate 为 false 时 deactivateBlockedReason 写明原因。 */
  canDeactivate: boolean
  deactivateBlockedReason: string | null
}

export interface LegalEntityUpdateResult {
  entity: LegalEntityRow
  changed: boolean
}

/** 停用前置条件：名下还有店铺时不能停用（店铺的授权、同步与数据都挂在主体下）。 */
export function entityDeactivateBlockReason(storeCount: number): string | null {
  return storeCount > 0 ? `名下还有 ${storeCount} 个店铺，请先处理这些店铺后再停用主体` : null
}

export const entityStatusLabel = (status: string): string => LEGAL_ENTITY_STATUS_LABEL[status as LegalEntityStatus] ?? status

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

function displayOf(field: EntityField, value: unknown): string | null {
  const text = textOf(value)
  return field === 'status' && text ? entityStatusLabel(text) : text
}

/**
 * 从审计的修改前后快照里取出主体资料的变化。快照可能为空或缺字段（旧记录、被拒绝的请求），
 * 只比较两边都能读到的四个字段；新增主体没有“修改前”，每个有值的字段都算一项变化（修改前为空）。
 */
export function entityChangesOf(beforeJson: unknown, afterJson: unknown): EntityChangeItem[] {
  const read = (json: unknown): Record<string, unknown> | null => (json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null)
  const before = read(beforeJson)
  const after = read(afterJson)
  if (!after) return []
  const items: EntityChangeItem[] = []
  for (const field of ENTITY_FIELDS) {
    if (!(field in after)) continue
    const next = displayOf(field, after[field])
    const previous = before ? displayOf(field, before[field]) : null
    if (before && !(field in before)) continue
    if (previous === next) continue
    items.push({ field, label: ENTITY_FIELD_LABEL[field], before: previous, after: next })
  }
  return items
}

export interface EntityGrant {
  legalEntityId: string | null
  sellerAccountId: string | null
}

/**
 * 一个成员的数据范围授权对某个主体意味着什么：
 * 全空 = 全部主体与店铺；只有主体且是本主体 = 整个主体；有店铺且店铺在本主体名下 = 指定店铺；其余与本主体无关返回 null。
 * 整个主体或全部范围覆盖了指定店铺，所以优先级是 ALL、ENTITY、STORES。
 */
export function entityAccessOf(grants: readonly EntityGrant[], entityId: string, entityStoreIds: ReadonlySet<string>): { kind: EntityAccessKind; storeIds: string[] } | null {
  if (grants.some(grant => !grant.legalEntityId && !grant.sellerAccountId)) return { kind: 'ALL', storeIds: [] }
  if (grants.some(grant => grant.legalEntityId === entityId && !grant.sellerAccountId)) return { kind: 'ENTITY', storeIds: [] }
  const stores = [...new Set(grants.flatMap(grant => (grant.sellerAccountId && entityStoreIds.has(grant.sellerAccountId) ? [grant.sellerAccountId] : [])))]
  return stores.length > 0 ? { kind: 'STORES', storeIds: stores } : null
}
