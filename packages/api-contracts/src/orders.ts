import { z } from 'zod'
import { BATCH_MAX_CHARS, batchTermsIssue } from './batch-terms.js'
import type { CursorPageInfo } from './query.js'
import { cursorListQuery } from './query.js'
import type { InventoryFreshness } from './inventory.js'

// 订单（P2b-01，07 章 7.1）：只看亚马逊物流订单。列表游标分页，详情 9 个页签。
// 买家个人信息默认不出现在任何响应里，只有 POST /pii/reveal（P6-14，全站唯一出口，见 pii.ts）在填写理由并写审计之后解密返回一次。
// 本文件只放常量、请求校验与响应类型；纯计算（结算状态、退款、风险、净收益）在 orders-math.ts。

export const ORDERS_PERMISSION = 'orders.read'
export const ORDERS_RETURNS_PERMISSION = 'returns.read'
export const ORDERS_FINANCE_PERMISSION = 'finance.read'
/** 字段权限：买家信息页签与解密接口（freeze/permissions.md）。 */
export const ORDERS_BUYER_FIELD = 'field.buyer'
export const ORDERS_PROFIT_FIELD = 'field.profit'
/** 查看买家信息的审计动作名。 */
export const BUYER_PII_VIEW_ACTION = 'ORDER_BUYER_PII_VIEWED'
/** 列表默认只看最近多少天，避免没有时间范围时扫全表。 */
export const ORDER_DEFAULT_DAYS = 30
// ---- 状态 ----

/** 订单状态沿用旧版风格写法（Order.status）；官方将来新增的状态原样保留，显示时回退到原值。 */
export const ORDER_STATUS_LABEL: Readonly<Record<string, string>> = {
  Pending: '待付款确认',
  Unshipped: '待发货',
  PartiallyShipped: '部分发货',
  Shipped: '已发货',
  Canceled: '已取消',
  Unfulfillable: '无法履约',
  InvoiceUnconfirmed: '发票待确认',
  PendingAvailability: '待上架可售',
}
export const ORDER_STATUS_OPTIONS = Object.keys(ORDER_STATUS_LABEL)
export const orderStatusLabel = (status: string) => ORDER_STATUS_LABEL[status] ?? status

/** 新版履约状态原值（Order.fulfillmentStatus）。 */
export const ORDER_FULFILLMENT_LABEL: Readonly<Record<string, string>> = {
  UNSHIPPED: '未发货',
  PARTIALLY_SHIPPED: '部分发货',
  SHIPPED: '已发货',
  CANCELLED: '已取消',
  PENDING: '待处理',
  UNFULFILLABLE: '无法履约',
  PENDING_AVAILABILITY: '待上架可售',
  INVOICE_UNCONFIRMED: '发票待确认',
}
export const orderFulfillmentLabel = (status: string | null | undefined) => (status ? (ORDER_FULFILLMENT_LABEL[status] ?? status) : null)

/** 订单的结算状态：看这个订单的财务交易（递延 = 亚马逊暂扣、待释放；已释放 = 可结算）。 */
export const ORDER_SETTLEMENT_STATES = ['NONE', 'DEFERRED', 'RELEASED', 'UNKNOWN'] as const
export type OrderSettlementState = (typeof ORDER_SETTLEMENT_STATES)[number]
export const ORDER_SETTLEMENT_LABEL: Readonly<Record<OrderSettlementState, string>> = { NONE: '尚无财务交易', DEFERRED: '递延', RELEASED: '已释放', UNKNOWN: '状态未知' }
/** 单笔财务交易的三种官方状态。 */
export const TRANSACTION_STATUS_LABEL: Readonly<Record<string, string>> = { DEFERRED: '递延', RELEASED: '已释放', DEFERRED_RELEASED: '递延后释放' }
export const transactionStatusLabel = (status: string | null | undefined) => (status ? (TRANSACTION_STATUS_LABEL[status] ?? status) : '状态未知')

export const ORDER_REFUND_STATES = ['NONE', 'PARTIAL', 'FULL', 'PENDING_DATA'] as const
export type OrderRefundState = (typeof ORDER_REFUND_STATES)[number]
export const ORDER_REFUND_LABEL: Readonly<Record<OrderRefundState, string>> = { NONE: '无退款', PARTIAL: '部分退款', FULL: '全额退款', PENDING_DATA: '待财务交易' }

// ---- 风险标记 ----

