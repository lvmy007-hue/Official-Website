import type { FreshnessViewStatus } from './freshness.js'
import type { InventoryFreshness } from './inventory.js'
import type { PiiKind } from './pii.js'
import { cursorListQuery, type CursorPageInfo } from './query.js'

// 支持案件（P2b-04，07 章 7.4，importers.md I-20）：亚马逊卖家支持接口（Support API v2025-02-01）的只读同步。
// 所有修改（回复、上传附件、预约回电）都在卖家后台进行，这里只读；接口需要“卖家支持”受限角色，未获批时同步失败码为 SUP_ROLE_PENDING，页面显示申请方式，
// 此时赔付案件里的亚马逊案件编号仍可手工回填。本文件只放常量、请求校验、响应类型与几个纯函数。

export const SUPPORT_READ = 'support.read'
export const SUPPORT_SYNC_JOB = 'SUPPORT_SYNC'
export const SUPPORT_FRESHNESS_KEY = 'support.api'
/** 受限角色“卖家支持”未获批：接口返回 403。同步任务以这个失败码结束，新鲜度状态为“未授权”。 */
export const SUPPORT_ROLE_PENDING = 'SUP_ROLE_PENDING'
export const SUPPORT_ROLE_GUIDE =
  '亚马逊卖家支持接口需要“Selling Partner Support”受限角色：在亚马逊开发者控制台的应用资料里勾选该角色并提交审核，审核通过后到连接中心重新授权店铺，案件会在下一次同步（每 2 小时）出现。' +
  '审核期间赔付案件里的“亚马逊案件编号”仍可手工回填。'

/** 沟通记录正文的存储上限（字），超出截断；每个案件最多同步的沟通条数。 */
export const SUPPORT_BODY_MAX = 20_000
export const SUPPORT_CONTACTS_PER_CASE_MAX = 500

export const SUPPORT_CASE_STATUSES = ['PENDING_AMAZON_ACTION', 'PENDING_MERCHANT_ACTION', 'TRANSFERRED', 'RESOLVED'] as const
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number]
export const SUPPORT_STATUS_LABEL: Readonly<Record<SupportCaseStatus, string>> = {
  PENDING_AMAZON_ACTION: '等待亚马逊处理',
  PENDING_MERCHANT_ACTION: '等待卖家处理',
  TRANSFERRED: '已转交',
  RESOLVED: '已解决',
}
/** 亚马逊新增了我们不认识的状态时，显示原值而不是猜一个中文。 */
export const supportStatusLabel = (status: string): string => SUPPORT_STATUS_LABEL[status as SupportCaseStatus] ?? `其他状态（${status}）`

export const SUPPORT_CHANNEL_LABEL: Readonly<Record<string, string>> = { EMAIL: '邮件', PHONE: '电话', CHAT: '在线聊天' }
export const supportChannelLabel = (channel: string): string => SUPPORT_CHANNEL_LABEL[channel] ?? channel

export const SUPPORT_DIRECTIONS = ['FROM_AMAZON', 'FROM_SELLER', 'UNKNOWN'] as const
export type SupportDirection = (typeof SUPPORT_DIRECTIONS)[number]
export const SUPPORT_DIRECTION_LABEL: Readonly<Record<SupportDirection, string>> = { FROM_AMAZON: '亚马逊', FROM_SELLER: '我方', UNKNOWN: '未标明' }

export const SUPPORT_APPOINTMENT_STATUS_LABEL: Readonly<Record<string, string>> = { SCHEDULED: '已预约', CANCELLED: '已取消', MISSED: '未接通', COMPLETED: '已完成' }

export const SupportCaseListQuerySchema = cursorListQuery({
  sortable: ['amazonUpdatedAt', 'amazonCreatedAt'],
  defaultSort: { field: 'amazonUpdatedAt', dir: 'desc' },
  filters: { status: { type: 'enum', values: SUPPORT_CASE_STATUSES } },
})
export type SupportCaseListQuery = ReturnType<typeof SupportCaseListQuerySchema.parse>

/** 案件主题里的亚马逊入仓货件编号（FBA 开头的字母数字串）：推算“关联货件”用，去重后最多 5 个。 */
export function shipmentRefsOfSubject(subject: string): string[] {
  const found = subject.toUpperCase().match(/\bFBA[0-9A-Z]{6,14}\b/g) ?? []
  return [...new Set(found)].slice(0, 5)
}

