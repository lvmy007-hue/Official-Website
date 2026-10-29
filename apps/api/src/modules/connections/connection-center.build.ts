import {
  BRAND_EVIDENCE_SOURCES,
  CONNECTION_KINDS,
  CONNECTION_KIND_LABEL,
  CONNECTION_STATE_LABEL,
  DERIVED_STATE_LABEL,
  HEALTH_STATUS_LABEL,
  ROLE_COMPARISON_BASIS,
  ROLE_MODULES,
  connectionActionStates,
  connectionFailureText,
  derivedEvidenceOf,
  evaluateRoleModules,
  evaluateRoles,
  healthStatusOf,
  tokenExpiryOf,
  type ConnectionCenterResponse,
  type ConnectionKind,
  type ConnectionRow,
  type ConnectionState,
  type ConnectionTone,
  type DerivedEvidence,
  type EvidenceRow,
  type HealthCheckItem,
  type HealthStatus,
} from '@nova/api-contracts'

// 连接中心的组装（P5-04）：把查出来的连接、店铺、广告账户与数据新鲜度组装成页面要的响应。纯函数，不碰数据库，便于直接用样例数据测试。

export interface ConnectionInput {
  id: string
  provider: string
  state: string
  externalAccountId: string | null
  refreshTokenUpdatedAt: Date | null
  grantedScopes: unknown
  lastSuccessfulSyncAt: Date | null
  lastErrorCode: string | null
  sellerAccountId: string | null
  sellerAccount: { id: string; displayName: string; sellerId: string; legalEntityName: string | null } | null
  adsProfile: { displayName: string | null; profileId: string; sellerAccountId: string | null } | null
  health: { status: string; checks: unknown; checkedAt: Date } | null
  /** 是否保存了刷新令牌（只给是否，永远不把密文读进来）。 */
  hasToken: boolean
}

export interface CenterInput {
  now: Date
  connections: readonly ConnectionInput[]
  truncated: boolean
  stores: readonly { id: string; displayName: string; sellerId: string }[]
  adsProfiles: readonly { bindingStatus: string; legalEntityName: string | null }[]
  /** 连接 → 最近一次授权完成的成员名、发起授权时选的法律主体（授权未完成时授权主体只能取它）。 */
  authorizers: ReadonlyMap<string, { authorizedBy: string | null; legalEntityName: string | null }>
  evidence: readonly EvidenceRow[]
  tokenAge: { maxAgeDays: number | null; warnDays: number }
  scope: { unrestricted: boolean; sellerAccountIds: readonly string[] }
  canManage: boolean
  legalEntities: readonly { id: string; name: string }[]
}

export const BLOCKED_NO_PERMISSION = '没有“管理连接”权限（企业所有者与管理员有）'
const BLOCKED_NO_STORE = '这个连接没有归属店铺，需要“全部店铺”数据范围才能操作'
const BLOCKED_OUT_OF_SCOPE = '这个连接的店铺不在你的数据范围内'
const PENDING_NOTE = '授权在 10 分钟内没有完成就会作废，可以重新发起授权'
const REPORT_SOURCES: readonly string[] = ROLE_MODULES.flatMap(item => item.sourceKeys).filter(key => key.startsWith('rpt.') && !BRAND_EVIDENCE_SOURCES.includes(key))

const stateOf = (value: string): ConnectionState => (value in CONNECTION_STATE_LABEL ? (value as ConnectionState) : 'NOT_CONFIGURED')
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const CHECK_KEYS: readonly string[] = ['token', 'api', 'marketplace']

/** 健康记录里的检查项：只认结构正确的，被改坏的记录不让页面报错。 */
export function checksOf(value: unknown): HealthCheckItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): HealthCheckItem[] => {
    const item = (entry ?? {}) as Record<string, unknown>
    if (typeof item.key !== 'string' || !CHECK_KEYS.includes(item.key) || typeof item.label !== 'string') return []
    return [{ key: item.key as HealthCheckItem['key'], label: item.label, ok: typeof item.ok === 'boolean' ? item.ok : null, message: typeof item.message === 'string' ? item.message : null }]
  })
}

function blockedOf(input: CenterInput, storeId: string | null): string | null {
  if (!input.canManage) return BLOCKED_NO_PERMISSION
  if (input.scope.unrestricted) return null
  if (storeId === null) return BLOCKED_NO_STORE
  return input.scope.sellerAccountIds.includes(storeId) ? null : BLOCKED_OUT_OF_SCOPE
}

