import type { AdsChangeEntityType } from './ads-changes'

// 广告写入契约（P3-17，08 章开头“写入开关类别”、09 章 9.13）：只有常量、类型与纯函数，没有 zod（请求校验在 ads-write-query.ts）。
// 所有改亚马逊广告账户的动作（手动、自动规则、分时策略）共用一条流水线：预览 → 动作守卫（权限、连接、开关）→ 记写入记录与审计 → 后台任务调用亚马逊 → 回写本地对象、变更记录与操作事件。
// 十种写入各归属八个开关之一（活动状态、预算、竞价、否定投放、添加关键词、广告位调整）；自动规则执行与分时策略执行是“来源开关”，由规则或分时策略发起的写入要同时开着来源开关与动作自己的开关。

export const ADS_WRITE_JOB = 'ADS_WRITE'
export const ADS_WRITE_PREVIEW_PERMISSION = 'ads.read'

export const ADS_WRITE_KINDS = [
  'CAMPAIGN_STATE',
  'CAMPAIGN_BUDGET',
  'CAMPAIGN_BID_STRATEGY',
  'CAMPAIGN_PLACEMENT',
  'AD_GROUP_STATE',
  'AD_GROUP_BID',
  'TARGET_STATE',
  'TARGET_BID',
  'NEGATIVE_ADD',
  'KEYWORD_ADD',
] as const
export type AdsWriteKind = (typeof ADS_WRITE_KINDS)[number]

export const ADS_WRITE_SOURCES = ['MANUAL', 'AUTO_RULE', 'DAYPARTING'] as const
export type AdsWriteSource = (typeof ADS_WRITE_SOURCES)[number]
/** 来源开关：规则与分时策略发起的写入除了动作自己的开关，还要这个开关开着；手动写入没有来源开关。 */
export const ADS_SOURCE_SWITCH: Record<AdsWriteSource, string | null> = { MANUAL: null, AUTO_RULE: 'sw.ads.rule.run', DAYPARTING: 'sw.ads.dayparting.run' }

export type AdsWriteEntity = 'CAMPAIGN' | 'AD_GROUP' | 'TARGET'

export interface AdsWriteKindInfo {
  label: string
  switchKey: string
  permission: string
  /** 被修改的对象（新增类写入是它的父对象：否定可以挂在活动或广告组，关键词挂在广告组）。 */
  entity: AdsWriteEntity
}
export const ADS_WRITE_KIND_INFO: Record<AdsWriteKind, AdsWriteKindInfo> = {
  CAMPAIGN_STATE: { label: '暂停或启用活动', switchKey: 'sw.ads.status', permission: 'ads.campaign.write', entity: 'CAMPAIGN' },
  CAMPAIGN_BUDGET: { label: '修改活动日预算', switchKey: 'sw.ads.budget', permission: 'ads.budget.write', entity: 'CAMPAIGN' },
  CAMPAIGN_BID_STRATEGY: { label: '修改活动竞价策略', switchKey: 'sw.ads.bid', permission: 'ads.bid.write', entity: 'CAMPAIGN' },
  CAMPAIGN_PLACEMENT: { label: '修改广告位竞价调整', switchKey: 'sw.ads.placement', permission: 'ads.placement.write', entity: 'CAMPAIGN' },
  AD_GROUP_STATE: { label: '暂停或启用广告组', switchKey: 'sw.ads.status', permission: 'ads.campaign.write', entity: 'AD_GROUP' },
  AD_GROUP_BID: { label: '修改广告组默认竞价', switchKey: 'sw.ads.bid', permission: 'ads.bid.write', entity: 'AD_GROUP' },
  TARGET_STATE: { label: '暂停或启用投放对象', switchKey: 'sw.ads.status', permission: 'ads.campaign.write', entity: 'TARGET' },
  TARGET_BID: { label: '修改投放对象竞价', switchKey: 'sw.ads.bid', permission: 'ads.bid.write', entity: 'TARGET' },
  NEGATIVE_ADD: { label: '添加否定投放', switchKey: 'sw.ads.negative', permission: 'ads.negative.write', entity: 'AD_GROUP' },
  KEYWORD_ADD: { label: '添加关键词', switchKey: 'sw.ads.keyword', permission: 'ads.keyword.write', entity: 'AD_GROUP' },
}

