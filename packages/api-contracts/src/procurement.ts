import { z } from 'zod'

// 采购订单契约（P2a-10，06 章 6.7；freeze/api.md `/purchase-orders*`）。
// 状态链：草稿 → 待审批 → 已下单 → 生产中 → 部分到货 → 全部到货 → 已关闭；异常分支：取消、退货给供应商。
// 金额与单价属字段权限 field.cost：没有该权限时响应里这些键不存在（不是空值）。没有数字显示“尚无记录”，不写 0。

export const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'RETURNED_TO_SUPPLIER'] as const
export type PoStatus = (typeof PO_STATUSES)[number]
export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  DRAFT: '草稿',
  PENDING_APPROVAL: '待审批',
  ORDERED: '已下单',
  IN_PRODUCTION: '生产中',
  PARTIALLY_RECEIVED: '部分到货',
  RECEIVED: '全部到货',
  CLOSED: '已关闭',
  CANCELLED: '已取消',
  RETURNED_TO_SUPPLIER: '退货给供应商',
}
/** 步骤条的主线（异常分支另行标出）。 */
export const PO_STEPS = ['DRAFT', 'PENDING_APPROVAL', 'ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const satisfies readonly PoStatus[]
export const PO_BRANCH_STATUSES = ['CANCELLED', 'RETURNED_TO_SUPPLIER'] as const satisfies readonly PoStatus[]
export const poStatusLabel = (status: string): string => PO_STATUS_LABEL[status as PoStatus] ?? status

export const APPROVAL_STATUS_LABEL: Record<string, string> = { NONE: '未提交', PENDING: '待审批', APPROVED: '已通过', REJECTED: '已驳回' }
export const PAYMENT_STATUS_LABEL: Record<string, string> = { UNPAID: '未付款', PARTIAL: '部分付款', PAID: '已付清' }
export const PAYMENT_KINDS = ['DEPOSIT', 'BALANCE', 'OTHER'] as const
export const PAYMENT_KIND_LABEL: Record<(typeof PAYMENT_KINDS)[number], string> = { DEPOSIT: '定金', BALANCE: '尾款', OTHER: '其他' }
export const INSPECTION_RESULTS = ['PASS', 'CONCESSION', 'FAIL'] as const
export const INSPECTION_RESULT_LABEL: Record<(typeof INSPECTION_RESULTS)[number], string> = { PASS: '合格', CONCESSION: '让步接收', FAIL: '不合格' }

export const PO_DETAIL_TABS = ['basic', 'lines', 'approval', 'payment', 'receiving', 'inspection', 'attachments', 'links', 'log'] as const
export type PoDetailTab = (typeof PO_DETAIL_TABS)[number]
export const PO_DETAIL_TAB_LABEL: Record<PoDetailTab, string> = {
  basic: '基本信息',
  lines: '商品行',
  approval: '审批',
  payment: '付款',
  receiving: '收货进度',
  inspection: '质检',
  attachments: '附件',
  links: '关联',
  log: '操作记录',
}

/** 订单上可以做的动作；服务端按状态算出，页面只负责显示。 */
export type PoAction = 'EDIT' | 'SUBMIT' | 'APPROVE' | 'START_PRODUCTION' | 'RECEIVE' | 'INSPECT' | 'PAY' | 'CLOSE' | 'CANCEL' | 'RETURN' | 'ATTACH'

const RECEIVING_STATES: readonly string[] = ['ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED']
const INSPECTION_STATES: readonly string[] = ['ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED', 'RECEIVED']
const PAYMENT_STATES: readonly string[] = ['ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']

export function purchaseOrderActions(order: { status: string; receivedQtyTotal: number }): PoAction[] {
  const { status } = order
  const actions: PoAction[] = ['ATTACH']
  if (status === 'DRAFT') actions.push('EDIT', 'SUBMIT', 'CANCEL')
  if (status === 'PENDING_APPROVAL') actions.push('APPROVE', 'CANCEL')
  if (status === 'ORDERED') actions.push('START_PRODUCTION')
  if (RECEIVING_STATES.includes(status)) actions.push('RECEIVE')
  if (INSPECTION_STATES.includes(status)) actions.push('INSPECT')
  if (PAYMENT_STATES.includes(status)) actions.push('PAY')
  // 没有收过货的订单才能直接取消；收过货的要走“退货给供应商”或“关闭”
  if (['ORDERED', 'IN_PRODUCTION'].includes(status) && order.receivedQtyTotal === 0) actions.push('CANCEL')
  if (['PARTIALLY_RECEIVED', 'RECEIVED'].includes(status)) actions.push('RETURN', 'CLOSE')
  return actions
}

// ---- 请求 ----

const id = z.string().trim().min(1).max(64)
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const version = z.number().int().min(1)
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, '币种应为 3 位字母代码')
const text = (max: number) => z.string().trim().max(max)
const reason = z.string().trim().min(2, '请填写原因（至少 2 个字）').max(500)

