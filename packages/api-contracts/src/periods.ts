import type { BridgeDirection, BridgeKey, ProfitAmounts, ProfitBasis } from './profit.js'

// 期间关账（P2b-13，07 章 7.12，freeze/api.md /finance/periods*）的常量与类型。纯类型与常量，不含 zod：前端用到这里的东西不会把校验代码带进首屏（请求校验在 periods-query.ts）。
// 关账流程：创建期间（一个店铺一个自然月）→ 完整性检查清单 → 预览关账报表 → 审批 → 锁定（对利润日表、汇率、成本版本做快照）；锁定后重新开账需要更高权限、填写原因并再次验证身份。
// 纯函数（检查项判定、检查清单合并、可用动作、快照合计、预览、差异报告）在 periods-math.ts。

export const PERIOD_READ = 'finance.read'
export const PERIOD_CLOSE = 'finance.period.close'
export const PERIOD_REOPEN = 'finance.period.reopen'

/** 开放（刚创建或检查没通过）、关账中（检查已通过，等审批与锁定；这期间利润日表对该店铺该期间停止重算）、已关账、重新开账（可修正后重新检查）。 */
export const PERIOD_STATUSES = ['OPEN', 'CLOSING', 'CLOSED', 'REOPENED'] as const
export type PeriodStatus = (typeof PERIOD_STATUSES)[number]
export const PERIOD_STATUS_LABEL: Readonly<Record<PeriodStatus, string>> = { OPEN: '开放', CLOSING: '关账中', CLOSED: '已关账', REOPENED: '重新开账' }
export const PERIOD_STATUS_NOTE: Readonly<Record<PeriodStatus, string>> = {
  OPEN: '数据还在更新；先做完整性检查，通过后进入“关账中”。',
  CLOSING: '完整性检查已通过，等待另一位有关账权限的成员审批，审批后即可锁定。这期间利润日表对该店铺该期间停止重算，审批看到的数字就是锁定的数字。',
  CLOSED: '已锁定：利润日表不再重算，期间内的汇率禁止修改，快照已保存。需要修正只能重新开账。',
  REOPENED: '已重新开账：数据恢复更新，修正后重新检查、审批、锁定；锁定时会生成与上一份快照的差异报告。',
}

/** 列表分页上限与各类取数上限（我们定的数）。 */
export const PERIOD_MONTH_LIMIT_YEARS = 5
/** 成本覆盖率（已计成本件数 ÷ 销售件数）的达标线。 */
export const PERIOD_COST_COVERAGE_MIN = 0.95
/** 广告分摊完成后，仍未分摊的广告花费不超过它算分摊完成（美元）。 */
export const PERIOD_ADS_TOLERANCE = 0.05
/** 检查“各数据域同步完整”要求已有同步记录且覆盖到期间结束的来源。 */
export const PERIOD_SYNC_SOURCES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'orders.api', label: '订单' },
  { key: 'finance.transactions', label: '财务交易' },
]
export const PERIOD_SETTLEMENT_LIMIT = 200
/** 一个检查项最多列出几条具体问题，其余只计数。 */
export const PERIOD_DETAIL_LIMIT = 8
/** 快照里每种口径最多保存多少个 SKU 的汇总（按销售额从高到低）；超过的只保存在合计里并标记不完整。 */
export const PERIOD_SNAPSHOT_SKU_LIMIT = 3000
/** 快照里成本版本最多保存多少条（Prisma 单次读取上限 20000，读 N 行判断截断要多读一行，所以是 19,999）。 */
export const PERIOD_SNAPSHOT_COST_LIMIT = 19_999
/** 差异报告里逐 SKU、逐汇率、逐成本版本最多列出多少条（按变化从大到小）。 */
export const PERIOD_DIFF_LIMIT = 50
/** 差异报告里金额变化不超过它不算变化（美元，避免舍入噪音）。 */
export const PERIOD_DIFF_TOLERANCE = 0.005
export const PERIOD_NOTE_MAX = 300
export const PERIOD_SNAPSHOT_VERSION = 1

// ---- 完整性检查清单 ----