export const ORDER_RISK_KINDS = ['CANCEL_REQUEST', 'REFUND', 'RETURN', 'REPLACEMENT', 'TAX_ANOMALY', 'FINANCE_DIFF'] as const
export type OrderRiskKind = (typeof ORDER_RISK_KINDS)[number]
export const ORDER_RISK_LABEL: Readonly<Record<OrderRiskKind, string>> = {
  CANCEL_REQUEST: '取消请求',
  REFUND: '退款',
  RETURN: '退货',
  REPLACEMENT: '替换',
  TAX_ANOMALY: '税务异常',
  FINANCE_DIFF: '财务差异',
}
/** 列表可按它筛选的风险（后两种要逐单比对金额，只在每行与详情里显示，不能整表筛选）。 */
export const ORDER_RISK_FILTERS = ['CANCEL_REQUEST', 'REFUND', 'RETURN', 'REPLACEMENT'] as const
export type OrderRiskLevel = 'HIGH' | 'MEDIUM'
export interface OrderRisk {
  kind: OrderRiskKind
  label: string
  level: OrderRiskLevel
  /** 每条风险都带原因（07 章 7.1 第 9 页签）。 */
  reason: string
}

// ---- 请求 ----

/** 列表查询：范围参数（主体、店铺、日期范围）加本页筛选；游标分页，只按下单时间排序。 */
export const OrderListQuerySchema = cursorListQuery({
  sortable: ['purchaseDate'],
  defaultSort: { field: 'purchaseDate', dir: 'desc' },
  filters: {
    // 批量搜索（P6-04）：订单号或追踪号精确匹配，最多 500 个，逗号连接；与 q（前缀匹配）同时给出时两者都要满足
    qs: { type: 'text', max: BATCH_MAX_CHARS },
    status: { type: 'text', max: 40 },
    asin: { type: 'text', max: 20 },
    sku: { type: 'text', max: 80 },
    refunded: { type: 'bool' },
    returned: { type: 'bool' },
    replacement: { type: 'bool' },
    promotion: { type: 'bool' },
    settlement: { type: 'enum', values: ['NONE', 'DEFERRED', 'RELEASED'] },
    risk: { type: 'enum', values: ORDER_RISK_FILTERS },
  },
}).refine(value => batchTermsIssue(value.qs) === null, { message: '批量搜索最多 500 个词，每个词不超过 80 个字符', path: ['qs'] })
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>

// ---- 响应 ----

export type OrderListState = 'OK' | 'NO_DATA'

export interface OrderListRow {
  id: string
  amazonOrderId: string
  purchaseDate: string
  sellerAccountId: string
  storeName: string
  amount: number | null
  currency: string
  /** 件数：订单行下单数量之和；没有订单行记录为 null。 */
  units: number | null
  status: string
  statusLabel: string
  fulfillmentStatus: string | null
  fulfillmentLabel: string | null
  earliestDelivery: string | null
  latestDelivery: string | null
  carrier: string | null
  trackingNumber: string | null
  trackingCount: number
  refund: { state: OrderRefundState; amount: number | null }
  returnCount: number
  isReplacement: boolean
  settlement: { state: OrderSettlementState; label: string }
  risks: OrderRiskKind[]
}

/** 订单列表“净收益”异步列（POST /orders/net-income）：一次最多 100 个订单编号（行 id）。 */
export const ORDER_NET_INCOME_MAX_IDS = 100
export const OrderNetIncomeBodySchema = z.object({
  ids: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
    .min(1)
    .max(ORDER_NET_INCOME_MAX_IDS),
})

/** rows 以订单行 id 为键；不在范围内（别的企业或没有店铺权限）的订单不出现。value 为空表示财务交易还没同步，不能算。 */
export interface OrderNetIncomeResponse {
  rows: Record<string, { net: { value: number | null; currency: string } }>
}

export interface OrderListResponse {
  state: OrderListState
  note: string | null
  items: OrderListRow[]
  pageInfo: CursorPageInfo
  /** 实际使用的下单日期范围（企业数据口径时区）。 */
  range: { from: string; to: string; defaulted: boolean }
  /** 退款、退货、结算筛选靠“先找出符合条件的订单号”实现，找出的订单号有上限；为真表示结果可能不完整。 */
  filterLimited: boolean
  freshness: InventoryFreshness
}

export type BuyerInfoState = 'AVAILABLE' | 'EXPIRED' | 'NOT_SYNCED'

export interface OrderIdentityResponse {
  order: {
    id: string
    amazonOrderId: string
    sellerAccountId: string
    storeName: string
    marketplaceId: string
    salesChannel: string | null
    programs: string[]
    purchaseDate: string
    status: string
    statusLabel: string
    fulfillmentStatus: string | null
    fulfillmentLabel: string | null
    fulfillmentNetwork: 'AFN' | 'MFN' | null
    amount: number | null
    currency: string
    units: number | null
    lineCount: number
    isReplacement: boolean
    replacedOrderId: string | null
    replacementReason: string | null
  }
  settlement: { state: OrderSettlementState; label: string }
  refund: { state: OrderRefundState; amount: number | null }
  returnCount: number
  risks: OrderRiskKind[]
  netIncome?: { state: 'OK' | 'PENDING'; value: number | null; currency: string; note: string }
  overview: {
    /** 配送承诺（订单接口给的最晚发货与最早、最晚送达）。 */
    promise: { latestShipDate: string | null; earliestDelivery: string | null; latestDelivery: string | null }
    /** 承诺计算依据：该订单包裹上记录的承运商与服务；没有包裹时为空并说明。 */
    basis: { carriers: string[]; services: string[]; note: string }
    keyTimes: Array<{ key: string; label: string; at: string | null }>
  }
  buyerInfo: { access: 'ALLOWED' | 'RESTRICTED'; state: BuyerInfoState; expiresAt: string | null }
  freshness: InventoryFreshness
}

