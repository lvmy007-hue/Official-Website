import { LEGAL_ENTITY_ACTION_LABEL } from './legal-entity.js'
import { MEMBER_ACTION_LABEL } from './members.js'
import { ORDER_PII_FIELDS, PII_REVEAL_ACTION, PII_REVEAL_AUDIT_RESOURCE } from './pii.js'
import type { CursorPageInfo } from './query.js'
import { normalizeRouteTemplate } from './route-template.js'

// 审计中心契约（P5-09，09 章 9.11；freeze/api.md `/audit*`）。
// 本文件只放常量、标签、纯函数与响应类型，没有 zod（前端懒加载页面与接口、后台任务共用）；查询参数校验在 audit-query.ts。
// 审计权限 `audit.read` 沿用 members.ts 里的 AUDIT_READ。

/** 页面发请求时带的“所属页面”请求头：当前页面的路径（具体编号会被服务端归一成 :id）。 */
export const AUDIT_PAGE_HEADER = 'x-nova-page'
/** 审计导出的数据类型（导出中心 EXPORT_KINDS）。 */
export const AUDIT_EXPORT_KIND = 'audit-events'
/** 筛选项取值范围（动作、资源类型、页面、操作人）只统计最近多少天。 */
export const AUDIT_OPTIONS_WINDOW_DAYS = 90
export const AUDIT_OPTIONS_LIMIT = 300
/** 个人信息明文查看视图里，排行与汇总统计的天数。 */
export const PII_SUMMARY_DAYS = 7
export const PII_TOP_VIEWERS = 5

// ---- 来源 ----

export const AUDIT_SOURCES = ['PAGE', 'API', 'SYSTEM'] as const
export type AuditSource = (typeof AUDIT_SOURCES)[number]
export const AUDIT_SOURCE_LABEL: Readonly<Record<AuditSource, string>> = { PAGE: '页面操作', API: '接口调用', SYSTEM: '系统任务' }
export const AUDIT_SOURCE_UNKNOWN_LABEL = '未记录'

/** 旧记录没有来源列：没有操作人的按“系统任务”处理，其余无法判断。 */
export function auditSourceOf(source: string | null | undefined, actorId: string | null | undefined): AuditSource | null {
  if (source === 'PAGE' || source === 'API' || source === 'SYSTEM') return source
  return actorId ? null : 'SYSTEM'
}
export const auditSourceLabel = (source: AuditSource | null) => (source ? AUDIT_SOURCE_LABEL[source] : AUDIT_SOURCE_UNKNOWN_LABEL)

// ---- 所属页面 ----

const PAGE_PATTERN = /^\/app(?:\/[A-Za-z0-9_:.-]{1,64}){0,6}$/

/**
 * 校验并归一请求头里的页面路径：只认 /app 开头的前端路径，去掉查询串与末尾斜杠，具体编号归一成 :id；不合格返回 null（按“接口调用”记）。
 * 请求头由调用方自己声明，所以“页面操作”与“接口调用”的区分只是便于筛选的标注，不是防抵赖的证据。
 */
export function auditPageOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.split('?')[0].split('#')[0].trim().replace(/\/+$/, '')
  if (text.length === 0 || text.length > 120 || !PAGE_PATTERN.test(text)) return null
  return normalizeRouteTemplate(text)
}

// ---- 结果与访问模式 ----

export const AUDIT_RESULTS = ['SUCCEEDED', 'FAILED', 'DENIED'] as const
export const AUDIT_RESULT_LABEL: Readonly<Record<string, string>> = { SUCCEEDED: '成功', FAILED: '失败', DENIED: '被拒绝' }
export const auditResultLabel = (result: string) => AUDIT_RESULT_LABEL[result] ?? result

export const AUDIT_ACCESS_MODE_LABEL: Readonly<Record<string, string>> = { NORMAL: '正常访问', SUPPORT: '平台支持访问', INTERNAL_DIRECT: '内部直连', PLATFORM: '平台操作' }
export const auditAccessModeLabel = (mode: string) => AUDIT_ACCESS_MODE_LABEL[mode] ?? mode

// ---- 动作与资源类型的中文名 ----

