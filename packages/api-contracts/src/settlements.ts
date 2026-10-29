import type { InventoryFreshness } from './inventory.js'
import { cursorListQuery, type CursorPageInfo } from './query.js'

// 结算交易（P2b-07，07 章 7.7，importers.md R-28）：把亚马逊结算报告（官方打款依据）、财务接口交易、我方订单三方核对，
// 找出对不上的交易并归类。本文件只放常量、标签、请求校验与响应类型；纯函数在 settlements-math.ts（worker 与 API 共用）。
// 结算报告只用 GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2（另两种格式 2026-11-11 移除）。该报告由亚马逊按结算周期自动生成，
// 不能主动申请，所以同步器按“检索新结算”工作：列出最近生成的报告，没导入过的下载导入。

export const SETTLEMENT_READ = 'finance.read'
export const SETTLEMENT_REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'
export const SETTLEMENT_SYNC_JOB = 'SETTLEMENT_SYNC'
export const SETTLEMENT_FRESHNESS_KEY = 'rpt.settlement'
export const SETTLEMENT_FRESHNESS_KEYS = [SETTLEMENT_FRESHNESS_KEY, 'finance.transactions', 'orders.api'] as const
/** 检索新结算时往回看多少天（亚马逊保留结算报告 90 天）。 */
export const SETTLEMENT_LOOKBACK_DAYS = 90
/** 后台核对只重算最近多少天内有变化的结算单。 */
export const SETTLEMENT_RECHECK_DAYS = 120
/** 一份核对最多保存多少条异常（按金额绝对值从大到小）；超过的只计数，不保存。 */
export const SETTLEMENT_EXCEPTION_LIMIT = 2000
/** 核对容差（结算币种的绝对金额）：差额不超过它算对平。这是我们定的数，不是亚马逊公布的。 */
export const SETTLEMENT_TOLERANCE = 0.05
/** 同一订单的结算明细与财务交易，入账时间最多相差多少毫秒仍算在同一结算周期内（周期边界按整天计）。 */
export const SETTLEMENT_PERIOD_GRACE_MS = 24 * 60 * 60 * 1000
/** 自动标“已对账”的系统账号标识（写在 reconciledBy）。 */
export const SETTLEMENT_RECONCILER = 'system:settlement'

export const SETTLEMENT_CATEGORIES = ['INCOME', 'FEE', 'REFUND', 'REIMBURSEMENT', 'ADJUSTMENT', 'RESERVE'] as const
export type SettlementCategory = (typeof SETTLEMENT_CATEGORIES)[number]
export const SETTLEMENT_CATEGORY_LABEL: Readonly<Record<SettlementCategory, string>> = {
  INCOME: '收入',
  FEE: '费用',
  REFUND: '退款',
  REIMBURSEMENT: '赔付',
  ADJUSTMENT: '调整及其他',
  RESERVE: '保留金',
}

export const SETTLEMENT_STATUSES = ['MATCHED', 'DISCREPANCY', 'PENDING'] as const
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number]
export const SETTLEMENT_STATUS_LABEL: Readonly<Record<SettlementStatus, string>> = { MATCHED: '已对平', DISCREPANCY: '有差异', PENDING: '待核对' }

/** 待核对的原因：没有结算报告（只有财务交易提到了这张结算单）、没有财务交易（报告到了但接口交易还没同步到）。 */
export const SETTLEMENT_PENDING_REASONS = ['NO_REPORT', 'NO_TRANSACTIONS'] as const
export type SettlementPendingReason = (typeof SETTLEMENT_PENDING_REASONS)[number]
export const SETTLEMENT_PENDING_LABEL: Readonly<Record<SettlementPendingReason, string>> = {
  NO_REPORT: '结算报告尚未到达：结算周期结束后亚马逊才会生成结算报告，到达后自动核对',
  NO_TRANSACTIONS: '这张结算单还没有关联的财务接口交易：财务交易每 6 小时同步一次，同步到后自动核对',
}