/** 一个写入要同时满足的开关：动作自己的开关，加上来源开关。 */
export function adsWriteSwitches(kind: AdsWriteKind, source: AdsWriteSource): string[] {
  const own = ADS_WRITE_KIND_INFO[kind].switchKey
  const from = ADS_SOURCE_SWITCH[source]
  return from ? [own, from] : [own]
}

export const ADS_WRITE_LIMITS = {
  batchMax: 50,
  budgetMax: 1_000_000,
  bidMin: 0.02,
  bidMax: 1000,
  textMax: 80,
  placementPercentMax: 900,
  /** 预览里提醒“幅度较大”的百分比（自定）。 */
  bigChangePercent: 50,
  /** 失败原因与前后值写进记录时的最长字符数。 */
  messageMax: 300,
} as const

export const ADS_WRITE_STATES = ['ENABLED', 'PAUSED'] as const
export const ADS_WRITE_STATE_LABEL: Record<(typeof ADS_WRITE_STATES)[number], string> = { ENABLED: '启用', PAUSED: '暂停' }
/** 竞价策略取值是按统一接口文档惯例写的假设（未对真实账户验证）。 */
export const ADS_BID_STRATEGIES = ['SALES_DOWN_ONLY', 'SALES_UP_AND_DOWN', 'MANUAL'] as const
export const ADS_BID_STRATEGY_LABEL: Record<(typeof ADS_BID_STRATEGIES)[number], string> = { SALES_DOWN_ONLY: '动态竞价，只降低', SALES_UP_AND_DOWN: '动态竞价，提高和降低', MANUAL: '固定竞价' }
export const ADS_PLACEMENTS = ['TOP_OF_SEARCH', 'PRODUCT_PAGE', 'REST_OF_SEARCH'] as const
export const ADS_PLACEMENT_LABEL: Record<(typeof ADS_PLACEMENTS)[number], string> = { TOP_OF_SEARCH: '搜索结果顶部', PRODUCT_PAGE: '商品页面', REST_OF_SEARCH: '搜索结果其余位置' }
export const ADS_NEGATIVE_MATCHES = ['NEGATIVE_EXACT', 'NEGATIVE_PHRASE'] as const
export const ADS_KEYWORD_MATCHES = ['EXACT', 'PHRASE', 'BROAD'] as const
export const ADS_WRITE_MATCH_LABEL: Record<string, string> = { NEGATIVE_EXACT: '否定精确', NEGATIVE_PHRASE: '否定词组', EXACT: '精确匹配', PHRASE: '词组匹配', BROAD: '广泛匹配' }

export interface AdsWriteOp {
  kind: AdsWriteKind
  /** 被修改对象的系统编号（新增类是父对象：活动、广告组）。 */
  entityId: string
  state?: (typeof ADS_WRITE_STATES)[number]
  /** 金额（日预算、竞价）或百分比（广告位调整）。 */
  amount?: number
  strategy?: (typeof ADS_BID_STRATEGIES)[number]
  placement?: (typeof ADS_PLACEMENTS)[number]
  text?: string
  matchType?: string
  /** 否定投放挂在活动还是广告组。 */
  level?: 'CAMPAIGN' | 'AD_GROUP'
}

const isMoney = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value)

