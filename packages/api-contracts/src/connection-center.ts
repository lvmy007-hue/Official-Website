import { freshnessErrorMessage } from './freshness'
import { emptyCounts, evidenceOf, moduleStateOf, type EvidenceCounts, type EvidenceRow, type ModuleState, type RoleModuleView, type RoleView } from './connection-roles'

// 连接中心（P5-04，09 章 9.6；freeze/api.md /connections*）：四类连接、授权范围、健康检查、失败码、令牌更新时间与预计失效、动作规则。
// 本文件只放常量、标签与纯函数，没有 zod；断开连接的请求体用 write.ts 的 ReasonBodySchema。令牌永远不返回前端，接口只告诉页面“有没有令牌”。

export const CONNECTION_READ = 'connection.read'
export const CONNECTION_MANAGE = 'connection.manage'
/** 断开连接要再次验证身份（write.ts 的 STEP_UP_ACTIONS）。 */
export const CONNECTION_DISCONNECT_STEP_UP = 'connection.disconnect'
export const CONNECTION_ACTIONS = {
  healthCheckRequested: 'CONNECTION_HEALTH_CHECK_REQUESTED',
  reauthorizeStarted: 'CONNECTION_REAUTHORIZE_STARTED',
  disconnected: 'CONNECTION_DISCONNECTED',
} as const
/** 健康检查是后台任务（接口服务不能解密亚马逊令牌，只有后台任务能）。 */
export const CONNECTION_HEALTH_JOB = 'CONNECTION_HEALTH_CHECK'
/** 每个连接每天自动检查一次（卖家接口的 Sellers API 参与站点核对随它一起做，importers.md I-25）。 */
export const CONNECTION_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000
export const CONNECTION_LIST_LIMIT = 200
/** 预计失效提醒的提前天数默认值（与预警规则 SYS_AUTH_EXPIRING 的默认一致）。 */
export const TOKEN_WARN_DAYS_DEFAULT = 30
export const CONNECTION_ALERT_RULE_CODE = 'SYS_AUTH_EXPIRING'

export const CONNECTION_KINDS = ['SELLER', 'ADS', 'REPORT_ROLE', 'BRAND_ANALYTICS'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]
export const CONNECTION_KIND_LABEL: Readonly<Record<ConnectionKind, string>> = { SELLER: '卖家接口', ADS: '广告接口', REPORT_ROLE: '报告权限', BRAND_ANALYTICS: '品牌分析资格' }
export const CONNECTION_KIND_NOTE: Readonly<Record<ConnectionKind, string>> = {
  SELLER: '卖家授权（SP-API），订单、库存、财务等数据的入口',
  ADS: '广告授权（Amazon Ads API），广告账户与报表的入口',
  REPORT_ROLE: '各类报告能不能取到，按各报告最近一次同步结果判断',
  BRAND_ANALYTICS: '品牌备案与“品牌分析”角色，决定品牌分析、销售与流量、评论主题有没有数据',
}