/** 差异分类（冻结口径：时间口径、归因口径、范围、未解释）。 */
export const EXCEPTION_CATEGORIES = ['TIMING', 'ATTRIBUTION', 'SCOPE', 'UNEXPLAINED'] as const
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number]
export const EXCEPTION_CATEGORY_LABEL: Readonly<Record<ExceptionCategory, string>> = { TIMING: '时间口径', ATTRIBUTION: '归因口径', SCOPE: '范围', UNEXPLAINED: '未解释' }
export const EXCEPTION_CATEGORY_HINT: Readonly<Record<ExceptionCategory, string>> = {
  TIMING: '两边金额的差额，恰好是入账时间落在结算周期之外的交易',
  ATTRIBUTION: '同一订单的其他交易被归到了别的结算单（或还没有归属），合起来就对平了',
  SCOPE: '我方的数据范围没有覆盖这笔：财务接口或订单同步的起始时间晚于结算周期开始',
  UNEXPLAINED: '以上都解释不了，需要人工到卖家后台核对',
}

export const EXCEPTION_KINDS = ['AMOUNT_MISMATCH', 'REPORT_ONLY', 'API_ONLY', 'ORDER_MISSING', 'SELF_CHECK'] as const
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]
export const EXCEPTION_KIND_LABEL: Readonly<Record<ExceptionKind, string>> = {
  AMOUNT_MISMATCH: '金额不一致',
  REPORT_ONLY: '报告有、接口没有',
  API_ONLY: '接口有、报告没有',
  ORDER_MISSING: '订单未同步',
  SELF_CHECK: '报告自检不平',
}
export const EXCEPTION_STATUSES = ['OPEN', 'RESOLVED'] as const
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number]
export const EXCEPTION_STATUS_LABEL: Readonly<Record<ExceptionStatus, string>> = { OPEN: '待处理', RESOLVED: '已消除' }
/** 账户级（没有订单号）的交易在三方核对里合并成一组使用的键。 */
export const ACCOUNT_LEVEL_KEY = '(account)'

// ---- 请求 ----

export const SettlementListQuerySchema = cursorListQuery({
  sortable: ['sortAt'],
  defaultSort: { field: 'sortAt', dir: 'desc' },
  filters: { status: { type: 'enum', values: SETTLEMENT_STATUSES } },
})
export type SettlementListQuery = ReturnType<typeof SettlementListQuerySchema.parse>

export const SettlementLinesQuerySchema = cursorListQuery({
  scope: false,
  sortable: ['lineNo'],
  defaultSort: { field: 'lineNo', dir: 'asc' },
  filters: { category: { type: 'enum', values: SETTLEMENT_CATEGORIES } },
})
export type SettlementLinesQuery = ReturnType<typeof SettlementLinesQuerySchema.parse>

export const SettlementExceptionsQuerySchema = cursorListQuery({
  scope: false,
  sortable: ['absAmount'],
  defaultSort: { field: 'absAmount', dir: 'desc' },
  filters: {
    kind: { type: 'enum', values: EXCEPTION_KINDS },
    category: { type: 'enum', values: EXCEPTION_CATEGORIES },
    status: { type: 'enum', values: EXCEPTION_STATUSES },
  },
})
export type SettlementExceptionsQuery = ReturnType<typeof SettlementExceptionsQuerySchema.parse>

// ---- 响应 ----

/** 各类别合计（结算币种，带符号：收入为正，扣费与退款为负）。 */
export type CategoryTotals = Record<SettlementCategory, number>

export interface SettlementRow {
  id: string
  sellerAccountId: string
  storeName: string
  externalSettlementId: string
  periodStart: string | null
  periodEnd: string | null
  depositDate: string | null
  /** 期初余额（上期保留金余额）；报告没给为 null，不当 0。 */
  openingBalance: number | null
  /** 各类别合计；结算报告还没到为 null。 */
  totals: CategoryTotals | null
  disbursementAmount: number | null
  totalAmount: number | null
  currency: string
  /** 结算报告明细条数；报告没到为 0。 */
  txnCount: number
  status: SettlementStatus
  statusLabel: string
  pendingReason: SettlementPendingReason | null
  diffAmount: number | null
  openExceptions: number
}

