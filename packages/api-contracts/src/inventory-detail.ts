import { z } from 'zod'
import { CursorParamsSchema } from './query.js'
import type { CursorPageInfo } from './query.js'
import type { DashState } from './dashboard.js'
import type { InventoryAction, InventoryFreshness, InventoryPolicy, InventoryRow } from './inventory.js'
import type { ReplenishCalc } from './replenishment.js'

// 库存详情契约（P2a-06，06 章 6.1“库存详情”10 个页签）。
// 第 10 个页签“变更与审计”复用对象事件时间线（GET /events）与评论，没有单独接口。

export const INVENTORY_DETAIL_TABS = ['structure', 'snapshots', 'ledger', 'inbound', 'awd', 'replenishment', 'age-fees', 'disposition', 'forecast', 'audit'] as const
export type InventoryDetailTab = (typeof INVENTORY_DETAIL_TABS)[number]
export const INVENTORY_DETAIL_TAB_LABEL: Record<InventoryDetailTab, string> = {
  structure: '库存结构趋势',
  snapshots: '历史快照',
  ledger: '库存台账',
  inbound: '入仓与在途',
  awd: '上游仓储',
  replenishment: '补货建议',
  'age-fees': '库龄与费用',
  disposition: '处置建议',
  forecast: '预测',
  audit: '变更与审计',
}

const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')

/** 两个日期都不传时只返回可选日期列表（页面首次进入时用）。 */
export const SnapshotCompareQuerySchema = z.object({ a: dateText.optional(), b: dateText.optional() }).strict()
export type SnapshotCompareQuery = z.infer<typeof SnapshotCompareQuerySchema>
export const InventoryLedgerQuerySchema = CursorParamsSchema.strict()

/** 页面尚未接入的页签：说明原因与负责的工作包，不显示数字。 */
export interface PendingTab {
  state: 'NOT_CONNECTED'
  note: string
  workPackage: string
}

export interface InventorySuggestion {
  id: string
  rule: string
  evidence: string
  impact: string
  risk: string
  action: InventoryAction | null
}

export interface InventoryDetailResponse {
  row: InventoryRow
  policy: InventoryPolicy | null
  suggestions: InventorySuggestion[]
  freshness: InventoryFreshness
  /** 同店铺、同 SKU 的商品行编号：用来链到 ASIN 360（P2a-14）；商品目录里没有这个 SKU 时为 null。 */
  productId: string | null
}

// ---- 1 库存结构趋势 ----
export interface StructurePoint {
  date: string
  /** 同一天有多个来源时按优先级取一个来源的整行，不跨来源相加。 */
  source: string
  sellable: number | null
  inbound: number | null
  reserved: number | null
  unsellable: number | null
  researching: number | null
}
export interface InventoryStructureResponse {
  state: DashState
  note: string | null
  from: string
  to: string
  points: StructurePoint[]
}

// ---- 2 历史快照 ----
// 两个日期各一份“字段 → 值”的快照（字段中文名在 labels 里），页面用共享的快照对比组件展示差异。
export type SnapshotValue = number | string | null
export interface InventorySnapshotsResponse {
  availableDates: string[]
  labels: Record<string, string>
  a: { date: string; found: boolean; values: Record<string, SnapshotValue> }
  b: { date: string; found: boolean; values: Record<string, SnapshotValue> }
}

// ---- 3 库存台账 ----
export interface LedgerItem {
  id: string
  eventDate: string
  eventType: string
  reasonCode: string
  disposition: string
  fulfillmentCenter: string
  quantity: number
  referenceId: string | null
  /** 单据类型：订单（发货、退货）、入仓货件（接收）；其余为 null。对应页面上线后前端才渲染为链接，此前只显示编号。 */
  referenceKind: 'ORDER' | 'INBOUND_SHIPMENT' | null
}
export interface InventoryLedgerResponse {
  state: DashState
  note: string | null
  items: LedgerItem[]
  pageInfo: CursorPageInfo
}