/** 请求内容是否完整合法（不看对象是否存在）；合法返回 null，否则返回中文原因。 */
export function adsWriteOpIssue(op: Omit<AdsWriteOp, 'entityId'>): string | null {
  const bid = (name: string) =>
    !isMoney(op.amount) || op.amount! < ADS_WRITE_LIMITS.bidMin || op.amount! > ADS_WRITE_LIMITS.bidMax ? `${name}要在 ${ADS_WRITE_LIMITS.bidMin} 到 ${ADS_WRITE_LIMITS.bidMax} 之间` : null
  switch (op.kind) {
    case 'CAMPAIGN_STATE':
    case 'AD_GROUP_STATE':
    case 'TARGET_STATE':
      return op.state ? null : '请选择要设置的状态（启用或暂停）'
    case 'CAMPAIGN_BUDGET':
      return !isMoney(op.amount) || op.amount! <= 0 || op.amount! > ADS_WRITE_LIMITS.budgetMax ? `日预算要大于 0 且不超过 ${ADS_WRITE_LIMITS.budgetMax}` : null
    case 'CAMPAIGN_BID_STRATEGY':
      return op.strategy ? null : '请选择竞价策略'
    case 'CAMPAIGN_PLACEMENT':
      if (!op.placement) return '请选择广告位'
      return !isMoney(op.amount) || op.amount! < 0 || op.amount! > ADS_WRITE_LIMITS.placementPercentMax ? `调整百分比要在 0 到 ${ADS_WRITE_LIMITS.placementPercentMax} 之间` : null
    case 'AD_GROUP_BID':
      return bid('默认竞价')
    case 'TARGET_BID':
      return bid('竞价')
    case 'NEGATIVE_ADD': {
      if (!op.text?.trim()) return '请填写要否定的词'
      if (!op.level) return '请选择否定投放挂在活动还是广告组'
      return op.matchType && (ADS_NEGATIVE_MATCHES as readonly string[]).includes(op.matchType) ? null : '请选择否定匹配方式（否定精确或否定词组）'
    }
    case 'KEYWORD_ADD': {
      if (!op.text?.trim()) return '请填写关键词'
      if (!op.matchType || !(ADS_KEYWORD_MATCHES as readonly string[]).includes(op.matchType)) return '请选择匹配方式（精确、词组或广泛）'
      return op.amount === undefined ? null : bid('竞价')
    }
    default:
      return '不认识的写入类型'
  }
}

/** 修改后的值（文字，写进记录与对照）。 */
export function adsWriteAfterText(op: Omit<AdsWriteOp, 'entityId'>): string {
  switch (op.kind) {
    case 'CAMPAIGN_STATE':
    case 'AD_GROUP_STATE':
    case 'TARGET_STATE':
      return op.state ?? ''
    case 'CAMPAIGN_BID_STRATEGY':
      return op.strategy ?? ''
    case 'CAMPAIGN_PLACEMENT':
      return `${op.placement ?? ''} ${op.amount ?? ''}%`.trim()
    case 'NEGATIVE_ADD':
    case 'KEYWORD_ADD':
      return `${(op.text ?? '').trim()}（${op.matchType ?? ''}）`
    default:
      return op.amount === undefined ? '' : String(op.amount)
  }
}

/** 变更记录里的对象类型与字段（字段键与 ADS_CHANGE_FIELDS 一致；新增类记在父对象上，字段是 keyword / negativeTarget）。 */
export function adsWriteChangeField(kind: AdsWriteKind): { entityType: AdsChangeEntityType; field: string } {
  switch (kind) {
    case 'CAMPAIGN_STATE':
      return { entityType: 'CAMPAIGN', field: 'state' }
    case 'CAMPAIGN_BUDGET':
      return { entityType: 'CAMPAIGN', field: 'budget' }
    case 'CAMPAIGN_BID_STRATEGY':
      return { entityType: 'CAMPAIGN', field: 'bidStrategy' }
    case 'CAMPAIGN_PLACEMENT':
      return { entityType: 'CAMPAIGN', field: 'placementAdjustment' }
    case 'AD_GROUP_STATE':
      return { entityType: 'AD_GROUP', field: 'state' }
    case 'AD_GROUP_BID':
      return { entityType: 'AD_GROUP', field: 'defaultBid' }
    case 'TARGET_STATE':
      return { entityType: 'TARGET', field: 'state' }
    case 'TARGET_BID':
      return { entityType: 'TARGET', field: 'bid' }
    case 'NEGATIVE_ADD':
      return { entityType: 'AD_GROUP', field: 'negativeTarget' }
    default:
      return { entityType: 'AD_GROUP', field: 'keyword' }
  }
}