export const CHECK_KEYS = ['SYNC_COMPLETE', 'SETTLEMENTS_ARRIVED', 'COST_COVERAGE', 'FX_COMPLETE', 'ADS_ALLOCATED', 'RECON_EXCEPTIONS'] as const
export type CheckKey = (typeof CHECK_KEYS)[number]
export const CHECK_LABEL: Readonly<Record<CheckKey, string>> = {
  SYNC_COMPLETE: '各数据域同步完整',
  SETTLEMENTS_ARRIVED: '结算已到',
  COST_COVERAGE: '成本覆盖率达标',
  FX_COMPLETE: '汇率齐全',
  ADS_ALLOCATED: '广告分摊完成',
  RECON_EXCEPTIONS: '对账异常已处理或已确认',
}
/** 只有这两项可以由有关账权限的人“确认放行”（写明原因、留痕）；其余是数据本身有缺口，必须补齐，不能放行。 */
export const CHECK_ACKNOWLEDGEABLE = ['ADS_ALLOCATED', 'RECON_EXCEPTIONS'] as const
export type AcknowledgeableKey = (typeof CHECK_ACKNOWLEDGEABLE)[number]

/** 通过、未通过、尚未接入（数据来源还没有上线）、已确认放行（本来没通过或未接入，经人确认）。 */
export type CheckState = 'PASS' | 'FAIL' | 'NOT_CONNECTED' | 'ACKNOWLEDGED'
export type CheckBaseState = 'PASS' | 'FAIL' | 'NOT_CONNECTED'
export const CHECK_STATE_LABEL: Readonly<Record<CheckState, string>> = { PASS: '通过', FAIL: '未通过', NOT_CONNECTED: '尚未接入', ACKNOWLEDGED: '已确认放行' }

export interface CheckAcknowledgement {
  /** 确认放行的成员编号（接口返回时换成姓名）。 */
  by: string
  at: string
  note: string
  /** 确认时这一项的数字（例如未处理的异常条数）；之后数字变了，确认失效，需要重新确认。 */
  value: number | null
}

export interface CheckItem {
  key: CheckKey
  label: string
  state: CheckState
  /** 确认放行之前的判定。 */
  baseState: CheckBaseState
  summary: string
  details: string[]
  value: number | null
  acknowledgeable: boolean
  acknowledgement: CheckAcknowledgement | null
}

export interface PeriodChecklist {
  checkedAt: string
  passed: boolean
  items: CheckItem[]
}

// ---- 利润快照 ----

/** 一个口径一份合计：利润日表各列的合计（可空列全为空才为 null），profit 是整体净利润（有一行缺成本就是 null）。 */
export interface SnapTotals extends ProfitAmounts {
  rows: number
  incompleteRows: number
  profit: number | null
}

/** 一个 SKU 的期间汇总（费用合计成一列）。 */
export interface SnapSku {
  sku: string
  asin: string | null
  units: number
  costedUnits: number
  revenue: number
  refunds: number
  fees: number
  promotion: number
  ads: number | null
  productCost: number | null
  firstMileCost: number | null
  otherCost: number | null
  reimbursement: number
  profit: number | null
}

export interface BasisSnapshot {
  totals: SnapTotals
  skus: SnapSku[]
  skuCount: number
  truncated: boolean
}

export interface ProfitSnapshot {
  version: number
  metricVersions: string[]
  from: string
  to: string
  bases: Record<ProfitBasis, BasisSnapshot>
}

export interface FxSnapRate {
  quote: string
  date: string
  rate: number
  source: string
  fallback: boolean
  manual: boolean
}
export interface FxSnapshot {
  from: string
  to: string
  currencies: string[]
  rates: FxSnapRate[]
}

export interface CostSnapVersion {
  sku: string
  versionNo: number
  status: string
  effectiveFrom: string
  currency: string
  productCost: number | null
  firstMileCost: number | null
  otherCost: number | null
}
export interface CostSnapshot {
  asOf: string
  skuCount: number
  truncated: boolean
  versions: CostSnapVersion[]
}

// ---- 差异报告 ----

