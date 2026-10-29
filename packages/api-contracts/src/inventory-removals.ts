import { z } from 'zod'
import { pageListQuery } from './query.js'
import type { DashState } from './dashboard.js'
import type { InventoryFreshness } from './inventory.js'

// 移除与弃置契约（P2a-09，06 章 6.5；freeze/api.md `/inventory/removals*`）。
// 移除订单只能在亚马逊卖家后台创建，系统负责跟踪（R-18、R-19）、展示推荐移除清单（R-17）和登记退回件的收货核对（RemovalReceipt）。

export const REMOVAL_TYPES = ['RETURN', 'DISPOSAL', 'OTHER'] as const
export type RemovalType = (typeof REMOVAL_TYPES)[number]
export const REMOVAL_TYPE_LABEL: Record<RemovalType, string> = { RETURN: '退回', DISPOSAL: '弃置', OTHER: '其他' }

/** 亚马逊移除订单状态的中文名；没登记的状态原样显示，不猜。 */
const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  cancelled: '已取消',
  canceled: '已取消',
  pending: '待处理',
  processing: '处理中',
  planning: '计划中',
  shipped: '已发货',
  failed: '失败',
  open: '进行中',
}
export const removalStatusLabel = (status: string): string => (status ? (STATUS_LABEL[status.trim().toLowerCase()] ?? status) : '尚无记录')

export const REMOVAL_SORT_FIELDS = ['requestDate'] as const
export const RemovalListQuerySchema = pageListQuery({
  sortable: REMOVAL_SORT_FIELDS,
  defaultSort: { field: 'requestDate', dir: 'desc' },
  filters: { type: { type: 'enum', values: REMOVAL_TYPES }, status: { type: 'text', max: 60 } },
})
export type RemovalListQuery = z.infer<typeof RemovalListQuerySchema>

export const RecommendedRemovalQuerySchema = pageListQuery({ sortable: ['removalQty'] as const, defaultSort: { field: 'removalQty', dir: 'desc' } })

/** 退回件收货核对：状态由应收（订单已发货数量）与实收（登记累计）算出。 */
export const REMOVAL_RECEIPT_STATES = ['NOT_APPLICABLE', 'PENDING', 'MATCHED', 'SHORT', 'OVER'] as const
export type RemovalReceiptState = (typeof REMOVAL_RECEIPT_STATES)[number]
export const REMOVAL_RECEIPT_STATE_LABEL: Record<RemovalReceiptState, string> = {
  NOT_APPLICABLE: '无需核对',
  PENDING: '待收货登记',
  MATCHED: '一致',
  SHORT: '少收',
  OVER: '多收',
}

/** 应收 = 订单已发货数量；没有发货或不是退回订单无需核对；没有任何登记为“待收货登记”。 */
export function removalReceiptState(type: string, expectedQty: number, receivedQty: number | null): RemovalReceiptState {
  if (type !== 'RETURN' || expectedQty <= 0) return 'NOT_APPLICABLE'
  if (receivedQty === null) return 'PENDING'
  if (receivedQty === expectedQty) return 'MATCHED'
  return receivedQty < expectedQty ? 'SHORT' : 'OVER'
}

export interface RemovalGuide {
  title: string
  steps: string[]
  url: string
}

export interface RemovalOrderRow {
  /** `<店铺编号>:<移除订单号>`，详情页路径用。 */
  id: string
  sellerAccountId: string
  storeName: string
  orderId: string
  type: RemovalType
  typeLabel: string
  status: string
  statusLabel: string
  requestDate: string
  lastUpdatedDate: string | null
  skuCount: number
  requestedQty: number
  shippedQty: number
  disposedQty: number
  cancelledQty: number
  inProcessQty: number
  /** 订单费用合计；所有行都没有费用时为 null（不是 0）。 */
  fee: number | null
  currency: string | null
  carriers: string[]
  trackingNumbers: string[]
  receiptState: RemovalReceiptState
  receivedQty: number | null
}