/** 授权连接的状态（PlatformConnection.state）。 */
export const CONNECTION_STATES = ['NOT_CONFIGURED', 'AUTHORIZING', 'AUTHORIZED', 'EXPIRED', 'REVOKED'] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]
export const CONNECTION_STATE_LABEL: Readonly<Record<ConnectionState, string>> = {
  NOT_CONFIGURED: '未配置',
  AUTHORIZING: '授权未完成',
  AUTHORIZED: '已授权',
  EXPIRED: '授权已失效',
  REVOKED: '已断开',
}
/** 报告权限与品牌分析资格这两类“连接”的状态（由同步结果推断，不是授权状态）。 */
export const DERIVED_STATES = ['AVAILABLE', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE', 'UNVERIFIED'] as const
export type DerivedState = (typeof DERIVED_STATES)[number]
export const DERIVED_STATE_LABEL: Readonly<Record<DerivedState, string>> = {
  AVAILABLE: '已具备',
  PARTIAL: '部分具备',
  MISSING: '缺少角色',
  NOT_APPLICABLE: '不适用（无品牌备案）',
  UNVERIFIED: '尚未验证',
}
export type ConnectionTone = 'success' | 'warning' | 'error' | 'default'

export const HEALTH_STATUSES = ['HEALTHY', 'UNHEALTHY', 'DEGRADED', 'UNKNOWN'] as const
export type HealthStatus = (typeof HEALTH_STATUSES)[number]
export const HEALTH_STATUS_LABEL: Readonly<Record<HealthStatus, string>> = { HEALTHY: '正常', UNHEALTHY: '异常', DEGRADED: '受限或暂时无法判断', UNKNOWN: '尚未检查' }
export const healthStatusOf = (value: string | null | undefined): HealthStatus => ((HEALTH_STATUSES as readonly string[]).includes(value ?? '') ? (value as HealthStatus) : 'UNKNOWN')

/** 一次健康检查的一项：令牌换取、接口调用、美国站参与（卖家接口）。ok 为 null 表示因前一步失败没有检查。 */
export interface HealthCheckItem {
  key: 'token' | 'api' | 'marketplace'
  label: string
  ok: boolean | null
  message: string | null
}

// ---- 失败码 ----

const FAILURE_PREFIX: readonly (readonly [string, string])[] = [
  ['LWA_TOKEN_FAILED', '授权已失效或被撤销（刷新令牌换不到访问令牌），请重新授权'],
  ['ADS_LWA_TOKEN_FAILED', '授权已失效或被撤销（刷新令牌换不到访问令牌），请重新授权'],
  ['REFRESH_TOKEN_NOT_CONFIGURED', '这个连接没有保存刷新令牌，请重新授权'],
  ['ADS_REFRESH_TOKEN_NOT_CONFIGURED', '这个连接没有保存刷新令牌，请重新授权'],
  ['LWA_CONFIG_MISSING', '平台尚未配置亚马逊应用凭据，请联系平台运营'],
  ['ADS_LWA_CONFIG_MISSING', '平台尚未配置亚马逊广告应用凭据，请联系平台运营'],
  ['ADS_CLIENT_ID_MISSING', '平台尚未配置亚马逊广告应用凭据，请联系平台运营'],
  ['AWS_SIGV4_CREDENTIALS_MISSING', '平台尚未配置亚马逊接口签名凭据，请联系平台运营'],
  ['SP_API_403', '亚马逊拒绝访问：应用缺少所需角色或权限'],
  ['ADS_API_403', '亚马逊拒绝访问：应用缺少所需权限'],
  ['SP_API_401', '亚马逊拒绝访问：授权可能已失效，请重新授权'],
  ['ADS_API_401', '亚马逊拒绝访问：授权可能已失效，请重新授权'],
  ['SP_API_429', '亚马逊限流，稍后会自动重试'],
  ['ADS_API_429', '亚马逊限流，稍后会自动重试'],
  ['SP_API_5', '亚马逊服务暂时不可用，稍后会自动重试'],
  ['ADS_API_5', '亚马逊服务暂时不可用，稍后会自动重试'],
]
const FAILURE_EXACT: Readonly<Record<string, string>> = {
  SLR_NOT_US: '这个卖家账户没有参与美国站，本系统只支持美国站',
  CONNECTION_CHECK_FAILED: '健康检查没有完成，请稍后重试',
  CONNECTION_DISCONNECTED: '连接已被断开',
}

/** 失败码的中文说明：先认通用失败码，再认连接专有失败码与原始接口错误前缀，都不认识时说明“最近一次调用失败”。 */
export function connectionFailureText(code: string | null | undefined): string | null {
  if (!code) return null
  const exact = FAILURE_EXACT[code] ?? freshnessErrorMessage(code)
  if (exact && !exact.startsWith('同步失败，请稍后重试')) return exact
  const prefixed = FAILURE_PREFIX.find(([prefix]) => code.startsWith(prefix))
  return prefixed ? prefixed[1] : '最近一次调用失败，请先做一次健康检查；仍失败请重新授权或联系管理员'
}

/** 把调用亚马逊失败的错误归成失败码（健康检查用）：令牌换取失败＝授权失效；403＝缺角色；429 与 5xx＝暂时无法判断。 */
export function connectionHealthCodeOf(error: { source?: string; status?: number; message?: string }): string {
  if (error.source === 'lwa') return error.status !== undefined && error.status >= 500 ? 'UPSTREAM_ERROR' : error.status === 429 ? 'THROTTLE_EXHAUSTED' : 'AUTH_EXPIRED'
  const status = error.status
  if (status === 401) return 'AUTH_EXPIRED'
  if (status === 403) return 'ROLE_MISSING'
  if (status === 429) return 'THROTTLE_EXHAUSTED'
  if (status !== undefined && status >= 500) return 'UPSTREAM_ERROR'
  const message = error.message ?? ''
  if (/CONFIG_MISSING|CLIENT_ID_MISSING|CREDENTIALS_MISSING/.test(message)) return message.slice(0, 60)
  if (/REFRESH_TOKEN_NOT_CONFIGURED/.test(message)) return 'REFRESH_TOKEN_NOT_CONFIGURED'
  return 'CONNECTION_CHECK_FAILED'
}
/**
 * 健康检查结论：授权失效、缺少配置、没有美国站是“异常”（写入类操作会因此被拦住，见动作守卫）；
 * 限流、亚马逊暂时不可用、这一次调用缺角色只是“受限或暂时无法判断”——它不能证明其他接口不可用，不拦写入。
 */
export const healthStatusOfCode = (code: string | null): HealthStatus =>
  code === null ? 'HEALTHY' : code === 'THROTTLE_EXHAUSTED' || code === 'UPSTREAM_ERROR' || code === 'ROLE_MISSING' ? 'DEGRADED' : 'UNHEALTHY'

// ---- 令牌预计失效 ----

export const TOKEN_EXPIRY_STATES = ['NO_TOKEN', 'NOT_ESTIMATED', 'OK', 'SOON', 'PASSED'] as const
export type TokenExpiryState = (typeof TOKEN_EXPIRY_STATES)[number]
export interface TokenExpiry {
  state: TokenExpiryState
  expiresAt: string | null
  daysLeft: number | null
  basis: string
}
export const TOKEN_NOT_ESTIMATED_BASIS = '亚马逊没有公布固定的授权有效期，默认不推算；如需提前提醒，到预警规则“亚马逊授权失效或即将失效”里设置授权最长年龄'
const DAY_MS = 86_400_000

/** 从预警规则“亚马逊授权失效或即将失效”的阈值里读出授权最长年龄与提前提醒天数；不合法一律按默认（不推算、30 天）。取值范围与评估器一致。 */
export function tokenAgeParamsOf(conditionJson: unknown): { maxAgeDays: number | null; warnDays: number } {
  const params = ((conditionJson ?? {}) as { params?: Record<string, unknown> }).params ?? {}
  const clamp = (value: unknown, min: number, max: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null)
  return { maxAgeDays: clamp(params.tokenMaxAgeDays, 30, 3650), warnDays: clamp(params.warnBeforeDays, 1, 365) ?? TOKEN_WARN_DAYS_DEFAULT }
}

/** 预计失效：授权（换发令牌）时间加上预警规则里设置的授权最长年龄；没有设置年龄就不推算，只在授权失效时才提醒。 */
export function tokenExpiryOf(updatedAt: Date | null, maxAgeDays: number | null, warnDays: number, now: Date): TokenExpiry {
  if (!updatedAt) return { state: 'NO_TOKEN', expiresAt: null, daysLeft: null, basis: '没有令牌更新记录' }
  if (maxAgeDays === null) return { state: 'NOT_ESTIMATED', expiresAt: null, daysLeft: null, basis: TOKEN_NOT_ESTIMATED_BASIS }
  const expiresAt = new Date(updatedAt.getTime() + maxAgeDays * DAY_MS)
  const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS)
  const state: TokenExpiryState = daysLeft <= 0 ? 'PASSED' : daysLeft <= warnDays ? 'SOON' : 'OK'
  return { state, expiresAt: expiresAt.toISOString(), daysLeft, basis: `按预警规则设置的授权最长年龄 ${maxAgeDays} 天推算，不是亚马逊公布的有效期` }
}