export const PoLineInputSchema = z.object({
  sellerSku: z.string().trim().min(1, '请填写 SKU').max(120),
  asin: text(20).optional(),
  title: text(300).optional(),
  quantity: z.number().int('数量必须是整数').min(1, '数量至少为 1').max(10_000_000),
  unitCost: z.number().min(0, '单价不能为负').max(1_000_000).optional(),
})
export type PoLineInput = z.infer<typeof PoLineInputSchema>

export const PurchaseOrderCreateBodySchema = z.object({
  supplierId: id,
  number: z.string().trim().min(1).max(60).optional(),
  currency: currency.optional(),
  expectedDate: dateText.optional(),
  notes: text(1000).optional(),
  lines: z.array(PoLineInputSchema).min(1, '至少添加一行商品').max(200),
})
export type PurchaseOrderCreateBody = z.infer<typeof PurchaseOrderCreateBodySchema>

export const PurchaseOrderUpdateBodySchema = z.object({
  version,
  expectedDate: dateText.nullable().optional(),
  notes: text(1000).nullable().optional(),
  lines: z.array(PoLineInputSchema).min(1).max(200).optional(),
})
export type PurchaseOrderUpdateBody = z.infer<typeof PurchaseOrderUpdateBodySchema>

export const PoVersionBodySchema = z.object({ version })
export const PoApprovalBodySchema = z
  .object({ version, decision: z.enum(['APPROVED', 'REJECTED']), comment: text(500).optional() })
  .refine(value => value.decision === 'APPROVED' || (value.comment ?? '').length >= 2, { path: ['comment'], message: '驳回必须填写意见（至少 2 个字）' })

export const PO_STATUS_ACTIONS = ['START_PRODUCTION', 'CLOSE', 'CANCEL', 'RETURN'] as const
export const PoStatusBodySchema = z
  .object({
    version,
    action: z.enum(PO_STATUS_ACTIONS),
    reason: reason.optional(),
    /** 退货给供应商：每个商品行退回的数量。 */
    lines: z
      .array(z.object({ lineId: id, quantity: z.number().int().min(1).max(10_000_000) }))
      .max(200)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== 'START_PRODUCTION' && !value.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: '请填写原因（至少 2 个字）' })
    if (value.action === 'RETURN' && !value.lines?.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: '请填写退回的商品与数量' })
  })

export const PoReceiptBodySchema = z.object({
  version,
  warehouseId: id.optional(),
  receivedAt: dateText,
  lines: z
    .array(z.object({ lineId: id, quantity: z.number().int().min(1, '数量至少为 1').max(10_000_000), batchNo: text(60).optional() }))
    .min(1, '至少登记一行收货')
    .max(200),
  note: text(500).optional(),
})

