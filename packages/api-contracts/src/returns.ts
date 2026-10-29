import type { z } from 'zod'
import type { InventoryFreshness } from './inventory.js'
import type { OrderRefundState } from './orders.js'
import type { CommentView } from './pii.js'
import type { CursorPageInfo } from './query.js'
import { cursorListQuery } from './query.js'
import { RETURN_REASON_LABEL } from './returns-reason-base.js'

// 退货（P2b-02，07 章 7.2）：退货列表（游标分页）、详情、退款后未收到退货的待核实清单、按 ASIN 与原因的退货率分析。
// 数据来源是客户退货报告 R-26（rpt.customer-returns）与财务交易；退款金额一律来自财务交易（订单口径），报告本身没有退款金额。
// 本文件只放常量、请求校验与响应类型；纯计算（处置分组、收货状态、赔付状态、退货率、分桶）在 returns-math.ts。

export const RETURNS_PERMISSION = 'returns.read'
export const RETURNS_REPORT_TYPE = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'
export const RETURNS_FRESHNESS_KEY = 'rpt.customer-returns'
/** 列表与分析不带日期范围时默认看最近多少天（按退货日期）。 */
export const RETURN_DEFAULT_DAYS = 90
/** 退款多少天后仍没有收到退货，才列入“退款后未收到退货”清单（亚马逊当期政策默认值，设置页在 P2b-03 提供配置）。 */
export const RETURN_AWAITING_DAYS = 30
/** 待核实清单回看的退款入账天数（不带日期范围时）。 */
export const RETURN_AWAITING_LOOKBACK_DAYS = 180
/** 待核实清单最多显示多少行。 */
export const RETURN_AWAITING_MAX_ROWS = 200
/** 买家备注最长保留多少字符（报告里的自由文本，导入时截断）。 */
export const RETURN_COMMENT_MAX_CHARS = 1000

// ---- 处置状态 ----

/**
 * 处置分组（我方归并）：报告的 detailed-disposition 原值保留在 detailedDisposition，页面显示分组名并附原值。
 * UNKNOWN = 报告没给处置；OTHER = 官方将来新增、我方还没登记的值（原值原样显示，不猜）。
 */
export const RETURN_DISPOSITION_GROUPS = ['SELLABLE', 'DAMAGED', 'CARRIER_DAMAGED', 'WAREHOUSE_DAMAGED', 'DEFECTIVE', 'EXPIRED', 'OTHER', 'UNKNOWN'] as const
export type ReturnDispositionGroup = (typeof RETURN_DISPOSITION_GROUPS)[number]
export const RETURN_DISPOSITION_LABEL: Readonly<Record<ReturnDispositionGroup, string>> = {
  SELLABLE: '可售',
  DAMAGED: '损坏',
  CARRIER_DAMAGED: '承运人损坏',
  WAREHOUSE_DAMAGED: '仓库损坏',
  DEFECTIVE: '有缺陷',
  EXPIRED: '已过期',
  OTHER: '其他处置',
  UNKNOWN: '处置未知',
}
/** 报告里 detailed-disposition 的已知取值 → 分组（官方文档列出的 8 个值）。 */
export const RETURN_DISPOSITION_CODES: Readonly<Record<string, ReturnDispositionGroup>> = {
  SELLABLE: 'SELLABLE',
  DAMAGED: 'DAMAGED',
  CUSTOMER_DAMAGED: 'DAMAGED',
  DISTRIBUTOR_DAMAGED: 'DAMAGED',
  CARRIER_DAMAGED: 'CARRIER_DAMAGED',
  WAREHOUSE_DAMAGED: 'WAREHOUSE_DAMAGED',
  DEFECTIVE: 'DEFECTIVE',
  EXPIRED: 'EXPIRED',
}
/** 列表可按它筛选的分组（OTHER 与 UNKNOWN 没有固定取值，不能筛选）。 */
export const RETURN_DISPOSITION_FILTERS = ['SELLABLE', 'DAMAGED', 'CARRIER_DAMAGED', 'WAREHOUSE_DAMAGED', 'DEFECTIVE', 'EXPIRED'] as const

/** 退货原因常见代码（报告 reason 列）与中文释义放在 returns-reason-base.ts（零 zod）；企业可以在映射表里改，见 returns-reason.ts。 */
export { RETURN_REASON_LABEL }
export const returnReasonLabel = (reason: string | null | undefined) => (reason ? (RETURN_REASON_LABEL[reason.toUpperCase()] ?? reason) : null)