/** 授权类失败：令牌换不到、没有令牌、缺少应用凭据、没有美国站——这些都意味着接口用不了，需要人处理。 */
const AUTH_FAILURE = /^(AUTH_EXPIRED|SLR_NOT_US|(ADS_)?(LWA_TOKEN_FAILED|REFRESH_TOKEN_NOT_CONFIGURED|LWA_CONFIG_MISSING))/

/** 授权连接的颜色：授权失效、没有令牌与健康异常是红；其他失败或受限是黄；授权未完成是黄；已断开与未配置是灰。 */
export function toneOf(state: ConnectionState, health: HealthStatus | null, failureCode: string | null): ConnectionTone {
  if (state === 'EXPIRED') return 'error'
  if (state === 'AUTHORIZING') return 'warning'
  if (state !== 'AUTHORIZED') return 'default'
  if ((failureCode !== null && AUTH_FAILURE.test(failureCode)) || health === 'UNHEALTHY') return 'error'
  return failureCode || health === 'DEGRADED' ? 'warning' : 'success'
}

function connectionRow(input: CenterInput, connection: ConnectionInput): ConnectionRow {
  const ads = connection.provider === 'AMAZON_ADS_API'
  const kind: ConnectionKind = ads ? 'ADS' : 'SELLER'
  const state = stateOf(connection.state)
  const authorizer = input.authorizers.get(connection.id)
  const storeId = ads ? (connection.adsProfile?.sellerAccountId ?? null) : connection.sellerAccountId
  const store = connection.sellerAccount ? input.stores.find(item => item.id === connection.sellerAccount?.id) : undefined
  const health = connection.health ? healthStatusOf(connection.health.status) : null
  // 状态是已授权却没有令牌：数据和接口都用不了，按失败处理
  const failureCode = connection.lastErrorCode ?? (state === 'AUTHORIZED' && !connection.hasToken ? 'REFRESH_TOKEN_NOT_CONFIGURED' : null)
  const profileNames = [...new Set(input.adsProfiles.flatMap(profile => (profile.legalEntityName ? [profile.legalEntityName] : [])))]
  const unbound = input.adsProfiles.filter(profile => profile.bindingStatus === 'UNBOUND').length
  const accountLabel = ads
    ? connection.adsProfile
      ? `${connection.adsProfile.displayName ?? connection.adsProfile.profileId}（${connection.adsProfile.profileId}）`
      : `${input.adsProfiles.length} 个广告账户`
    : connection.sellerAccount
      ? `${connection.sellerAccount.displayName}（${connection.sellerAccount.sellerId}）`
      : '尚未取得卖家编号'
  const detail = ads
    ? input.adsProfiles.length > 0
      ? `广告账户 ${input.adsProfiles.length} 个，其中未绑定店铺 ${unbound} 个${unbound > 0 ? '（在下方“广告账户与店铺绑定”处理）' : ''}`
      : '还没有同步到广告账户，授权后会自动同步'
    : state === 'AUTHORIZING'
      ? PENDING_NOTE
      : null
  return {
    id: connection.id,
    kind,
    kindLabel: CONNECTION_KIND_LABEL[kind],
    connectionId: connection.id,
    provider: connection.provider,
    state,
    stateLabel: CONNECTION_STATE_LABEL[state],
    tone: toneOf(state, health, failureCode),
    subject: (ads ? profileNames.join('、') : (connection.sellerAccount?.legalEntityName ?? authorizer?.legalEntityName ?? null)) || null,
    authorizedBy: authorizer?.authorizedBy ?? null,
    accountLabel,
    accountId: ads ? (connection.adsProfile?.profileId ?? null) : (connection.externalAccountId ?? connection.sellerAccount?.sellerId ?? null),
    storeId,
    storeName: store?.displayName ?? connection.sellerAccount?.displayName ?? null,
    scopes: stringsOf(connection.grantedScopes),
    hasToken: connection.hasToken,
    health: connection.health
      ? { status: health ?? 'UNKNOWN', statusLabel: HEALTH_STATUS_LABEL[health ?? 'UNKNOWN'], checkedAt: connection.health.checkedAt.toISOString(), checks: checksOf(connection.health.checks) }
      : null,
    lastSuccessAt: connection.lastSuccessfulSyncAt?.toISOString() ?? null,
    failureCode,
    failureText: connectionFailureText(failureCode),
    tokenUpdatedAt: connection.hasToken ? (connection.refreshTokenUpdatedAt?.toISOString() ?? null) : null,
    tokenExpiry: tokenExpiryOf(connection.hasToken ? connection.refreshTokenUpdatedAt : null, input.tokenAge.maxAgeDays, input.tokenAge.warnDays, input.now),
    detail,
    actions: connectionActionStates({ state, hasToken: connection.hasToken }, blockedOf(input, storeId)),
  }
}