// 只登记常见动作；没有登记的显示动作代码本身（不编造译名）。成员与法律主体的动作名沿用各自契约里已有的写法。
export const AUDIT_ACTION_LABEL: Readonly<Record<string, string>> = {
  ...MEMBER_ACTION_LABEL,
  ...LEGAL_ENTITY_ACTION_LABEL,
  LOGIN_SUCCEEDED: '登录成功',
  LOGOUT: '退出登录',
  NEW_DEVICE_LOGIN: '新设备登录',
  SESSION_REVOKED: '会话被收回',
  SESSION_REUSE_DETECTED: '检测到刷新凭据重复使用',
  MFA_ENROLLMENT_STARTED: '开始绑定多因素认证',
  MFA_VERIFIED: '多因素认证通过',
  STEP_UP_VERIFIED: '再次验证身份通过',
  ORDER_BUYER_PII_VIEWED: '查看买家信息明文',
  [PII_REVEAL_ACTION]: '查看个人信息明文',
  EXPORT_REQUESTED: '发起导出',
  EXPORT_COMPLETED: '导出完成',
  EXPORT_FAILED: '导出失败',
  EXPORT_DOWNLOAD_LINK_ISSUED: '获取导出下载链接',
  ALERT_ACKED: '确认预警',
  ALERT_ASSIGNED: '分派预警',
  ALERT_CLOSED: '关闭预警',
  ALERT_IGNORED: '忽略预警',
  ALERT_RULE_CREATED: '新建预警规则',
  ALERT_RULE_UPDATED: '修改预警规则',
  WORK_ITEM_CREATED: '新建待办',
  WORK_ITEM_ASSIGNED: '指派待办',
  WORK_ITEM_CLOSED: '关闭待办',
  WRITE_SWITCH_ENABLED: '开启写入开关',
  WRITE_SWITCH_DISABLED: '关闭写入开关',
  WRITE_SWITCH_READONLY_ALL: '一键全部只读',
  FX_SOURCE_CHANGED: '修改汇率来源',
  FX_RATE_OVERRIDDEN: '手工覆盖汇率',
  FX_OVERRIDE_REMOVED: '撤销手工汇率',
  FINANCE_POLICY_SUBMITTED: '提交财务口径',
  FINANCE_POLICY_APPROVED: '批准财务口径',
  PERIOD_CLOSED: '关账',
  PERIOD_REOPENED: '重新打开账期',
  COST_VERSION_CREATED: '新建成本版本',
  COST_VERSION_UPDATED: '修改成本版本',
  PURCHASE_ORDER_CREATED: '新建采购单',
  PURCHASE_ORDER_APPROVED: '批准采购单',
  PURCHASE_ORDER_SUBMITTED: '提交采购单',
  SUPPORT_ACCESS_GRANTED: '授权平台支持访问',
  SUPPORT_ACCESS_REVOKED: '撤销平台支持访问',
  SUPPORT_ACCESS_REQUEST: '平台支持访问请求',
  TENANT_SETTING_UPDATED: '修改企业设置',
  TENANT_PROFILE_UPDATED: '修改企业基本信息',
  PROFILE_UPDATED: '修改个人资料',
  USER_PREFERENCES_UPDATED: '修改通知偏好',
  SYNC_JOB_CREATED: '创建同步任务',
  SYNC_JOB_RETRIED: '重试同步任务',
  REIMBURSEMENT_CASE_CREATED: '创建赔付案件',
  REIMBURSEMENT_CASE_UPDATED: '更新赔付案件',
  PRICING_CALC_SAVED: '保存定价试算',
  CUSTOM_METRIC_CREATED: '创建自定义指标',
  CUSTOM_METRIC_UPDATED: '修改自定义指标',
  CUSTOM_METRIC_DELETED: '删除自定义指标',
  CUSTOM_REPORT_CREATED: '创建我的报表',
  CUSTOM_REPORT_UPDATED: '修改我的报表',
  CUSTOM_REPORT_DELETED: '删除我的报表',
  CUSTOM_REPORT_EXPORTED: '导出我的报表',
  DASHBOARD_FOLDER_CREATED: '创建仪表盘文件夹',
  DASHBOARD_FOLDER_UPDATED: '修改仪表盘文件夹',
  DASHBOARD_FOLDER_DELETED: '删除仪表盘文件夹',
  DASHBOARD_CREATED: '创建仪表盘',
  DASHBOARD_UPDATED: '修改仪表盘',
  DASHBOARD_DELETED: '删除仪表盘',
  DASHBOARD_WIDGET_CREATED: '创建仪表盘组件',
  DASHBOARD_WIDGET_UPDATED: '修改仪表盘组件',
  DASHBOARD_WIDGET_DELETED: '删除仪表盘组件',
}
export const auditActionLabel = (action: string) => AUDIT_ACTION_LABEL[action] ?? action

