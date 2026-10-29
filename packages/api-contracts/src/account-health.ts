import type { FreshnessViewStatus } from './freshness.js'
import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// 账户健康（P5-02，09 章 9.2，importers.md R-42 与 N-17）：账户状态、账户健康评级、订单缺陷率及其构成、政策合规问题。
// 本文件放常量、标签与响应类型（不含 zod，前端首屏会引用）；纯函数在 account-health-math.ts，写入校验在 account-health-input.ts。
// 数据来自卖家表现报告（GET_V2_SELLER_PERFORMANCE_REPORT，每日一次）；账户状态变更推送（ACCOUNT_STATUS_CHANGED）的接收端是 14.10 的延后项，
// 接收端上线之前页面写明“推送尚未接入”，状态只来自报告。报告的真实字段还没有用真实店铺核对：解析是宽松的，认不出的指标进“其他指标”，不丢也不猜。

export const ACCOUNT_HEALTH_READ = 'account.health.read'
/** 处理政策问题（指定负责人、改处理状态、备注、关联案件）复用预警处理权限，不新增权限点。 */
export const ACCOUNT_HEALTH_HANDLE = 'alerts.handle'

/** 审计动作：处理政策问题（负责人、处理状态、备注、关联案件）。 */
export const ACCOUNT_HEALTH_ACTIONS = { issueUpdated: 'POLICY_ISSUE_UPDATED' } as const

export const SELLER_PERFORMANCE_REPORT_TYPE = 'GET_V2_SELLER_PERFORMANCE_REPORT'
export const SELLER_PERFORMANCE_FRESHNESS_KEY = 'rpt.seller-performance'
export const ACCOUNT_STATUS_NOTIFICATION_TYPE = 'ACCOUNT_STATUS_CHANGED'
export const ACCOUNT_STATUS_FRESHNESS_KEY = 'ntf.account-status'
/** 报告接口没有授权（403）时同步任务使用的通用失败码，新鲜度状态为“未授权”。 */
export const ACCOUNT_HEALTH_ROLE_MISSING = 'ROLE_MISSING'
export const ACCOUNT_HEALTH_ROLE_GUIDE =
  '账户健康报告（卖家表现报告）需要为应用授权对应角色：在亚马逊开发者控制台的应用资料里勾选该报告文档所列的角色并提交审核，审核通过后到连接中心重新授权店铺，数据会在下一次同步出现。'
export const ACCOUNT_PUSH_NOT_CONNECTED_NOTE = '账户状态变更推送尚未接入（推送接收端是后续工作）：账户状态目前只来自每日一次的账户健康报告，状态变化最长会晚一天出现。'

export const ACCOUNT_STATUS_METRIC_KEY = 'ACCOUNT_STATUS'
export const ACCOUNT_RATING_METRIC_KEY = 'ACCOUNT_HEALTH_RATING'

