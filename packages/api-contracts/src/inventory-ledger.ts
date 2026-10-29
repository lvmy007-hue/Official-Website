import { z } from 'zod'
import { cursorListQuery, pageListQuery } from './query.js'
import type { CursorPageInfo } from './query.js'
import type { DashState } from './dashboard.js'
import type { InventoryFreshness } from './inventory.js'

// 库存台账契约（P2a-09，06 章 6.4；freeze/api.md `GET /inventory/ledger`）。
// 汇总视图按“店铺 × FNSKU × 月”把亚马逊台账汇总（R-13，逐日、逐库位、逐处置状态）折成一行，并做“期初 + 变动 = 期末”的平衡校验；
// 明细视图逐条列出台账流水（R-12），按事件类型分组。数量列都是整数：台账报告里没有的行不会出现，不会补 0。

export const LEDGER_VIEWS = ['summary', 'detail'] as const
export type LedgerView = (typeof LEDGER_VIEWS)[number]
export const LEDGER_VIEW_LABEL: Record<LedgerView, string> = { summary: '汇总', detail: '明细' }

/** 事件类型分组（明细筛选用）：按亚马逊台账的事件类型文字归类，认不出的归“其他”。 */
export const LEDGER_EVENT_GROUPS = ['receipt', 'shipment', 'customerReturn', 'vendorReturn', 'transfer', 'adjustment', 'other'] as const
export type LedgerEventGroup = (typeof LEDGER_EVENT_GROUPS)[number]
export const LEDGER_EVENT_GROUP_LABEL: Record<LedgerEventGroup, string> = {
  receipt: '接收',
  shipment: '客户发货',
  customerReturn: '客户退货',
  vendorReturn: '供应商退货',
  transfer: '仓间转运',
  adjustment: '调整',
  other: '其他',
}

/** 调整类事件按原因再细分（丢失、损坏、找到、处置、移除）；认不出原因时为 null。 */
export const LEDGER_ADJUSTMENT_LABEL = { lost: '丢失', damaged: '损坏', found: '找到', disposed: '处置', removal: '移除' } as const
export type LedgerAdjustmentKind = keyof typeof LEDGER_ADJUSTMENT_LABEL

const viewFilter = { type: 'enum', values: LEDGER_VIEWS } as const

/** 汇总视图：页码分页；unbalanced=true 只看平衡校验不通过的行。 */
export const LedgerSummaryQuerySchema = pageListQuery({
  sortable: ['month'] as const,
  defaultSort: { field: 'month', dir: 'desc' },
  filters: { view: viewFilter, unbalanced: { type: 'bool' } },
})
/** 明细视图：游标分页（台账明细量大），按事件日期倒序。 */
export const LedgerDetailQuerySchema = cursorListQuery({
  sortable: ['eventDate'] as const,
  defaultSort: { field: 'eventDate', dir: 'desc' },
  filters: { view: viewFilter, group: { type: 'enum', values: LEDGER_EVENT_GROUPS } },
})

export interface LedgerLiveCompare {
  /** 台账里这个 SKU 最后一天有数据的日期。 */
  ledgerDate: string
  /** 该日期各库位、各处置状态的期末余额合计。 */
  ledgerEnding: number
  /** 库存接口当前的仓内数量（可售 + 预留 + 不可售）；没有库存接口记录时为 null。 */
  liveQty: number | null
  difference: number | null
}

export interface LedgerSummaryRow {
  key: string
  sellerAccountId: string
  storeName: string
  fnsku: string
  sku: string
  asin: string
  month: string
  periodStart: string
  periodEnd: string
  startingQty: number
  receipts: number
  customerShipments: number
  customerReturns: number
  vendorReturns: number
  transfers: number
  found: number
  lost: number
  damaged: number
  disposed: number
  other: number
  unknownEvents: number
  endingQty: number
  /** 期初 + 全部变动，用来和报告给的期末核对。 */
  expectedEnding: number
  /** 报告期末 − 计算期末；不为 0 就是不平衡。 */
  difference: number
  balanced: boolean
  /** 只有这个 SKU 最近一个月的行带库存接口比对。 */
  live: LedgerLiveCompare | null
}

