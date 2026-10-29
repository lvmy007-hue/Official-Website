import { z } from 'zod'
import type { AlertRuleDomain, AlertRuleSeverity } from './alert-rules.js'
import { cursorListQuery, type CursorPageInfo } from './query.js'

// 风险预警中心（P5-01，09 章 9.1）：预警列表、预警详情、四个处理动作（确认、忽略、分派、关闭）。规则配置的契约在 alert-rules-config.ts。
// 预警实例由后台评估器生成；处理预警会同步它关联的待办（确认 → 待办“处理中”，忽略与关闭 → 待办关闭，分派 → 待办换负责人）。

export const ALERTS_READ = 'alerts.read'
export const ALERTS_HANDLE = 'alerts.handle'
export const ALERTS_MANAGE = 'alerts.manage'

/** 09 章 9.1 的业务域顺序：库存、商品、售后与口碑、财务、广告、系统与账户。 */
export const ALERT_DOMAINS = ['INVENTORY', 'PRODUCT', 'AFTER_SALES', 'FINANCE', 'ADS', 'SYSTEM'] as const satisfies readonly AlertRuleDomain[]
export const ALERT_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const satisfies readonly AlertRuleSeverity[]
export const ALERT_SEVERITY_LABEL: Readonly<Record<AlertRuleSeverity, string>> = { CRITICAL: '严重', WARNING: '警告', INFO: '提示' }
export const ALERT_STATUS_LABEL: Readonly<Record<string, string>> = { NEW: '新预警', ACKED: '处理中', HANDLED: '已处理', IGNORED: '已忽略', AUTO_CLOSED: '已恢复' }

/** 列表的视图：待处理（新预警与处理中）、已处理、已忽略（含无需处理与误报）、已恢复（命中消失自动关闭）、全部。 */
export const ALERT_VIEWS = ['open', 'handled', 'ignored', 'recovered', 'all'] as const
export type AlertView = (typeof ALERT_VIEWS)[number]
export const ALERT_VIEW_LABEL: Readonly<Record<AlertView, string>> = { open: '待处理', handled: '已处理', ignored: '已忽略', recovered: '已恢复', all: '全部' }
export const ALERT_VIEW_STATUSES: Readonly<Record<AlertView, readonly string[] | null>> = {
  open: ['NEW', 'ACKED'],
  handled: ['HANDLED'],
  ignored: ['IGNORED'],
  recovered: ['AUTO_CLOSED'],
  all: null,
}

/** 关闭预警的结论（必填）：误报会计入规则的误报率。 */
export const ALERT_CLOSE_CONCLUSIONS = ['HANDLED', 'NOT_NEEDED', 'FALSE_POSITIVE'] as const
export const ALERT_CONCLUSION_LABEL: Readonly<Record<string, string>> = { HANDLED: '已处理', NOT_NEEDED: '无需处理', FALSE_POSITIVE: '误报', IGNORED: '已忽略' }

/** 已读状态（P6-15）：按用户记录，与上面的处理状态互不影响。 */
export const ALERT_READ_STATES = ['unread', 'read'] as const
export type AlertReadState = (typeof ALERT_READ_STATES)[number]
export const ALERT_READ_STATE_LABEL: Readonly<Record<AlertReadState, string>> = { unread: '未读', read: '已读' }

/** 批量标记已读、批量标记已处理一次最多处理的条数。 */
export const ALERT_BATCH_MAX = 100

const idText = z.string().min(1).max(64)

export const AlertListQuerySchema = cursorListQuery({
  scope: false,
  sortable: ['lastTriggeredAt'],
  defaultSort: { field: 'lastTriggeredAt', dir: 'desc' },
  filters: {
    // handleState 是 view 的新名字（同一组取值，两个都传时以 handleState 为准）；readState 是按人的已读筛选。
    handleState: { type: 'enum', values: ALERT_VIEWS },
    readState: { type: 'enum', values: ALERT_READ_STATES },
    view: { type: 'enum', values: ALERT_VIEWS },
    domain: { type: 'enum', values: ALERT_DOMAINS },
    severity: { type: 'enum', values: ALERT_SEVERITIES },
    ruleId: { type: 'text', max: 64 },
  },
})
export type AlertListQuery = z.infer<typeof AlertListQuerySchema>

export const AlertAckBodySchema = z.object({ note: z.string().trim().max(500).optional() })
export const AlertIgnoreBodySchema = z.object({ reason: z.string().trim().min(2, '忽略必须填写原因').max(500) })
export const AlertAssignBodySchema = z.object({ assigneeId: idText, note: z.string().trim().max(500).optional() })
export const AlertCloseBodySchema = z.object({ conclusion: z.enum(ALERT_CLOSE_CONCLUSIONS, { error: '请选择关闭结论' }), note: z.string().trim().max(1000).optional() })