export interface RemovalListResponse {
  state: DashState
  note: string | null
  items: RemovalOrderRow[]
  page: number
  pageSize: number
  total: number
  guide: RemovalGuide
  freshness: InventoryFreshness
}

export interface RecommendedRemovalRow {
  id: string
  sellerAccountId: string
  storeName: string
  sku: string
  fnsku: string
  asin: string
  productName: string | null
  removalQty: number
  reason: string | null
  available: number | null
  estimatedSavings: number | null
  snapshotDate: string
  reportUpdatedAt: string | null
}

export interface RecommendedRemovalResponse {
  state: DashState
  note: string | null
  items: RecommendedRemovalRow[]
  page: number
  pageSize: number
  total: number
  guide: RemovalGuide
  freshness: InventoryFreshness
}

export interface RemovalLine {
  sku: string
  fnsku: string
  disposition: string
  requestedQty: number
  shippedQty: number
  disposedQty: number
  cancelledQty: number
  inProcessQty: number
  fee: number | null
  currency: string | null
}

export interface RemovalShipmentRow {
  shipmentId: string
  sku: string
  fnsku: string
  disposition: string
  carrier: string | null
  trackingNumber: string | null
  shippedQty: number
  shipDate: string | null
}

export interface RemovalReconRow {
  sku: string
  /** 应收：订单上这个 SKU 的已发货数量。 */
  expectedQty: number
  /** 实收、良品、损坏：没有任何登记时为 null（尚无记录），不是 0。 */
  receivedQty: number | null
  sellableQty: number | null
  damagedQty: number | null
  /** 实收 − 应收；没有登记时为 null。 */
  difference: number | null
  state: RemovalReceiptState
}

export interface RemovalReceiptRow {
  id: string
  sku: string
  receivedQty: number
  sellableQty: number
  damagedQty: number
  note: string | null
  receivedAt: string
  receivedBy: string
}

export interface RemovalTimelineItem {
  at: string
  title: string
  detail: string | null
}

export interface RemovalDetailResponse {
  order: Omit<RemovalOrderRow, 'carriers' | 'trackingNumbers'> & { serviceSpeed: string | null }
  lines: RemovalLine[]
  shipments: RemovalShipmentRow[]
  timeline: RemovalTimelineItem[]
  /** 亚马逊的移除订单报告不含退回地址：如实写明，不显示空地址。 */
  returnAddress: { state: 'NOT_CONNECTED'; note: string }
  reconciliation: RemovalReconRow[]
  receipts: RemovalReceiptRow[]
  /** 能不能登记收货：只有“退回”类订单且已有发货数量才能登记。 */
  canReceive: { allowed: boolean; reason: string | null }
  guide: RemovalGuide
  freshness: InventoryFreshness
}

const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const qtyField = (label: string) =>
  z
    .number({ error: issue => (issue.input === undefined ? undefined : `${label}必须是数字`) })
    .int(`${label}必须是整数`)
    .min(0, `${label}不能小于 0`)
    .max(1_000_000, `${label}过大`)

/** 登记收货：同一天同一 SKU 再次登记视为更正当天的登记。 */
export const RemovalReceiptBodySchema = z
  .object({
    sku: z.string().trim().min(1, '请选择 SKU').max(200),
    receivedQty: qtyField('实收数量'),
    sellableQty: qtyField('良品数量'),
    damagedQty: qtyField('损坏数量'),
    receivedAt: dateText.optional(),
    note: z.string().trim().max(500, '备注最多 500 字').optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sellableQty + value.damagedQty > value.receivedQty) ctx.addIssue({ code: 'custom', path: ['receivedQty'], message: '良品与损坏之和不能超过实收数量' })
  })
export type RemovalReceiptBody = z.infer<typeof RemovalReceiptBodySchema>

export interface RemovalReceiptResponse {
  receipt: RemovalReceiptRow
  reconciliation: RemovalReconRow
}
