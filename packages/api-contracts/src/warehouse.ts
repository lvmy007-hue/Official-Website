import { z } from 'zod'

// 国内仓库存契约（P2a-10，06 章 6.9；freeze/api.md `/domestic-warehouse*`、`/stock-counts*`）。
// 在库 = 流水数量合计；锁定 = 流水占用数量合计（已分配给发货或头程）；可用 = 在库 − 锁定；
// 待出库 = 已选这个国内仓、尚未出库的头程运单（P2a-11）里该 SKU 的数量；货值需要字段权限 field.cost，没有时键不存在。

export const WAREHOUSE_KINDS = ['DOMESTIC', 'TRANSIT'] as const
export const WAREHOUSE_KIND_LABEL: Record<(typeof WAREHOUSE_KINDS)[number], string> = { DOMESTIC: '国内仓', TRANSIT: '头程中转仓' }
export const COST_METHODS = ['WEIGHTED_AVERAGE', 'FIFO'] as const
export const COST_METHOD_LABEL: Record<(typeof COST_METHODS)[number], string> = { WEIGHTED_AVERAGE: '移动加权平均', FIFO: '先进先出' }

export const MOVEMENT_TYPES = ['RECEIPT', 'REMOVAL_RETURN', 'RETURN_TO_SUPPLIER', 'FIRST_MILE_OUT', 'ADJUSTMENT'] as const
export type MovementType = (typeof MOVEMENT_TYPES)[number]
export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  RECEIPT: '采购收货',
  REMOVAL_RETURN: '移除退回',
  RETURN_TO_SUPPLIER: '退供应商',
  FIRST_MILE_OUT: '头程发货',
  ADJUSTMENT: '库存调整',
}
export const movementTypeLabel = (type: string): string => MOVEMENT_TYPE_LABEL[type as MovementType] ?? type

export const WAREHOUSE_TABS = ['stock', 'movements', 'counts'] as const
export type WarehouseTab = (typeof WAREHOUSE_TABS)[number]
export const WAREHOUSE_TAB_LABEL: Record<WarehouseTab, string> = { stock: '库存', movements: '流水', counts: '盘点' }

export const STOCK_COUNT_STATUS_LABEL: Record<string, string> = { COUNTING: '盘点中', PENDING_APPROVAL: '待审批', POSTED: '已过账' }

const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const paging = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }

export const WarehouseStockQuerySchema = z.object({ warehouseId: z.string().max(64).optional(), q: z.string().trim().max(80).optional(), ...paging })
export const WarehouseMovementQuerySchema = z.object({
  warehouseId: z.string().max(64).optional(),
  q: z.string().trim().max(80).optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: dateText.optional(),
  to: dateText.optional(),
  ...paging,
})
export const StockCountListQuerySchema = z.object({ warehouseId: z.string().max(64).optional(), status: z.enum(['COUNTING', 'PENDING_APPROVAL', 'POSTED']).optional(), ...paging })

export const StockCountBodySchema = z.object({
  warehouseId: z.string().trim().min(1).max(64),
  countedAt: dateText,
  lines: z
    .array(z.object({ sellerSku: z.string().trim().min(1).max(120), countedQty: z.number().int().min(0, '盘点数不能为负').max(100_000_000) }))
    .min(1, '至少录入一行')
    .max(1000),
  note: z.string().trim().max(500).optional(),
  /** 录完提交审批；不提交则保存为“盘点中”，可以改天继续录。 */
  submit: z.boolean().default(true),
})
export type StockCountBody = z.infer<typeof StockCountBodySchema>
export const StockCountApprovalBodySchema = z
  .object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().trim().max(500).optional() })
  .refine(value => value.decision === 'APPROVED' || (value.comment ?? '').length >= 2, { path: ['comment'], message: '驳回必须填写意见（至少 2 个字）' })

export interface WarehouseOption {
  id: string
  name: string
  code: string
  kind: string
  costMethod: string
  costMethodLabel: string
}

export interface WarehouseStockRow {
  warehouseId: string
  warehouseName: string
  sku: string
  onHand: number
  locked: number
  /** 在库 − 锁定。 */
  available: number
  /** 待出库：已选这个仓、还没点“出库”的头程运单里这个 SKU 的数量（P2a-11）；没有关联运单就是 0。 */
  pendingOutbound: number
  /** 现存库存里最早一批入库至今的天数（先进先出口径）；没有库存时为 null。 */
  ageDays: number | null
  /** 以下三项需要 field.cost；部分库存没有入库成本或币种混杂时 value 为 null 并给出原因。 */
  value?: string | null
  valueCurrency?: string | null
  valueNote?: string | null
}

export interface WarehouseStockResponse {
  items: WarehouseStockRow[]
  total: number
  page: number
  pageSize: number
  warehouses: WarehouseOption[]
  totals: { onHand: number; locked: number; available: number }
}

export interface WarehouseMovementRow {
  id: string
  occurredAt: string
  warehouseName: string
  sku: string
  movementType: string
  typeLabel: string
  quantity: number
  lockedForShipment: number
  reasonCode: string | null
  referenceType: string | null
  referenceId: string | null
  referenceNo: string | null
  notes: string | null
  operatorName: string
  /** 需要 field.cost。 */
  unitCost?: string | null
  currency?: string | null
}
export interface WarehouseMovementResponse {
  items: WarehouseMovementRow[]
  total: number
  page: number
  pageSize: number
}

export interface StockCountLine {
  sellerSku: string
  systemQty: number
  countedQty: number
  diff: number
}
export interface StockCountRow {
  id: string
  warehouseId: string
  warehouseName: string
  status: string
  statusLabel: string
  countedAt: string
  lines: StockCountLine[]
  diffTotal: number
  note: string | null
  reviewNote: string | null
  createdByName: string
  approvedByName: string | null
  approvedAt: string | null
  /** 录入人不能审批自己录的盘点单。 */
  canApprove: boolean
}
export interface StockCountListResponse {
  items: StockCountRow[]
  total: number
  page: number
  pageSize: number
}