export interface SettlementListSummary {
  total: number
  matched: number
  discrepancy: number
  pending: number
}

export interface SettlementListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: SettlementRow[]
  pageInfo: CursorPageInfo
  summary: SettlementListSummary
  freshness: InventoryFreshness
}

export interface SettlementBreakdownRow {
  category: SettlementCategory
  categoryLabel: string
  amountType: string
  amountDescription: string
  count: number
  amount: number
}

export interface SettlementSummaryResponse {
  settlement: SettlementRow
  /** 报告是否已到；没到时汇总与明细都是空，页面写“结算报告尚未到达”。 */
  hasReport: boolean
  note: string | null
  categories: Array<{ category: SettlementCategory; label: string; amount: number }>
  breakdown: SettlementBreakdownRow[]
  /** 汇总明细最多取前 N 行，超过时为 true。 */
  breakdownTruncated: boolean
  freshness: InventoryFreshness
}

export interface SettlementLineRow {
  id: string
  lineNo: number
  postedAt: string | null
  transactionType: string
  amountType: string
  amountDescription: string
  category: SettlementCategory
  categoryLabel: string
  amazonOrderId: string | null
  sku: string | null
  asin: string | null
  quantity: number | null
  amount: number
  currency: string
  /** 我方订单里有这个订单号（页面据此显示订单链接）。 */
  orderFound: boolean
  /** 费用类明细对得上的费用事件编号；对不上为 null。 */
  feeEventId: string | null
}

export interface SettlementLinesResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: SettlementLineRow[]
  pageInfo: CursorPageInfo
  canViewOrders: boolean
}

export interface SettlementCheck {
  key: 'REPORT_SELF' | 'REPORT_VS_API' | 'ORDERS'
  label: string
  state: 'PASS' | 'FAIL' | 'SKIPPED'
  detail: string
}

export interface SettlementReconciliationResponse {
  settlementId: string
  status: SettlementStatus
  statusLabel: string
  pendingReason: SettlementPendingReason | null
  pendingNote: string | null
  currency: string
  computedAt: string | null
  /** 官方金额：结算报告里参与比较的明细合计；系统金额：财务接口交易合计；差额 = 官方 − 系统。 */
  officialAmount: number | null
  systemAmount: number | null
  diffAmount: number | null
  report: { lineCount: number; comparedTotal: number; headerTotal: number | null; selfDiff: number | null; orderCount: number } | null
  api: { transactionCount: number; total: number; orderCount: number; otherCurrencyCount: number } | null
  orders: { reportOrders: number; found: number; missing: number } | null
  checks: SettlementCheck[]
  exceptions: Array<{ category: ExceptionCategory; label: string; count: number; amount: number }>
  openExceptions: number
  /** 保存的异常被截断（超过上限）时为 true。 */
  exceptionsTruncated: boolean
  tolerance: number
  freshness: InventoryFreshness
}

export interface SettlementExceptionRow {
  id: string
  kind: ExceptionKind
  kindLabel: string
  category: ExceptionCategory
  categoryLabel: string
  categoryHint: string
  refKey: string
  amazonOrderId: string | null
  reportAmount: number
  apiAmount: number
  /** 差额 = 报告金额 − 接口金额。 */
  amount: number
  currency: string
  note: string | null
  status: ExceptionStatus
  statusLabel: string
  orderFound: boolean
}

export interface SettlementExceptionsResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: SettlementExceptionRow[]
  pageInfo: CursorPageInfo
  canViewOrders: boolean
}

export interface SettlementDisbursementRow {
  /** REPORT：结算报告里的打款（预期）；MANUAL：财务在回款页手工登记的到账（P2b-08）。 */
  source: 'REPORT' | 'MANUAL'
  sourceLabel: string
  date: string | null
  amount: number | null
  currency: string
  note: string
}

export interface SettlementDisbursementsResponse {
  items: SettlementDisbursementRow[]
  /** 到账手工登记在回款页（P2b-08）；available 表示这张结算单能登记（报告里有打款金额）。 */
  manual: { available: boolean; note: string }
}