/** 批量标记已读：只改我自己的已读状态，不改预警的处理状态。 */
export const AlertReadBodySchema = z.object({
  ids: z.array(idText).min(1, '请选择至少一条预警').max(ALERT_BATCH_MAX, `一次最多处理 ${ALERT_BATCH_MAX} 条`),
})
/** 批量标记已处理：逐条按“关闭，结论已处理”执行，各条互不影响。 */
export const AlertBatchHandleBodySchema = z.object({
  ids: z.array(idText).min(1, '请选择至少一条预警').max(ALERT_BATCH_MAX, `一次最多处理 ${ALERT_BATCH_MAX} 条`),
  note: z.string().trim().max(1000).optional(),
})

export interface AlertReadResponse {
  /** 本次新标成已读的条数（本来就已读的不重复计） */
  marked: number
  /** 请求里不在你数据范围内或不存在的编号（按“不存在”处理，不泄露是否真有这条） */
  missing: string[]
  unreadCount: number
}

export interface AlertBatchHandleResponse {
  handled: number
  /** 没处理成功的预警及原因（已被他人处理、不在范围内等） */
  skipped: Array<{ id: string; reason: string }>
  unreadCount: number
}

export interface AlertEntityRef {
  type: string
  id: string
  /** 对象名称（店铺、SKU、数据来源等）；旧预警可能没有，用对象编号代替 */
  label: string
  /** 对象详情页地址；没有独立详情页的对象为 null（页面显示“尚无详情页”） */
  path: string | null
}

export interface AlertImpact {
  min: number | null
  max: number | null
  currency: string
}

export interface AlertListItem {
  id: string
  ruleId: string
  ruleCode: string
  ruleName: string
  domain: AlertRuleDomain
  domainLabel: string
  severity: AlertRuleSeverity
  status: string
  statusLabel: string
  title: string
  entity: AlertEntityRef
  storeName: string | null
  /** 影响金额区间；评估器没有可靠依据时为 null（不写 0） */
  impact: AlertImpact | null
  suggestedAction: string | null
  /** 负责人（关联待办的负责人）；没有待办时为 null，页面显示“尚未分派” */
  owner: { id: string; name: string } | null
  /** 同一规则同一对象在上一条还没处理时反复命中，并进这一条后的触发次数（列表显示“触发 N 次”） */
  triggerCount: number
  ruleVersionNo: number
  firstTriggeredAt: string
  lastTriggeredAt: string
  resolvedAt: string | null
  /** 我是否已读（按用户记录；与处理状态互不影响） */
  read: boolean
}

export interface AlertListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: AlertListItem[]
  pageInfo: CursorPageInfo
  /** 各视图的条数（受成员数据范围限制，不受业务域与严重度筛选影响） */
  counts: Record<AlertView, number>
  /** 待处理预警在各业务域的条数 */
  domainOpenCounts: Record<AlertRuleDomain, number>
  /** 我的未读预警数（只算待处理的；与顶栏铃铛同口径，受数据范围限制） */
  unreadCount: number
}

/** 顶栏与列表共用的口径：已处理、已忽略、已恢复的预警不再算“未读”。 */
export const ALERT_UNREAD_STATUSES = ['NEW', 'ACKED'] as const

export interface AlertEvidenceRow {
  label: string
  value: string
}

export interface AlertHistoryItem {
  id: string
  current: boolean
  status: string
  statusLabel: string
  severity: AlertRuleSeverity
  triggerCount: number
  firstTriggeredAt: string
  lastTriggeredAt: string
  resolvedAt: string | null
  conclusionLabel: string | null
}

export interface AlertTimelineItem {
  id: string
  at: string
  title: string
  actor: string
}

export interface AlertDetailResponse {
  alert: AlertListItem
  rule: {
    id: string
    code: string
    name: string
    description: string
    severity: AlertRuleSeverity
    cooldownMinutes: number
    enabled: boolean
    /** 触发这条预警时生效的规则版本，与当前版本不同说明规则之后被改过 */
    versionNo: number
    currentVersion: number
    /** 触发时的阈值（按规则版本留存的快照） */
    thresholds: Array<{ label: string; value: string }>
  }
  evidence: AlertEvidenceRow[]
  history: AlertHistoryItem[]
  /** 同一规则最近 30 天每天新增的预警条数（范围内、含所有对象），用来判断这条预警是个例还是在扩散 */
  ruleTrend: Array<{ date: string; count: number }>
  timeline: AlertTimelineItem[]
  workItem: { id: string; status: string; dueAt: string | null; path: string } | null
  closeInfo: { conclusionLabel: string | null; note: string | null; closedByName: string | null; closedAt: string | null } | null
  can: { handle: boolean }
  /** 可分派的在职成员（只有能处理预警的人才返回） */
  assignees: Array<{ id: string; name: string }>
}

export interface AlertActionResponse {
  id: string
  status: string
  statusLabel: string
}
