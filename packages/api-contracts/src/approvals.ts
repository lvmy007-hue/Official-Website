import type { CursorPageInfo } from './query'

// 审批收件箱（P6-27，16 章第 1 节）：只有常量、类型与纯函数（zod 在 approvals-query.ts，前端只引这个文件）。
// 各模块原有的审批仍是事实来源（财务口径、利润公式与业务口径、关账）；这里是统一的登记与入口，状态双向同步。

export const APPROVAL_TYPES = ['FINANCE_POLICY', 'PROFIT_FORMULA', 'PERIOD_CLOSE', 'PRICING_RULE_CONFIRM', 'ADS_RULE_CONFIRM', 'BULK_PRICE', 'BULK_BUDGET'] as const
export type ApprovalType = (typeof APPROVAL_TYPES)[number]
export const APPROVAL_TYPE_LABEL: Readonly<Record<ApprovalType, string>> = {
  FINANCE_POLICY: '财务口径变更',
  PROFIT_FORMULA: '利润公式与业务口径变更',
  PERIOD_CLOSE: '期间关账',
  PRICING_RULE_CONFIRM: '定价规则人工确认',
  ADS_RULE_CONFIRM: '广告自动规则人工确认',
  BULK_PRICE: '批量改价',
  BULK_BUDGET: '批量改预算',
}

/** 已经把审批登记进收件箱的类型；其余类型在对应模块出现“人工审批”步骤前，只有登记入口，没有单据。 */
export const APPROVAL_CONNECTED_TYPES: readonly ApprovalType[] = ['FINANCE_POLICY', 'PROFIT_FORMULA', 'PERIOD_CLOSE']

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export const APPROVAL_REQUEST_STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = { PENDING: '待处理', APPROVED: '已通过', REJECTED: '已驳回', CANCELLED: '已撤回' }

/** 左侧信箱：我审批的、我发起的、抄送我的、我处理过的。 */
export const APPROVAL_BOXES = ['TODO', 'SENT', 'CC', 'DONE'] as const
export type ApprovalBox = (typeof APPROVAL_BOXES)[number]
export const APPROVAL_BOX_LABEL: Readonly<Record<ApprovalBox, string>> = { TODO: '我审批的', SENT: '我发起的', CC: '抄送我的', DONE: '我处理过的' }

/** 顶部状态：待处理、已处理（通过、驳回、撤回都算已处理）。 */
export const APPROVAL_STATES = ['PENDING', 'DONE'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]
export const APPROVAL_STATE_LABEL: Readonly<Record<ApprovalState, string>> = { PENDING: '待处理', DONE: '已处理' }

export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

export const APPROVAL_COMMENT_MAX = 500
export const APPROVAL_APPROVER_LIMIT = 50
export const APPROVAL_PAGE_SIZE_MAX = 100

/** 查看收件箱只需要登录并属于企业（基础权限）；处理时沿用各单据原模块的审批权限。 */
export const APPROVAL_DECISION_ACTION = 'APPROVAL_DECIDED'

/** 摘要里每一项：名称与取值，抽屉里按行显示。 */
export interface ApprovalSummaryItem {
  label: string
  value: string
}

export interface ApprovalRow {
  id: string
  type: ApprovalType
  typeLabel: string
  title: string
  objectType: string
  objectId: string
  status: ApprovalStatus
  statusLabel: string
  summary: ApprovalSummaryItem[]
  requesterId: string
  requesterName: string
  approverNames: string[]
  ccNames: string[]
  decidedByName: string | null
  decidedAt: string | null
  comment: string | null
  createdAt: string
  version: number
  /** 当前用户能否在收件箱里处理：待处理，且是被登记的审批人（或发起人本人撤回）。 */
  canDecide: boolean
  /** 当前用户是发起人时，驳回按钮就是“撤回”。 */
  isRequester: boolean
  /** 单据在原模块里的页面，用于“查看详情”。 */
  detailPath: string | null
}

export interface ApprovalCounts {
  todoPending: number
  sentPending: number
  ccPending: number
}

export interface ApprovalListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  box: ApprovalBox
  filter: ApprovalState
  items: ApprovalRow[]
  counts: ApprovalCounts
  pageInfo: CursorPageInfo
}

export interface ApprovalDecisionResult {
  id: string
  status: ApprovalStatus
  statusLabel: string
  message: string
}

/** 登记摘要：把任意值转成抽屉里一行一项的文字，空值不显示。 */
export function summaryItems(raw: unknown): ApprovalSummaryItem[] {
  if (!Array.isArray(raw)) return []
  const out: ApprovalSummaryItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { label, value } = entry as { label?: unknown; value?: unknown }
    if (typeof label !== 'string' || label === '' || value === null || value === undefined || value === '') continue
    out.push({ label: label.slice(0, 60), value: String(value).slice(0, 300) })
    if (out.length >= 30) break
  }
  return out
}

/** 单据在原模块里的详情页。 */
export function approvalDetailPath(type: string, objectType: string, objectId: string): string | null {
  if (type === 'FINANCE_POLICY') return '/app/settings'
  if (type === 'PROFIT_FORMULA') return objectType === 'MetricVersion:BUSINESS_RULES' ? '/app/settings/business-rules' : '/app/finance/profit-formula'
  if (type === 'PERIOD_CLOSE') return `/app/finance/periods/${encodeURIComponent(objectId)}`
  return null
}

/** 状态变化是否算“已处理”。 */
export const isApprovalDone = (status: string): boolean => status !== 'PENDING'