// ---- 退款后是否收到退货 ----

/**
 * 每一行退货记录都是亚马逊仓库已经处理过的退货件（客户退货报告只列已入仓的件），所以“是否收到”要和退款时间对照：
 * PENDING_DATA 还没有财务交易，说不清；NO_REFUND 没有退款；RECEIVED_AFTER_REFUND 退款在先、之后收到退货；REFUNDED_AFTER_RECEIPT 先收到退货、之后才退款。
 */
export const RETURN_RECEIPT_STATES = ['PENDING_DATA', 'NO_REFUND', 'RECEIVED_AFTER_REFUND', 'REFUNDED_AFTER_RECEIPT'] as const
export type ReturnReceiptState = (typeof RETURN_RECEIPT_STATES)[number]
export const RETURN_RECEIPT_LABEL: Readonly<Record<ReturnReceiptState, string>> = {
  PENDING_DATA: '待财务交易',
  NO_REFUND: '无退款',
  RECEIVED_AFTER_REFUND: '退款后已收到退货',
  REFUNDED_AFTER_RECEIPT: '收到退货后退款',
}

// ---- 赔付状态 ----

export const RETURN_REIMBURSEMENT_STATES = ['NOT_REVIEWED', 'AMAZON_REIMBURSED', 'CASE_LINKED', 'OTHER'] as const
export type ReturnReimbursementState = (typeof RETURN_REIMBURSEMENT_STATES)[number]
export const RETURN_REIMBURSEMENT_LABEL: Readonly<Record<ReturnReimbursementState, string>> = {
  NOT_REVIEWED: '尚未核查',
  AMAZON_REIMBURSED: '亚马逊已赔付',
  CASE_LINKED: '已建赔付案件',
  OTHER: '处理中',
}

// ---- 请求 ----

/** 列表查询：范围参数加本页筛选；游标分页，只按退货日期排序。 */
export const ReturnListQuerySchema = cursorListQuery({
  sortable: ['returnDate'],
  defaultSort: { field: 'returnDate', dir: 'desc' },
  filters: {
    asin: { type: 'text', max: 20 },
    sku: { type: 'text', max: 80 },
    reason: { type: 'text', max: 80 },
    disposition: { type: 'enum', values: RETURN_DISPOSITION_FILTERS },
    refunded: { type: 'bool' },
  },
})
export type ReturnListQuery = z.infer<typeof ReturnListQuerySchema>

// ---- 响应 ----

export interface ReturnDispositionView {
  group: ReturnDispositionGroup
  label: string
  /** 可售为 true，其余明确的处置为 false；报告没给处置为 null。 */
  sellable: boolean | null
  /** 报告原值（没有则为空）。 */
  raw: string | null
}

export interface ReturnRefundView {
  state: OrderRefundState
  /** 订单口径：同一订单有多个商品时，退款金额是整个订单的。 */
  amount: number | null
  /** 订单第一笔退款入账时间。 */
  firstRefundAt: string | null
}

export interface ReturnReimbursementView {
  state: ReturnReimbursementState
  label: string
  /** 关联的赔付案件编号（P2b-03 赔付中心回填；之前为空）。 */
  caseId: string | null
}

export interface ReturnListRow {
  id: string
  amazonOrderId: string
  /** 订单已同步时的系统订单编号（用于跳转订单详情）。 */
  orderId: string | null
  returnDate: string
  sellerAccountId: string
  storeName: string
  asin: string
  sku: string
  quantity: number
  reason: string | null
  reasonLabel: string | null
  /** P6-13：原因大类（三层显示：代码、中文释义、大类）；没有原因为空，映射表里没有登记的代码是“未分类”。 */
  reasonCategory: string | null
  disposition: ReturnDispositionView
  fulfillmentCenterId: string | null
  /** 退货件编号（License Plate Number）。 */
  licensePlateNumber: string | null
  refund: ReturnRefundView
  receipt: { state: ReturnReceiptState; label: string }
  currency: string
  reimbursement: ReturnReimbursementView
}

export type ReturnListState = 'OK' | 'NO_DATA'

export interface ReturnListResponse {
  state: ReturnListState
  note: string | null
  items: ReturnListRow[]
  pageInfo: CursorPageInfo
  range: { from: string; to: string; defaulted: boolean }
  /** 退款筛选靠先找出订单号再套用，订单号有上限；为真表示结果可能不完整。 */
  filterLimited: boolean
  freshness: InventoryFreshness
}