export interface OrderItemRow {
  orderItemId: string
  asin: string | null
  sku: string | null
  title: string | null
  condition: string | null
  quantityOrdered: number
  quantityShipped: number
  /** 订单行小计（接口给的商品行金额，不是单价）。 */
  itemPrice: number | null
  unitPrice: number | null
  promotionDiscount: number | null
  taxAmount: number | null
  currency: string
  itemStatus: string | null
  /** 已有商品档案时可跳转 ASIN 360。 */
  productId: string | null
}

export interface OrderItemsResponse {
  items: OrderItemRow[]
  cancellation: { cancelledBy: string; cancelledByLabel: string; reasonCode: string; requestedAt: string | null; cancelledAt: string | null } | null
  /** 关联商品（例如保修）：同步器尚未读取该字段。 */
  associatedItems: { state: 'NOT_CONNECTED'; note: string }
}

export type FinanceLineGroup = 'REVENUE' | 'TAX' | 'FEE'

export interface OrderChargeLine {
  orderItemId: string
  sku: string | null
  kind: string
  kindLabel: string
  componentKey: string
  amount: number
  currency: string
}

export interface OrderFeeLine {
  path: string
  label: string
  group: FinanceLineGroup
  amount: number
  currency: string
  postedAt: string
}

/** NO_TRANSACTIONS：财务交易还没同步；NO_LINES：有交易但没有逐项明细可比。 */
export type OrderMatchState = 'MATCHED' | 'DIFF' | 'NO_TRANSACTIONS' | 'NO_LINES'

export interface OrderChargesResponse {
  currency: string
  lines: OrderChargeLine[]
  revenue: { item: number; shipping: number; promotion: number; tax: number; other: number; totalExTax: number; total: number } | null
  fees: OrderFeeLine[]
  feeTotal: number | null
  netIncome?: { state: 'OK' | 'PENDING'; value: number | null; note: string }
  /** 与财务交易的匹配：订单接口的收入、税与财务交易里同类明细逐项比对。 */
  match: { state: OrderMatchState; note: string; revenue: { order: number; finance: number; diff: number } | null; tax: { order: number; finance: number; diff: number } | null }
}

export interface OrderPackageRow {
  packageId: string
  carrier: string | null
  trackingNumber: string | null
  shippingService: string | null
  packageStatus: string | null
  shipDate: string | null
  deliveredAt: string | null
  fulfillmentCenter: string | null
}

export interface OrderPackagesResponse {
  packages: OrderPackageRow[]
  /** 逐段物流节点要追踪接口，尚未接入；这里只有包裹状态与发货、送达时间。 */
  tracking: { state: 'NOT_CONNECTED'; note: string }
}

export interface OrderReturnRow {
  id: string
  returnId: string | null
  asin: string
  sku: string
  quantity: number
  disposition: string | null
  reason: string | null
  status: string
  refundAmount: number | null
  returnDate: string
}

export interface OrderReturnsResponse {
  refunds: Array<{ postedAt: string; amount: number; currency: string; status: string | null }>
  refundTotal: number | null
  refund: { state: OrderRefundState; amount: number | null }
  returns: OrderReturnRow[]
  replacement: {
    isReplacement: boolean
    reason: string | null
    original: { id: string | null; amazonOrderId: string } | null
    replacedBy: Array<{ id: string; amazonOrderId: string; reason: string | null }>
  }
}

export interface OrderTransactionRow {
  id: string
  externalTransactionId: string
  transactionType: string | null
  status: string | null
  statusLabel: string
  amount: number
  currency: string
  postedAt: string
  description: string | null
  reconciliationStatus: string
  settlement: { id: string; externalSettlementId: string; depositDate: string | null; status: string } | null
}

export interface OrderTransactionsResponse {
  items: OrderTransactionRow[]
  settlement: { state: OrderSettlementState; label: string }
  total: number | null
  truncated: boolean
}

export interface OrderTimelineItem {
  at: string
  kind: 'PURCHASE' | 'STATUS' | 'CANCELLATION' | 'PACKAGE'
  title: string
  source: string
}

export interface OrderTimelineResponse {
  items: OrderTimelineItem[]
  /** 推送事件（ORDER_CHANGE）的接收端按 14.10 暂缓：目前只有接口同步留下的状态变化。 */
  push: { state: 'NOT_CONNECTED'; note: string }
}

export interface OrderRisksResponse {
  items: OrderRisk[]
}