// ---- 动作规则 ----

export interface ActionState {
  allowed: boolean
  reason: string | null
}
export interface ConnectionActionStates {
  healthCheck: ActionState
  reauthorize: ActionState
  disconnect: ActionState
}
const yes: ActionState = { allowed: true, reason: null }
const no = (reason: string): ActionState => ({ allowed: false, reason })

/** 一条授权连接能做哪些动作。blocked 是调用者层面的限制（没有管理权限、店铺不在数据范围内）。 */
export function connectionActionStates(input: { state: string; hasToken: boolean }, blocked: string | null): ConnectionActionStates {
  if (blocked) return { healthCheck: no(blocked), reauthorize: no(blocked), disconnect: no(blocked) }
  const revoked = input.state === 'REVOKED'
  return {
    healthCheck: revoked ? no('连接已断开，请先重新授权') : !input.hasToken ? no('这个连接还没有保存令牌，请先完成授权') : input.state === 'AUTHORIZING' ? no('授权还没有完成') : yes,
    reauthorize: yes,
    disconnect: revoked ? no('连接已经断开') : yes,
  }
}

// ---- 响应 ----

export interface ConnectionRow {
  /** 授权连接是连接编号；报告权限与品牌分析资格是“类型:店铺编号”。 */
  id: string
  kind: ConnectionKind
  kindLabel: string
  /** 可操作的授权连接编号；报告权限与品牌分析资格没有。 */
  connectionId: string | null
  provider: string | null
  state: string
  stateLabel: string
  tone: ConnectionTone
  /** 授权主体：法律主体名称。 */
  subject: string | null
  /** 点“同意授权”的成员（最近一次授权完成的那次）。 */
  authorizedBy: string | null
  /** 卖家编号或广告账户。 */
  accountLabel: string
  accountId: string | null
  storeId: string | null
  storeName: string | null
  scopes: string[]
  hasToken: boolean
  health: { status: HealthStatus; statusLabel: string; checkedAt: string | null; checks: HealthCheckItem[] } | null
  lastSuccessAt: string | null
  failureCode: string | null
  failureText: string | null
  tokenUpdatedAt: string | null
  tokenExpiry: TokenExpiry | null
  /** 补充说明（广告档案数量、报告权限的统计等）。 */
  detail: string | null
  actions: ConnectionActionStates | null
}