// ---- 4 入仓与在途 ----
export interface InboundShipmentItem {
  planId: string
  planName: string
  planStatus: string
  /** 该 SKU 在这份入仓计划里的计划数量。 */
  planQuantity: number
  /** 计划还没有生成货件时，货件相关列为 null。 */
  shipmentId: string | null
  shipmentStatus: string | null
  destinationFc: string | null
  /** 货件整体的计划与已接收数量（接口按货件汇总，不按 SKU 拆分）。 */
  unitsExpected: number | null
  unitsReceived: number | null
  receiveProgress: number | null
}
export interface InventoryInboundResponse {
  counts: { working: number; shipped: number; receiving: number; total: number; counted: number }
  shipments: InboundShipmentItem[]
  eta: PendingTab
}

// ---- 6 补货建议 ----
export interface AmazonReplenishment {
  state: DashState
  note: string | null
  recommendedQty: number | null
  recommendedShipDate: string | null
  alertReason: string | null
  recommendedAction: string | null
  source: 'RESTOCK_REPORT' | 'PLANNING_REPORT' | null
  snapshotDate: string | null
}
export interface InventoryReplenishmentResponse {
  /** 我方：补货计算链（8 步）的结果，与补货建议页同一套算法；每一步带公式与输入。 */
  ours: ReplenishCalc
  amazon: AmazonReplenishment
  diffQty: number | null
  diffReasons: string[]
}

// ---- 7 库龄与费用 ----
export interface AgeCrossing {
  /** 进入的新档起始天数（91、181、271、366、456）。 */
  boundaryDays: number
  /** 新档名称，例如 181-270 天。 */
  toLabel: string
  /** 将要跨档的数量（目前在紧邻的上一档）。 */
  qty: number
  /** 最早 / 最晚跨档日期：库龄在分段内的具体分布未知，按分段上下界给出窗口（企业时区日历日）。 */
  earliestDate: string
  latestDate: string
  /** 窗口已过（应已进入新档，等待下一份快照确认）。 */
  likelyCrossed: boolean
  /** 该档是否收取库龄附加费。 */
  feeTier: boolean
  /** 预计新增附加费（模型估算：跨档数量 × 本 SKU 目标档当前平均单价）；无法估算时为 null 并写明原因。 */
  estimatedIncrease: number | null
  note: string | null
}
export interface InventoryAgeFeesResponse {
  state: DashState
  note: string | null
  snapshotDate: string | null
  granularity: 'FINE' | 'COARSE' | null
  buckets: Array<{ key: string; label: string; qty: number | null }>
  surchargeEstimate: number | null
  bands: Array<{ label: string; amount: number | null }>
  longTerm6Month: number | null
  longTerm12Month: number | null
  crossings: AgeCrossing[]
}

// ---- 8 处置建议 ----
export interface InventoryDispositionResponse {
  amazon: {
    state: DashState
    action: string | null
    salePrice: number | null
    saleDays: number | null
    removalQty: number | null
    removalReason: string | null
    savings: number | null
    note: string | null
  }
  ours: {
    state: DashState
    action: InventoryAction | null
    excessQty: number | null
    /** 预计节省（模型估算）= 冗余数量 ×（每件下月仓储费 + 每件库龄附加费）；不含移除费与降价让利。 */
    estimatedSavings: number | null
    formula: string | null
    note: string
  }
}

// ---- 9 预测 ----
export interface ForecastPoint {
  date: string
  low: number | null
  mid: number | null
  high: number | null
}
export interface InventoryForecastResponse {
  state: DashState
  note: string | null
  method: string
  source: 'ORDERS' | 'AMAZON_REPORT' | null
  history: Array<{ date: string; units: number; stockout: boolean }>
  forecast: ForecastPoint[]
  exclusions: { stockoutDays: number; stockoutNote: string; promotionNote: string; seasonality: string | null }
}