export const ACCOUNT_STATUSES = ['NORMAL', 'AT_RISK', 'DEACTIVATED'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export const ACCOUNT_STATUS_LABEL: Readonly<Record<AccountStatus, string>> = { NORMAL: '正常', AT_RISK: '有风险', DEACTIVATED: '停用' }
/** 严重程度，用于判断“变差”：数字越大越差。 */
export const ACCOUNT_STATUS_SEVERITY: Readonly<Record<AccountStatus, number>> = { NORMAL: 0, AT_RISK: 1, DEACTIVATED: 2 }

export const HEALTH_METRIC_GROUPS = ['STATUS', 'RATING', 'ORDER_DEFECT', 'POLICY', 'OTHER'] as const
export type HealthMetricGroup = (typeof HEALTH_METRIC_GROUPS)[number]
export const HEALTH_METRIC_GROUP_LABEL: Readonly<Record<HealthMetricGroup, string>> = {
  STATUS: '账户状态',
  RATING: '账户健康评级',
  ORDER_DEFECT: '订单缺陷',
  POLICY: '政策合规',
  OTHER: '其他指标',
}

export const HEALTH_METRIC_STATUSES = ['MET', 'NOT_MET', 'UNKNOWN'] as const
export type HealthMetricStatus = (typeof HEALTH_METRIC_STATUSES)[number]
export const HEALTH_METRIC_STATUS_LABEL: Readonly<Record<HealthMetricStatus, string>> = { MET: '达标', NOT_MET: '未达标', UNKNOWN: '未判定' }

export const HEALTH_TARGET_CONDITIONS = ['LT', 'LTE', 'GT', 'GTE', 'EQ'] as const
export type HealthTargetCondition = (typeof HEALTH_TARGET_CONDITIONS)[number]
export const HEALTH_TARGET_CONDITION_TEXT: Readonly<Record<HealthTargetCondition, string>> = { LT: '低于', LTE: '不高于', GT: '高于', GTE: '不低于', EQ: '等于' }

export const HEALTH_SOURCES = ['REPORT', 'PUSH'] as const
export type HealthSource = (typeof HEALTH_SOURCES)[number]

export const POLICY_ISSUE_KINDS = ['IP_COMPLAINT', 'AUTHENTICITY', 'PRODUCT_SAFETY', 'LISTING_POLICY', 'RESTRICTED_PRODUCT', 'REVIEW_POLICY', 'CONDITION', 'OTHER'] as const
export type PolicyIssueKind = (typeof POLICY_ISSUE_KINDS)[number]
export const POLICY_ISSUE_KIND_LABEL: Readonly<Record<PolicyIssueKind, string>> = {
  IP_COMPLAINT: '知识产权投诉',
  AUTHENTICITY: '商品真实性投诉',
  PRODUCT_SAFETY: '商品安全投诉',
  LISTING_POLICY: '上架政策违规',
  RESTRICTED_PRODUCT: '受限商品违规',
  REVIEW_POLICY: '评论政策违规',
  CONDITION: '商品状况投诉',
  OTHER: '其他',
}

export const POLICY_ISSUE_STATUSES = ['OPEN', 'RESOLVED'] as const
export type PolicyIssueStatus = (typeof POLICY_ISSUE_STATUSES)[number]
export const POLICY_ISSUE_STATUS_LABEL: Readonly<Record<PolicyIssueStatus, string>> = { OPEN: '未解决', RESOLVED: '已解决' }

export const POLICY_HANDLING_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE'] as const
export type PolicyHandlingStatus = (typeof POLICY_HANDLING_STATUSES)[number]
export const POLICY_HANDLING_STATUS_LABEL: Readonly<Record<PolicyHandlingStatus, string>> = { OPEN: '待处理', IN_PROGRESS: '处理中', DONE: '已处理' }

export const POLICY_ISSUE_SORTS = ['firstSeenAt', 'lastSeenAt'] as const

export const ACCOUNT_HEALTH_LIMITS = {
  /** 趋势与状态历史回看的天数（快照每天一份，按天取）。 */
  trendDays: 90,
  /** 读取上限：Prisma 单次最多 20000 行，多读一行判断是否被截断。 */
  readRows: 19_999,
  noteMax: 500,
  titleMax: 300,
  impactMax: 500,
  asinsMax: 50,
  amazonCaseIdMax: 64,
} as const

export const ACCOUNT_HEALTH_BASIS =
  '来自亚马逊卖家表现报告（每日同步一次）：每天留存一份快照，趋势按快照日期画；报告没有给的指标显示“尚无记录”，不当 0；达标与否只按报告自带的目标判定，报告没给目标就不判定。'
export const ODR_BREAKDOWN_NOTE = '订单缺陷率的构成（负面反馈、交易保障索赔、拒付）取决于报告是否分项给出；没有分项时只显示总的订单缺陷率。'

/** OK 有数据；NO_DATA 店铺已接入但还没有快照；NOT_CONNECTED 店铺尚未接入亚马逊；ROLE_PENDING 报告接口未授权。 */
export type AccountHealthState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'ROLE_PENDING'

/** 指标单位：RATIO 比率（小数，0.0085 = 0.85%）；COUNT 计数；null 报告没说明。 */
export const HEALTH_UNITS = ['RATIO', 'COUNT'] as const

export interface HealthMetricView {
  key: string
  label: string
  group: HealthMetricGroup
  value: number | null
  target: number | null
  targetCondition: HealthTargetCondition | null
  /** 目标的人话描述，例如“不高于 1%”；没有目标为 null。 */
  targetText: string | null
  status: HealthMetricStatus
  statusLabel: string
  unit: string | null
  windowDays: number | null
}

export interface AccountStatusView {
  status: AccountStatus | null
  label: string | null
  asOf: string | null
  source: HealthSource | null
  /** 最近一次变化之前的状态与变化日期；从未变化（或历史不足）为 null。 */
  previousStatus: AccountStatus | null
  previousLabel: string | null
  changedAt: string | null
}

export interface AccountRatingView {
  score: number | null
  status: string | null
  statusLabel: string | null
}

export interface HealthTrendPoint {
  date: string
  value: number
}

export interface HealthTrendSeries {
  key: string
  label: string
  unit: string | null
  points: HealthTrendPoint[]
}

export interface AccountStatusChange {
  date: string
  status: AccountStatus
  label: string
  previousStatus: AccountStatus | null
  previousLabel: string | null
  worse: boolean
}

export interface OdrBreakdownItem {
  key: string
  label: string
  metric: HealthMetricView | null
  note: string | null
}

export interface PolicyKindCount {
  kind: PolicyIssueKind
  label: string
  count: number
}

export interface AccountHealthSync {
  status: FreshnessViewStatus
  statusLabel: string
  lastSuccessAt: string | null
  errorCode: string | null
  errorMessage: string | null
  rolePending: boolean
}

export interface AccountHealthStoreView {
  sellerAccountId: string
  storeName: string
  state: AccountHealthState
  note: string | null
  sync: AccountHealthSync
  snapshotDate: string | null
  accountStatus: AccountStatusView
  rating: AccountRatingView | null
  ratingTrend: HealthTrendPoint[]
  statusHistory: AccountStatusChange[]
  orderDefect: { metrics: HealthMetricView[]; breakdown: OdrBreakdownItem[]; trend: HealthTrendSeries[] }
  policy: { metrics: HealthMetricView[]; openByKind: PolicyKindCount[]; openCount: number }
  other: HealthMetricView[]
}

export interface AccountHealthResponse {
  stores: AccountHealthStoreView[]
  /** 状态推送的接入情况：接收端上线前恒为 NOT_CONNECTED。 */
  push: { state: 'NOT_CONNECTED' | 'OK'; note: string | null }
  truncated: boolean
  freshness: InventoryFreshness
  basis: string
}

export interface PolicyIssueRow {
  id: string
  issueId: string
  sellerAccountId: string
  storeName: string
  kind: PolicyIssueKind
  kindLabel: string
  title: string
  asins: string[]
  status: PolicyIssueStatus
  statusLabel: string
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  impactText: string | null
  handlingStatus: PolicyHandlingStatus
  handlingStatusLabel: string
  owner: { id: string; name: string } | null
  amazonCaseId: string | null
  version: number
}

export interface PolicyIssueListResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'ROLE_PENDING'
  note: string | null
  items: PolicyIssueRow[]
  pageInfo: CursorPageInfo
  counts: Record<PolicyIssueStatus, number>
  /** 读取行数超过上限时为 true（只显示了最前面的一部分）。 */
  truncated: boolean
  sync: AccountHealthSync
  freshness: InventoryFreshness
}

/** 问题关联的客服案件：OK 有关联；NONE 没有；RESTRICTED 没有客服案件的查看权限；NOT_CONNECTED 客服案件尚未接入。 */
export interface PolicyIssueSupportView {
  state: 'OK' | 'NONE' | 'RESTRICTED' | 'NOT_CONNECTED'
  note: string | null
  cases: { id: string; caseId: string; subject: string; statusLabel: string; updatedAt: string; via: 'MANUAL' | 'SUBJECT' }[]
}

export interface PolicyIssueTimelineItem {
  id: string
  at: string
  title: string
  actorName: string | null
}

export interface PolicyIssueDetail {
  issue: PolicyIssueRow & { handlingNote: string | null }
  timeline: PolicyIssueTimelineItem[]
  support: PolicyIssueSupportView
  /** 可指定的负责人（企业内的在职成员）。 */
  owners: { id: string; name: string }[]
}