/** 操作事件（EntityEvent）的对象类型与种类。调价事件的格式沿用 P3-08 的约定：`ADS_TARGET` + `ads.target.bid` + `{ before: { bid }, after: { bid } }`。 */
export function adsWriteEventOf(kind: AdsWriteKind): { entityType: 'ADS_CAMPAIGN' | 'ADS_AD_GROUP' | 'ADS_TARGET'; kind: string; key: string } {
  switch (kind) {
    case 'CAMPAIGN_STATE':
      return { entityType: 'ADS_CAMPAIGN', kind: 'ads.campaign.state', key: 'state' }
    case 'CAMPAIGN_BUDGET':
      return { entityType: 'ADS_CAMPAIGN', kind: 'ads.campaign.budget', key: 'budget' }
    case 'CAMPAIGN_BID_STRATEGY':
      return { entityType: 'ADS_CAMPAIGN', kind: 'ads.campaign.bid-strategy', key: 'bidStrategy' }
    case 'CAMPAIGN_PLACEMENT':
      return { entityType: 'ADS_CAMPAIGN', kind: 'ads.campaign.placement', key: 'placementAdjustment' }
    case 'AD_GROUP_STATE':
      return { entityType: 'ADS_AD_GROUP', kind: 'ads.ad-group.state', key: 'state' }
    case 'AD_GROUP_BID':
      return { entityType: 'ADS_AD_GROUP', kind: 'ads.ad-group.bid', key: 'bid' }
    case 'TARGET_STATE':
      return { entityType: 'ADS_TARGET', kind: 'ads.target.state', key: 'state' }
    case 'TARGET_BID':
      return { entityType: 'ADS_TARGET', kind: 'ads.target.bid', key: 'bid' }
    case 'NEGATIVE_ADD':
      return { entityType: 'ADS_AD_GROUP', kind: 'ads.ad-group.negative', key: 'negativeTarget' }
    default:
      return { entityType: 'ADS_AD_GROUP', kind: 'ads.ad-group.keyword', key: 'keyword' }
  }
}

/** 金额文字（去掉末尾 0），变化百分比（前值为空或 0 返回 null）。 */
export const adsMoneyText = (value: number | string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? String(Number(n.toFixed(6))) : null
}
export function adsChangePercent(before: string | null, after: string): number | null {
  const a = before === null ? NaN : Number(before)
  const b = Number(after)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null
  return Math.round(((b - a) / a) * 1000) / 10
}

/** 预览里的提醒：幅度大、没有变化、暂停会停掉花费等（只是提醒，不阻止提交）。 */
export function adsWriteWarnings(op: Omit<AdsWriteOp, 'entityId'>, before: string | null): string[] {
  const out: string[] = []
  if (op.kind === 'CAMPAIGN_BUDGET' || op.kind === 'AD_GROUP_BID' || op.kind === 'TARGET_BID') {
    const pct = adsChangePercent(before, String(op.amount))
    if (pct !== null && Math.abs(pct) >= ADS_WRITE_LIMITS.bigChangePercent) out.push(`${pct > 0 ? '提高' : '降低'}幅度 ${Math.abs(pct)}%，超过 ${ADS_WRITE_LIMITS.bigChangePercent}%，请确认`)
    if (before === null) out.push('当前值尚未同步，无法计算变化幅度')
  }
  if ((op.kind === 'CAMPAIGN_STATE' || op.kind === 'AD_GROUP_STATE' || op.kind === 'TARGET_STATE') && op.state === 'PAUSED') out.push('暂停后该对象不再产生花费与订单')
  if (op.kind === 'CAMPAIGN_PLACEMENT') out.push('当前广告位调整值没有同步器写入，无法显示修改前的值')
  return out
}

// ---- 写入记录与响应 ----