export const AUDIT_RESOURCE_LABEL: Readonly<Record<string, string>> = {
  Order: '订单',
  FbaReturnCase: '退货记录',
  SupportContact: '支持案件沟通',
  [PII_REVEAL_AUDIT_RESOURCE]: '个人信息',
  Membership: '成员',
  MemberInvitation: '成员邀请',
  Role: '角色',
  LegalEntity: '法律主体',
  SellerAccount: '店铺',
  ExportJob: '导出任务',
  Session: '登录会话',
  MfaFactor: '多因素认证',
  StepUp: '再次验证身份',
  AlertInstance: '预警',
  AlertRule: '预警规则',
  WorkItem: '待办',
  IntegrationSwitch: '写入开关',
  FxRate: '汇率',
  FxSourceConfig: '汇率来源',
  FinancePolicyVersion: '财务口径',
  AccountingPeriod: '账期',
  CostVersion: '成本版本',
  PurchaseOrder: '采购订单',
  Supplier: '供应商',
  FirstMileShipment: '头程',
  FbaInboundPlan: '入仓计划',
  ReimbursementCase: '赔付案件',
  SyncJob: '同步任务',
  TenantSetting: '企业设置',
  Tenant: '企业',
  User: '用户账号',
  UserPreference: '通知偏好',
  PlatformSupportAccess: '平台支持访问',
  PlatformConnection: '平台连接',
  PricingCalcRecord: '定价试算',
  NotificationSubscription: '消息订阅',
  Dashboard: '自定义仪表盘',
  DashboardFolder: '仪表盘文件夹',
  DashboardWidget: '仪表盘组件',
}
export const auditResourceLabel = (type: string) => AUDIT_RESOURCE_LABEL[type] ?? type

/** 资源类型对应的前端详情路径；没有独立详情页的类型返回 null。 */
export function auditResourcePath(type: string, id: string | null): string | null {
  const key = id ? encodeURIComponent(id) : null
  switch (type) {
    case 'Order':
      return key ? `/app/orders/${key}` : null
    case 'FbaReturnCase':
      return key ? `/app/returns/${key}` : null
    case 'Membership':
      return key ? `/app/members/${key}` : null
    case 'AlertInstance':
      return key ? `/app/alerts/${key}` : null
    case 'PurchaseOrder':
      return key ? `/app/purchase-orders/${key}` : null
    case 'Supplier':
      return key ? `/app/suppliers/${key}` : null
    case 'FirstMileShipment':
      return key ? `/app/first-mile/${key}` : null
    case 'FbaInboundPlan':
      return key ? `/app/supply-chain/${key}` : null
    case 'ReimbursementCase':
      return key ? `/app/reimbursements/${key}` : null
    case 'Dashboard':
      return key ? `/app/dashboards/${key}` : null
    case 'AccountingPeriod':
      return key ? `/app/finance/periods/${key}` : null
    case 'SyncJob':
      return key ? `/app/sync/${key}` : null
    case 'LegalEntity':
      return key ? `/app/entities/${key}` : null
    case 'Role':
      return '/app/roles'
    case 'ExportJob':
      return '/app/my/exports'
    default:
      return null
  }
}

// ---- 个人信息明文查看 ----

/** 视为“查看个人信息明文”的审计动作；以后新增明文查看入口时在这里登记，视图、汇总与预警都按它取数。 */
export const PII_VIEW_ACTIONS: readonly string[] = ['ORDER_BUYER_PII_VIEWED', PII_REVEAL_ACTION]
/** 买家信息字段（与解密后的内容同名）。审计里只记字段名，永不记内容。 */
export const PII_FIELD_LABEL: Readonly<Record<string, string>> = {
  buyerName: '姓名',
  buyerEmail: '邮箱',
  buyerPhone: '电话',
  addressLine1: '地址',
  city: '城市',
  state: '州或省',
  postalCode: '邮编',
  country: '国家或地区',
  customerComments: '退货买家备注',
  body: '沟通内容',
}
export const PII_FIELD_KEYS: readonly string[] = ORDER_PII_FIELDS
export const PII_OUTCOMES = ['OK', 'EXPIRED', 'NOT_SYNCED'] as const
export const PII_OUTCOME_LABEL: Readonly<Record<string, string>> = {
  OK: '已查看',
  EXPIRED: '已过保留期，没有内容可看',
  NOT_SYNCED: '没有买家信息，没有内容可看',
  DENIED: '被拒绝',
  UNKNOWN: '结果未记录',
}

/** 大量查看明文预警（预置规则 SYS_PII_BULK_VIEW）的规则代码与评估器类型。 */
export const PII_BULK_VIEW_RULE_CODE = 'SYS_PII_BULK_VIEW'
export const PII_BULK_VIEW_RULE_TYPE = 'audit.pii-bulk-view'
/** 预警对象类型：查看明文的人。 */
export const PII_VIEWER_ENTITY = 'PII_VIEWER'

// ---- 操作人与访问模式的判断（接口与导出共用，保证页面与文件里的“操作人”一致）----

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** 审计详情里记的访问模式；旧记录没有记，按正常访问。 */
export function auditAccessModeOfDetail(detail: unknown): string {
  const mode = asRecord(detail).accessMode
  return typeof mode === 'string' && mode ? mode : 'NORMAL'
}