export interface DiffAmount {
  key: string
  label: string
  before: number | null
  after: number | null
  /** 两边都有数时的差额（之后 − 之前）；一边没有数时为 null。 */
  delta: number | null
}
export interface SkuDiff {
  sku: string
  kind: 'CHANGED' | 'ADDED' | 'REMOVED'
  asin: string | null
  units: { before: number | null; after: number | null }
  revenue: { before: number | null; after: number | null }
  profit: { before: number | null; after: number | null }
  /** 排序用的变化大小（销售额与利润变化的较大者）。 */
  magnitude: number
}
export interface BasisDiff {
  basis: ProfitBasis
  label: string
  items: DiffAmount[]
  netProfit: DiffAmount
  skus: SkuDiff[]
  skuChanged: number
  skuAdded: number
  skuRemoved: number
  skuTruncated: boolean
}
export interface FxDiffRow {
  quote: string
  date: string
  source: string
  before: number | null
  after: number | null
}
export interface CostDiffRow {
  sku: string
  versionNo: number
  kind: 'CHANGED' | 'ADDED' | 'REMOVED'
  before: { status: string; productCost: number | null; firstMileCost: number | null; otherCost: number | null } | null
  after: { status: string; productCost: number | null; firstMileCost: number | null; otherCost: number | null } | null
}
export interface SnapshotDiff {
  bases: BasisDiff[]
  fx: { rows: FxDiffRow[]; changed: number; added: number; removed: number }
  costVersions: { rows: CostDiffRow[]; changed: number; added: number; removed: number }
  hasChanges: boolean
}
/** 差异报告：LIVE 是“上一份快照 vs 现在的实时数据”（重新开账期间），PREVIOUS_REVISION 是“本次锁定 vs 上一份快照”（再次关账之后）。 */
export interface PeriodDiffReport extends SnapshotDiff {
  against: 'LIVE' | 'PREVIOUS_REVISION'
  baseRevision: number
  baseLockedAt: string
  compareRevision: number | null
}

// ---- 预览 ----

export type PreviewItemState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'RESTRICTED'
export interface PreviewItem {
  key: BridgeKey
  label: string
  direction: BridgeDirection
  value: number | null
  state: PreviewItemState
}
export interface PreviewBasis {
  basis: ProfitBasis
  label: string
  units: number
  costedUnits: number
  rows: number
  incompleteRows: number
  netProfit: number | null
  items: PreviewItem[]
}
export interface PeriodPreview {
  /** RESTRICTED：没有利润字段权限（field.profit），不显示金额。 */
  state: 'OK' | 'NO_DATA' | 'RESTRICTED'
  /** LIVE 是实时的利润日表；SNAPSHOT 是已关账锁定的快照。 */
  source: 'LIVE' | 'SNAPSHOT'
  note: string | null
  bases: PreviewBasis[]
  fx: { currencies: string[]; rates: number } | null
  costVersions: number | null
}

// ---- 响应 ----

export interface PeriodRow {
  id: string
  sellerAccountId: string
  storeName: string
  periodStart: string
  periodEnd: string
  /** 例如 2026-09。 */
  month: string
  status: PeriodStatus
  statusLabel: string
  closedBy: string | null
  closedAt: string | null
  closeCount: number
  /** 最近一次检查是否通过；没检查过为 null。 */
  checkPassed: boolean | null
  version: number
}
export interface PeriodListResponse {
  items: PeriodRow[]
  page: number
  pageSize: number
  total: number
  summary: Record<PeriodStatus, number>
  stores: Array<{ id: string; name: string }>
  canCreate: boolean
}

export interface PeriodActionState {
  allowed: boolean
  reason: string | null
}
export interface PeriodActions {
  check: PeriodActionState
  approve: PeriodActionState
  close: PeriodActionState
  reopen: PeriodActionState
}
export interface PeriodSnapshotSummary {
  revision: number
  lockedAt: string
  lockedBy: string
  bases: Array<{ basis: ProfitBasis; label: string; rows: number; revenue: number; netProfit: number | null }> | null
  fxRates: number
  costVersions: number
  hasDiff: boolean
}
export interface PeriodDetail extends PeriodRow {
  createdBy: string
  checkedBy: string | null
  checkedAt: string | null
  approvalDecision: 'APPROVED' | 'REJECTED' | null
  approvedBy: string | null
  approvedAt: string | null
  approvalComment: string | null
  reopenedBy: string | null
  reopenedAt: string | null
  reopenReason: string | null
  statusNote: string
}
export interface PeriodDetailResponse {
  period: PeriodDetail
  checklist: PeriodChecklist | null
  preview: PeriodPreview
  snapshots: PeriodSnapshotSummary[]
  diff: PeriodDiffReport | null
  actions: PeriodActions
}

export interface PeriodMutationResult {
  id: string
  version: number
  status: PeriodStatus
  statusLabel: string
}
export interface PeriodCheckResult extends PeriodMutationResult {
  passed: boolean
  checklist: PeriodChecklist
}
export interface PeriodCloseResult extends PeriodMutationResult {
  revision: number
  fxLocked: number
}