export const ADS_WRITE_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const
export type AdsWriteStatus = (typeof ADS_WRITE_STATUSES)[number]
export const ADS_WRITE_STATUS_LABEL: Record<AdsWriteStatus, string> = { PENDING: '排队中', RUNNING: '执行中', SUCCEEDED: '已完成', FAILED: '失败' }
export const ADS_WRITE_SOURCE_LABEL: Record<AdsWriteSource, string> = { MANUAL: '手动', AUTO_RULE: '自动规则', DAYPARTING: '分时策略' }
export const ADS_WRITE_RUN_LIMIT = 50
export const ADS_WRITE_SUBMITTED_ACTION = 'ADS_WRITE_SUBMITTED'

/** 失败码的中文说明（只给短码，亚马逊返回的原文不进记录）。 */
export function adsWriteFailureText(code: string | null): string {
  if (!code) return '失败，原因未记录'
  if (code === 'SWITCH_DISABLED') return '执行前写入开关已关闭，没有向亚马逊发出请求'
  if (code === 'ADS_ACCOUNT_MISSING') return '广告档案还没有统一接口的广告账户编号'
  if (code === 'ADS_ENTITY_MISSING') return '对象已不存在（可能被同步删除）'
  if (code === 'ADS_WRITE_REJECTED') return '亚马逊拒绝了这次修改，请核对取值后重试'
  if (/^ADS_API_4\d\d/.test(code)) return '亚马逊广告接口拒绝了请求，请核对授权与取值'
  if (/^ADS_API_/.test(code)) return '亚马逊广告接口暂时不可用，请稍后重试'
  return '执行失败，请稍后重试；多次失败请联系管理员'
}

export interface AdsWriteSwitchView {
  key: string
  label: string
  enabled: boolean
  /** 没开启的原因（可能是紧急强制关闭、自动关闭或默认只读）。 */
  reason: string | null
}

export interface AdsWritePreviewItem {
  index: number
  kind: AdsWriteKind
  kindLabel: string
  entityId: string
  entityLabel: string | null
  /** 对象不存在或不在数据范围内、取值不合法时的原因；有原因的批次不能提交。 */
  blocker: string | null
  before: string | null
  after: string
  changePercent: number | null
  warnings: string[]
  /** 官方活动预测只有改预算时给，且只读本系统已保存的预测记录；没有就写原因。 */
  forecast: { state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'; note: string; low: number | null; high: number | null } | null
}

export interface AdsWritePreviewResponse {
  items: AdsWritePreviewItem[]
  switches: AdsWriteSwitchView[]
  /** 当前账号对批次里每类写入都有权限。 */
  permitted: boolean
  /** 没有阻塞项、开关都开着、有权限、有可用的广告连接。 */
  canSubmit: boolean
  /** 不能提交时的第一条原因（权限、连接、开关或阻塞项）。 */
  reason: string | null
  note: string
}

export interface AdsWriteRunRow {
  id: string
  kind: AdsWriteKind
  kindLabel: string
  source: AdsWriteSource
  entityType: string
  entityId: string
  entityLabel: string | null
  before: string | null
  after: string
  status: AdsWriteStatus
  failureCode: string | null
  failureText: string | null
  requestedBy: string | null
  createdAt: string
  finishedAt: string | null
}

export interface AdsWriteSubmitResponse {
  runs: AdsWriteRunRow[]
  /** 已排队，亚马逊的结果以写入记录的状态为准。 */
  state: 'QUEUED'
}

export interface AdsWriteStatusResponse {
  /** 每类写入当前能不能用：有没有权限、开关是否开启。 */
  kinds: Array<{ kind: AdsWriteKind; label: string; permitted: boolean; switchKey: string; switchEnabled: boolean; reason: string | null }>
  runs: AdsWriteRunRow[]
}

export const ADS_WRITE_PREVIEW_NOTE = '预览只读本系统已有的数据，不会调用亚马逊，也不会修改任何设置；提交后由后台任务调用亚马逊，结果以“写入记录”的状态为准。'