export const PoInspectionBodySchema = z
  .object({
    version,
    receiptId: id.optional(),
    result: z.enum(INSPECTION_RESULTS),
    lotQty: z.number().int().min(1, '批量至少为 1').max(10_000_000),
    sampleQty: z.number().int().min(1, '抽检数至少为 1').max(10_000_000),
    defectQty: z.number().int().min(0).max(10_000_000),
    handling: text(300).optional(),
    note: text(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sampleQty > value.lotQty) ctx.addIssue({ code: 'custom', path: ['sampleQty'], message: '抽检数不能超过批量' })
    if (value.defectQty > value.sampleQty) ctx.addIssue({ code: 'custom', path: ['defectQty'], message: '不良数不能超过抽检数' })
  })

export const PoPaymentBodySchema = z.object({
  version,
  /** 给出已有计划付款的编号表示“把这笔计划标为已付”；不给则新增一笔。 */
  paymentId: id.optional(),
  kind: z.enum(PAYMENT_KINDS),
  amount: z.number().gt(0, '金额必须大于 0').max(1_000_000_000),
  currency: currency.optional(),
  method: text(60).optional(),
  /** 实际付款日；不填表示只是“计划付款”。 */
  paidAt: dateText.optional(),
  plannedAt: dateText.optional(),
  voucherAttachmentId: id.optional(),
  note: text(500).optional(),
})

export const PurchaseOrderListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(PO_STATUSES).optional(),
  supplierId: id.optional(),
  currency: currency.optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID']).optional(),
  receiving: z.enum(['NONE', 'PARTIAL', 'FULL']).optional(),
  expectedFrom: dateText.optional(),
  expectedTo: dateText.optional(),
  minAmount: z.coerce.number().min(0).optional(),
  maxAmount: z.coerce.number().min(0).optional(),
  batchId: id.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type PurchaseOrderListQuery = z.infer<typeof PurchaseOrderListQuerySchema>

// ---- 附件（采购单与供应商共用）----

export const ATTACHMENT_ENTITY_TYPES = ['PURCHASE_ORDER', 'SUPPLIER', 'FIRST_MILE'] as const
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const
export const AttachmentTicketBodySchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES, { error: '只支持 PDF、图片、表格、文档与文本文件' }),
  sizeBytes: z.number().int().min(1, '文件是空的').max(ATTACHMENT_MAX_BYTES, '单个附件不能超过 20 MB'),
})
export const AttachmentConfirmBodySchema = z.object({ objectKey: z.string().trim().min(1).max(500), fileName: z.string().trim().min(1).max(200), contentType: z.enum(ATTACHMENT_CONTENT_TYPES) })

export interface AttachmentTicket {
  uploadUrl: string
  method: 'PUT'
  headers: Record<string, string>
  objectKey: string
  expiresAt: string
  maxBytes: number
}
export interface AttachmentRow {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedBy: string
  uploadedAt: string
}
export interface AttachmentLink {
  url: string
  expiresAt: string
}

// ---- 响应 ----

/** 交期偏差：预计到货日晚于补货需要日期。 */
export interface DeliveryDeviation {
  expectedDate: string
  needByDate: string
  lateDays: number
  sku: string
  batchNo: string | null
}

export interface PurchaseOrderRow {
  id: string
  number: string
  supplierId: string
  supplierName: string
  status: PoStatus
  statusLabel: string
  approvalStatus: string
  paymentStatus: string
  currency: string
  expectedDate: string | null
  lineCount: number
  orderedQty: number
  receivedQty: number
  /** 收货进度 0 到 1；订购数量为 0 时为 null。 */
  receiveRatio: number | null
  createdAt: string
  version: number
  deviation: DeliveryDeviation | null
  /** 以下两项需要字段权限 field.cost，没有时键不存在。 */
  totalAmount?: string | null
  paidAmount?: string
}

export interface PurchaseOrderListResponse {
  items: PurchaseOrderRow[]
  total: number
  page: number
  pageSize: number
}