export interface LedgerSummaryResponse {
  view: 'summary'
  state: DashState
  note: string | null
  items: LedgerSummaryRow[]
  page: number
  pageSize: number
  total: number
  from: string
  to: string
  /** 范围内平衡校验不通过的行数（不受“只看不平衡”筛选影响）。 */
  unbalancedCount: number
  truncated: boolean
  freshness: InventoryFreshness
}

export interface LedgerDetailRow {
  id: string
  sellerAccountId: string
  storeName: string
  eventDate: string
  eventTime: string | null
  fnsku: string
  sku: string
  asin: string
  fulfillmentCenter: string
  disposition: string
  reasonCode: string
  eventType: string
  group: LedgerEventGroup
  groupLabel: string
  /** 调整类的细分（丢失、损坏……）；其余为 null。 */
  adjustmentLabel: string | null
  quantity: number
  referenceId: string | null
  referenceKind: 'ORDER' | 'INBOUND_SHIPMENT' | null
  reconciledQty: number | null
  unreconciledQty: number | null
}

export interface LedgerDetailResponse {
  view: 'detail'
  state: DashState
  note: string | null
  items: LedgerDetailRow[]
  pageInfo: CursorPageInfo
  freshness: InventoryFreshness
}

export type LedgerResponse = LedgerSummaryResponse | LedgerDetailResponse
export type LedgerSummaryQuery = z.infer<typeof LedgerSummaryQuerySchema>
export type LedgerDetailQuery = z.infer<typeof LedgerDetailQuerySchema>

// ---- 纯函数：台账平衡与事件分类 ----

export interface LedgerFlows {
  startingQty: number
  receipts: number
  customerShipments: number
  customerReturns: number
  vendorReturns: number
  transfers: number
  found: number
  lost: number
  damaged: number
  disposed: number
  other: number
  unknownEvents: number
  endingQty: number
}

/** 期初 + 全部变动（报告里发货、丢失、损坏等本身带负号，直接相加）。在途库存不是仓内余额的一部分，不参与。 */
export function ledgerExpectedEnding(flows: LedgerFlows): number {
  return (
    flows.startingQty +
    flows.receipts +
    flows.customerShipments +
    flows.customerReturns +
    flows.vendorReturns +
    flows.transfers +
    flows.found +
    flows.lost +
    flows.damaged +
    flows.disposed +
    flows.other +
    flows.unknownEvents
  )
}

/** 去掉空格、下划线与连字符并转小写，让 “Customer Returns”“CustomerReturns”“customer_returns” 归到同一类。 */
const squash = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '')

/** 事件类型分类的关键字（与明细筛选共用，数据库里用不区分大小写的“包含”匹配）。 */
export const LEDGER_GROUP_KEYWORDS: Record<Exclude<LedgerEventGroup, 'other'>, readonly string[]> = {
  receipt: ['receipt'],
  shipment: ['shipment'],
  customerReturn: ['customerreturn'],
  vendorReturn: ['vendorreturn'],
  transfer: ['transfer'],
  adjustment: ['adjust'],
}

export function classifyLedgerEvent(eventType: string, reason: string): { group: LedgerEventGroup; adjustment: LedgerAdjustmentKind | null } {
  const type = squash(eventType)
  // 客户退货、供应商退货要先于“发货”“接收”判断（其中不含这两个词，但保持从具体到一般的顺序）
  const order: Array<Exclude<LedgerEventGroup, 'other'>> = ['customerReturn', 'vendorReturn', 'receipt', 'shipment', 'transfer', 'adjustment']
  const group = order.find(key => LEDGER_GROUP_KEYWORDS[key].some(word => type.includes(word))) ?? 'other'
  if (group !== 'adjustment') return { group, adjustment: null }
  const text = squash(`${reason} ${eventType}`)
  const kinds: Array<[LedgerAdjustmentKind, string]> = [
    ['lost', 'lost'],
    ['damaged', 'damag'],
    ['found', 'found'],
    ['disposed', 'dispos'],
    ['removal', 'remov'],
  ]
  return { group, adjustment: kinds.find(([, word]) => text.includes(word))?.[0] ?? null }
}