/** 已离开（停用或移除）的成员在审计里的显示名，与接口基础设施里的写法一致。 */
export const AUDIT_FORMER_MEMBER_LABEL = '已离开的成员'
export const AUDIT_PLATFORM_ACTOR_LABEL = '平台人员'

export interface AuditActorSource {
  actorId: string | null
  source: string | null
  detail: unknown
}

/**
 * 审计里的操作人：平台人员（访问模式是平台操作或支持访问，或详情里带平台人员编号）、系统（系统任务，包括后台任务代为写入）、企业成员、未记录。
 * 系统任务代为写入时 actorId 是真正的发起人，保留在 id 里，名字一律显示“系统”。
 */
export function auditActorOf(event: AuditActorSource, names: ReadonlyMap<string, string>): AuditActorView {
  const mode = auditAccessModeOfDetail(event.detail)
  if (mode === 'PLATFORM' || mode === 'SUPPORT' || typeof asRecord(event.detail).platformAdminId === 'string' || Boolean(event.actorId?.startsWith('support:')))
    return { id: null, name: AUDIT_PLATFORM_ACTOR_LABEL, kind: 'SUPPORT' }
  if (auditSourceOf(event.source, event.actorId) === 'SYSTEM') return { id: event.actorId, name: '系统', kind: 'SYSTEM' }
  if (event.actorId) return { id: event.actorId, name: names.get(event.actorId) ?? AUDIT_FORMER_MEMBER_LABEL, kind: 'USER' }
  return { id: null, name: '未记录', kind: 'SYSTEM' }
}

// ---- 响应 ----

export interface AuditActorView {
  /** 系统任务写的审计可能带着发起人（例如导出完成由后台任务写入，发起人是请求导出的人）。 */
  id: string | null
  name: string
  kind: 'USER' | 'SYSTEM' | 'SUPPORT'
}

export interface AuditRow {
  id: string
  occurredAt: string
  actor: AuditActorView
  source: AuditSource | null
  sourceLabel: string
  /** 所属页面（前端路径模板）；接口调用、系统任务与旧记录为空。 */
  page: string | null
  action: string
  actionLabel: string
  resourceType: string
  resourceLabel: string
  resourceId: string | null
  result: string
  resultLabel: string
  requestId: string
  reason: string | null
  accessMode: string
  accessModeLabel: string
}

export interface AuditListResponse {
  items: AuditRow[]
  pageInfo: CursorPageInfo
  /** 能不能发起导出（需要 export.create）；不能时给原因，页面置灰。 */
  canExport: boolean
  exportBlockedReason: string | null
}

export interface AuditOption {
  value: string
  label: string
}

export interface AuditOptionsResponse {
  windowDays: number
  actions: AuditOption[]
  resourceTypes: AuditOption[]
  pages: string[]
  actors: AuditOption[]
  /** 某一类选项超过上限被截断。 */
  truncated: boolean
}

export interface AuditChange {
  field: string
  before: unknown
  after: unknown
}

export interface AuditRelatedRow {
  id: string
  occurredAt: string
  actorName: string
  actionLabel: string
  result: string
  resultLabel: string
}

export interface AuditDetailResponse {
  event: AuditRow & {
    ip: string | null
    userAgent: string | null
    writeRunId: string | null
    /** 这次操作是否经过再次验证身份。 */
    stepUpVerified: boolean
    /** 系统任务代为写入时，真正发起的人。 */
    initiator: AuditActorView | null
  }
  /** 修改前后的字段级差异；没有修改前后的快照（读取类、系统类事件）时为空。 */
  changes: AuditChange[]
  hasSnapshot: boolean
  /** 事件附带的其他说明（已脱敏），按键名排序。 */
  extra: Array<{ key: string; value: string }>
  resource: { type: string; label: string; id: string | null; path: string | null; recent: AuditRelatedRow[]; recentTruncated: boolean }
}

export interface PiiViewRow {
  id: string
  occurredAt: string
  actor: AuditActorView
  reason: string | null
  object: { type: string; typeLabel: string; id: string | null; label: string; path: string | null }
  /** 本次返回了哪些字段（中文名）；旧记录没有记，为 null。 */
  fields: string[] | null
  outcome: string
  outcomeLabel: string
  accessMode: string
  accessModeLabel: string
  requestId: string
}

export interface PiiViewListResponse {
  items: PiiViewRow[]
  pageInfo: CursorPageInfo
  summary: { last24h: number; last7d: number; topViewers: Array<{ actorId: string | null; name: string; count: number }> }
  /** 大量查看预警规则的当前设置；规则还没补进企业（后台尚未跑过评估）时为 null。 */
  alertRule: { enabled: boolean; windowMinutes: number; maxViews: number } | null
}