export interface ReturnFeeLine {
  label: string
  amount: number
  currency: string
  postedAt: string
}

export interface ReturnTimelineItem {
  at: string
  kind: 'ORDER' | 'REFUND' | 'RETURN_RECEIVED' | 'IMPORTED'
  title: string
  source: string
}

export interface ReturnDetailResponse {
  record: {
    id: string
    returnDate: string
    quantity: number
    sellerAccountId: string
    storeName: string
    asin: string
    sku: string
    fnsku: string | null
    licensePlateNumber: string | null
    fulfillmentCenterId: string | null
    /** 报告里的处理状态原文（例如 Unit returned to inventory）。 */
    reportStatus: string | null
    importedAt: string
  }
  order: { id: string | null; amazonOrderId: string; purchaseDate: string | null; amount: number | null; currency: string; statusLabel: string | null; isReplacement: boolean }
  product: { productId: string | null; title: string | null; imageUrl: string | null }
  reason: { code: string | null; label: string | null; category: string | null }
  /** 买家备注（P6-14）：加密保存，详情只说“有没有、含哪几类个人信息、保留到何时”，不返回内容；要看明文走 POST /pii/reveal（RETURN、customerComments）。 */
  buyerComments: CommentView
  disposition: ReturnDispositionView
  refund: ReturnRefundView & {
    currency: string
    items: Array<{ postedAt: string; amount: number; currency: string; status: string | null }>
    /** 退款交易下的费用类明细与名称带 return 的费用（例如退货处理费、退款佣金）。 */
    fees: ReturnFeeLine[]
    feeTotal: number | null
  }
  receipt: { state: ReturnReceiptState; label: string }
  reimbursement: ReturnReimbursementView
  /** 同一订单的其他退货记录。 */
  siblings: Array<{ id: string; asin: string; sku: string; quantity: number; returnDate: string; disposition: ReturnDispositionView }>
  timeline: ReturnTimelineItem[]
  freshness: InventoryFreshness
}

export interface ReturnAwaitingRow {
  amazonOrderId: string
  orderId: string | null
  storeName: string
  sellerAccountId: string
  firstRefundAt: string
  refundAmount: number | null
  currency: string
  daysSinceRefund: number
  items: Array<{ asin: string | null; sku: string | null; quantity: number }>
}

export interface ReturnAwaitingResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  thresholdDays: number
  items: ReturnAwaitingRow[]
  /** 退款交易或结果行触到上限，清单可能不完整。 */
  truncated: boolean
  range: { from: string; to: string; defaulted: boolean }
  /** 口径说明：退款不等于要退货（部分退款客户可保留商品），这是待核实清单，不是赔付结论。 */
  basis: string
  freshness: InventoryFreshness
}

export type ReturnBucket = 'WEEK' | 'MONTH'

export interface ReturnTrendPoint {
  /** 分桶起始日（周为周一，月为 1 日），YYYY-MM-DD。 */
  bucket: string
  returnedUnits: number
  /** 同一时间桶的销售件数（经营日汇总）；没有汇总为 null。 */
  soldUnits: number | null
  /** 退货率 = 退货件数 ÷ 销售件数；销售件数为空或 0 时为 null（不是 0）。 */
  rate: number | null
}

export interface ReturnAsinRow {
  asin: string
  returnedUnits: number
  soldUnits: number | null
  rate: number | null
  topReason: { code: string; label: string; units: number } | null
  productId: string | null
  title: string | null
}

export interface ReturnReasonRow {
  reason: string
  label: string
  units: number
  /** 占全部退货件数的比例（0 到 1）。 */
  share: number
}

export interface ReturnAnalysisResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  range: { from: string; to: string; defaulted: boolean }
  bucket: ReturnBucket
  totals: { returnedUnits: number; soldUnits: number | null; rate: number | null }
  trend: ReturnTrendPoint[]
  asinTrends: Array<{ asin: string; points: ReturnTrendPoint[] }>
  byAsin: ReturnAsinRow[]
  byReason: ReturnReasonRow[]
  /** 趋势用的退货行触到读取上限（20000 行）时为真，趋势可能不完整；排行是精确的。 */
  truncated: boolean
  /** 与评论主题交叉分析（05 章 5.7）等评价与反馈上线后接入。 */
  reviewCross: { state: 'NOT_CONNECTED'; note: string }
  basis: string
  freshness: InventoryFreshness
}