// ---- 响应 ----

/** 同步状态：页面据此区分“没有案件”“还没同步”“受限角色没批”。 */
export interface SupportSync {
  status: FreshnessViewStatus
  statusLabel: string
  lastSuccessAt: string | null
  errorCode: string | null
  errorMessage: string | null
  /** 受限角色未获批（失败码 SUP_ROLE_PENDING）。 */
  rolePending: boolean
}

export interface SupportCaseRow {
  id: string
  caseId: string
  sellerAccountId: string
  storeName: string
  subject: string
  status: string
  statusLabel: string
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  lastOutboundAt: string | null
  /** 已同步的沟通条数；沟通记录还没同步（案件刚出现或更新后尚未重取）时为 null，页面写“尚未同步”，不写 0。 */
  contactCount: number | null
  /** 关联的赔付案件（赔付案件里回填的亚马逊案件编号与本案件一致）。 */
  reimbursementCaseId: string | null
  reimbursementCaseNo: string | null
}

export type SupportListState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'ROLE_PENDING'

export interface SupportCaseListResponse {
  state: SupportListState
  note: string | null
  items: SupportCaseRow[]
  pageInfo: CursorPageInfo
  sync: SupportSync
  freshness: InventoryFreshness
}

export interface SupportContactRow {
  id: string
  contactId: string
  channel: string
  channelLabel: string
  direction: SupportDirection
  directionLabel: string
  senderName: string | null
  /** 正文（P6-14）：自动识别并掩码其中的电话、邮箱、地址，原文要走 POST /pii/reveal（SUPPORT_CONTACT、body）。 */
  body: string
  /** 正文里被掩码的个人信息类别；为空表示没有识别出需要掩码的内容。 */
  piiKinds: PiiKind[]
  /** 只有附件名称（亚马逊给的下载链接 15 分钟失效，不保存）。 */
  attachments: string[]
  occurredAt: string
}

export interface SupportAppointmentRow {
  appointmentId: string
  status: string
  statusLabel: string
  earliestAt: string
  latestAt: string
  answeringParty: string | null
}

export interface SupportLinks {
  reimbursement: { id: string; caseNo: string; statusLabel: string } | null
  /** 货件：来自赔付案件的货件证据，或案件主题里写的 FBA 货件编号（后者是文字推算，页面标明）。ref 是接收页的路径参数。 */
  shipments: Array<{ ref: string; label: string; via: 'EVIDENCE' | 'SUBJECT' }>
  /** 商品：来自赔付案件的 SKU。 */
  products: Array<{ id: string; sku: string; asin: string | null }>
}

export interface SupportCaseDetailResponse {
  case: SupportCaseRow
  appointments: SupportAppointmentRow[]
  contacts: SupportContactRow[]
  /** 沟通记录是否已同步；没同步时写原因，不当作“没有沟通”。 */
  contactsState: 'OK' | 'NOT_SYNCED' | 'NO_DATA'
  contactsNote: string | null
  links: SupportLinks
  sync: SupportSync
  freshness: InventoryFreshness
}

/** 赔付案件详情里的“关联的亚马逊支持案件”。 */
export type SupportLinkView =
  | { state: 'RESTRICTED'; note: string }
  | { state: 'NO_ID'; note: string }
  | { state: 'NOT_CONNECTED'; note: string }
  | { state: 'NOT_FOUND'; note: string }
  | { state: 'OK'; case: SupportCaseRow; contacts: SupportContactRow[] }

/** 列表页整体状态：有行就是 OK；没有行时按同步状态区分，不把“没同步”说成“没有案件”。 */
export function supportListState(sync: SupportSync, hasRows: boolean): { state: SupportListState; note: string | null } {
  if (hasRows) return { state: 'OK', note: null }
  if (sync.rolePending) return { state: 'ROLE_PENDING', note: SUPPORT_ROLE_GUIDE }
  if (sync.status === 'NO_RECORD' || sync.status === 'NOT_CONNECTED') return { state: 'NOT_CONNECTED', note: '支持案件尚未同步：店铺授权后每 2 小时同步一次' }
  if (sync.status === 'NORMAL' || sync.status === 'DELAYED') return { state: 'NO_DATA', note: '尚无记录：亚马逊卖家支持里没有这个店铺的案件' }
  return { state: 'NOT_CONNECTED', note: sync.errorMessage ?? '支持案件同步没有成功，暂时没有可显示的数据' }
}