export interface PoLineView {
  id: string
  sellerSku: string
  asin: string | null
  title: string | null
  quantity: number
  receivedQuantity: number
  currency: string
  /** 以下三项需要 field.cost。 */
  unitCost?: string | null
  lineAmount?: string | null
  costDiff?: CostDiffHint | null
}

/** 成本差异：采购单价与当前生效成本版本不一致。 */
export interface CostDiffHint {
  currentUnitCost: string
  currency: string
  /** (采购单价 − 当前成本) / 当前成本；当前成本为 0 时为 null。 */
  ratio: number | null
  comparable: boolean
}

export interface PoApprovalView {
  id: string
  step: number
  decision: string
  submittedByName: string
  approverName: string | null
  comment: string | null
  decidedAt: string | null
  createdAt: string
}
export interface PoPaymentView {
  id: string
  kind: string
  status: string
  currency: string
  method: string | null
  plannedAt: string | null
  paidAt: string | null
  voucherAttachmentId: string | null
  note: string | null
  createdByName: string
  /** 需要 field.cost。 */
  amount?: string
}
export interface PoReceiptView {
  id: string
  receiptNo: string
  receivedAt: string
  warehouseName: string | null
  totalQty: number
  note: string | null
  receivedByName: string
  lines: Array<{ lineId: string; sellerSku: string; quantity: number; batchNo: string | null }>
}
export interface PoInspectionView {
  id: string
  receiptNo: string | null
  result: string
  lotQty: number
  sampleQty: number
  defectQty: number
  /** 抽检比例（抽检数 / 批量）与不良率（不良数 / 抽检数）。 */
  sampleRatio: number
  defectRatio: number
  handling: string | null
  note: string | null
  inspectorName: string
  inspectedAt: string
}
export interface PoLogView {
  id: string
  at: string
  action: string
  actorName: string
  result: string
  reason: string | null
}
export interface PoFirstMileLink {
  id: string
  waybillNo: string
  forwarderName: string
  /** 这张采购单在该运单里发出的数量。 */
  quantity: number
}
/** shipmentIds：这张采购单的头程运单上登记、且属于该计划的亚马逊货件编号。 */
export type PoInboundPlanLink = { id: string; name: string; stage: string; stageLabel: string; shipmentIds: string[] }
export interface PoLinks {
  batches: Array<{ id: string; batchNo: string }>
  /** 入仓计划：顺着头程运单上登记的入仓货件推算（没有直接外键）；没有 firstmile.read 或 inbound.read 权限时为 NO_PERMISSION。 */
  inboundPlans: PoInboundPlanLink[] | 'NO_PERMISSION'
  /** 头程运单明细里引用了这张采购单的运单（P2a-11）；没有 firstmile.read 权限时为 NO_PERMISSION，不显示也不泄露。 */
  firstMile: PoFirstMileLink[] | 'NO_PERMISSION'
  costVersions: Array<{ sku: string; versionNo: number; status: string; unitProductCost: string | null; currency: string }>
}

export interface PurchaseOrderDetail {
  order: PurchaseOrderRow & { notes: string | null; createdByName: string; submittedAt: string | null; orderedAt: string | null; completedAt: string | null; supplierCode: string }
  lines: PoLineView[]
  approvals: PoApprovalView[]
  payments: PoPaymentView[]
  receipts: PoReceiptView[]
  inspections: PoInspectionView[]
  attachments: AttachmentRow[]
  links: PoLinks
  log: PoLogView[]
  actions: PoAction[]
  /** 创建人本人不能审批自己的单：页面据此给出说明。 */
  canApprove: boolean
}

/** 采购单写操作的统一返回：新的状态与版本号（页面据此刷新）。 */
export interface PoActionResult {
  id: string
  status: PoStatus
  statusLabel: string
  version: number
  /** 收货、质检、付款操作附带的单据编号。 */
  documentNo?: string
}