export interface ConnectionSummary {
  total: number
  byKind: Record<ConnectionKind, number>
  authorized: number
  /** 需要处理：授权失效、健康异常、缺少角色、授权未完成。 */
  attention: number
}

export interface ConnectionCenterResponse {
  items: ConnectionRow[]
  summary: ConnectionSummary
  roles: { roles: RoleView[]; modules: RoleModuleView[]; basis: string; storeCount: number }
  /** 发起授权可选的法律主体（只有能管理连接的人才有）。 */
  legalEntities: { id: string; name: string }[]
  canManage: boolean
  manageBlockedReason: string | null
  truncated: boolean
}

export interface ConnectionHealthRequested {
  connectionId: string
  syncJobId: string
  /** 同一连接已有排队或运行中的检查时直接返回它。 */
  alreadyRunning: boolean
}
export interface ConnectionReauthorizeResult {
  connectionId: string
  provider: string
  authorizationUrl: string
}
export interface ConnectionDisconnectResult {
  connectionId: string
  state: 'REVOKED'
  cancelledJobs: number
}

// ---- 报告权限与品牌分析资格（由同步结果推断的两类“连接”）----

export interface DerivedEvidence {
  state: DerivedState
  counts: EvidenceCounts
  total: number
  lastSuccessAt: Date | null
  failureCode: string | null
}
const DERIVED_OF: Readonly<Record<ModuleState, DerivedState>> = { GRANTED: 'AVAILABLE', PARTIAL: 'PARTIAL', MISSING: 'MISSING', NOT_APPLICABLE: 'NOT_APPLICABLE', UNVERIFIED: 'UNVERIFIED' }

/** 一个店铺在一组来源上的综合证据：每个来源各算一项，统计成功、缺角色等项数，状态按项数得出。 */
export function derivedEvidenceOf(sourceKeys: readonly string[], rows: readonly EvidenceRow[]): DerivedEvidence {
  const bySource = new Map(rows.map(row => [row.sourceKey, row]))
  const counts = emptyCounts()
  let lastSuccessAt: Date | null = null
  let failureCode: string | null = null
  for (const key of sourceKeys) {
    const row = bySource.get(key)
    const state = evidenceOf(row)
    const field =
      state === 'OK' ? 'ok' : state === 'MISSING' ? 'missing' : state === 'NOT_APPLICABLE' ? 'notApplicable' : state === 'AUTH_EXPIRED' ? 'authExpired' : state === 'FAILED' ? 'failed' : 'unverified'
    counts[field] += 1
    const success = row?.lastSuccessAt ? new Date(row.lastSuccessAt) : null
    if (success && (!lastSuccessAt || success > lastSuccessAt)) lastSuccessAt = success
    if (!failureCode && row?.lastErrorCode && state !== 'OK') failureCode = row.lastErrorCode
  }
  return { state: DERIVED_OF[moduleStateOf(counts)], counts, total: sourceKeys.length, lastSuccessAt, failureCode }
}