const DERIVED_TONE: Readonly<Record<DerivedEvidence['state'], ConnectionTone>> = { AVAILABLE: 'success', PARTIAL: 'warning', MISSING: 'warning', NOT_APPLICABLE: 'default', UNVERIFIED: 'default' }

function derivedRow(kind: 'REPORT_ROLE' | 'BRAND_ANALYTICS', store: { id: string; displayName: string; sellerId: string }, evidence: DerivedEvidence, subject: string | null): ConnectionRow {
  const { counts, total } = evidence
  const detail =
    kind === 'REPORT_ROLE'
      ? `${total} 类报告：${counts.ok} 类能取到，${counts.missing} 类缺少权限，${counts.unverified + counts.failed + counts.authExpired + counts.notApplicable} 类尚未取到或不适用`
      : evidence.state === 'NOT_APPLICABLE'
        ? '这家店没有品牌备案或品牌分析不适用，品牌分析、销售与流量、评论主题不会有数据；其他数据不受影响'
        : `${total} 个来源（品牌分析报告、销售与流量、评论主题）：${counts.ok} 个能取到，${counts.missing} 个缺少资格，${counts.unverified} 个尚未验证`
  return {
    id: `${kind}:${store.id}`,
    kind,
    kindLabel: CONNECTION_KIND_LABEL[kind],
    connectionId: null,
    provider: null,
    state: evidence.state,
    stateLabel: DERIVED_STATE_LABEL[evidence.state],
    tone: DERIVED_TONE[evidence.state],
    subject,
    authorizedBy: null,
    accountLabel: `${store.displayName}（${store.sellerId}）`,
    accountId: store.sellerId,
    storeId: store.id,
    storeName: store.displayName,
    scopes: [],
    hasToken: false,
    health: null,
    lastSuccessAt: evidence.lastSuccessAt?.toISOString() ?? null,
    failureCode: evidence.state === 'AVAILABLE' ? null : evidence.failureCode,
    failureText: evidence.state === 'AVAILABLE' ? null : connectionFailureText(evidence.failureCode),
    tokenUpdatedAt: null,
    tokenExpiry: null,
    detail,
    actions: null,
  }
}

/** 组装连接中心：先是卖家与广告授权连接，再是每个已授权店铺的“报告权限”与“品牌分析资格”，最后是角色对照。 */
export function buildConnectionCenter(input: CenterInput): ConnectionCenterResponse {
  const items: ConnectionRow[] = input.connections.map(connection => connectionRow(input, connection))
  const live = input.connections.filter(connection => connection.provider === 'AMAZON_SP_API' && connection.state === 'AUTHORIZED' && connection.sellerAccount)
  const liveStores = [...new Map(live.flatMap(connection => (connection.sellerAccount ? [[connection.sellerAccount.id, connection.sellerAccount] as const] : []))).values()]
  const byStore = new Map<string, EvidenceRow[]>()
  for (const row of input.evidence) if (row.sellerAccountId) byStore.set(row.sellerAccountId, [...(byStore.get(row.sellerAccountId) ?? []), row])
  for (const kind of ['REPORT_ROLE', 'BRAND_ANALYTICS'] as const) {
    for (const store of liveStores) {
      const rows = byStore.get(store.id) ?? []
      items.push(derivedRow(kind, store, derivedEvidenceOf(kind === 'REPORT_ROLE' ? REPORT_SOURCES : BRAND_EVIDENCE_SOURCES, rows), store.legalEntityName))
    }
  }
  const modules = evaluateRoleModules(
    liveStores.map(store => store.id),
    input.evidence,
  )
  const byKind = Object.fromEntries(CONNECTION_KINDS.map(kind => [kind, items.filter(item => item.kind === kind).length])) as Record<ConnectionKind, number>
  return {
    items,
    summary: {
      total: items.length,
      byKind,
      authorized: items.filter(item => item.connectionId && item.state === 'AUTHORIZED').length,
      attention: items.filter(item => item.tone === 'error' || item.tone === 'warning').length,
    },
    roles: { roles: evaluateRoles(modules), modules, basis: ROLE_COMPARISON_BASIS, storeCount: liveStores.length },
    legalEntities: input.canManage ? input.legalEntities.map(entity => ({ id: entity.id, name: entity.name })) : [],
    canManage: input.canManage,
    manageBlockedReason: input.canManage ? null : BLOCKED_NO_PERMISSION,
    truncated: input.truncated,
  }
}
