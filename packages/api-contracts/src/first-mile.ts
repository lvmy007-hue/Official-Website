import { z } from 'zod'
import type { AttachmentRow } from './procurement.js'
import type { FillSuggestion } from './carriers.js'
import { DEVIATION_DEFAULT_PCT } from './freight-pricing.js'
import { TRANSPORT_LABEL, TRANSPORT_MODES, type TransportMode } from './replenishment.js'

// 头程物流契约（P2a-11，06 章 6.10；freeze/api.md `/first-mile*`、`/freight-forwarders*`）。
// 金额类字段（预估与实际费用、费用明细、分摊结果、明细货值）属 field.cost，没有字段权限时键不存在；没有数据的写 null（页面显示“尚无记录”），不用 0 顶替。
// 体积（立方米）、重量（千克）、货值都是“这个 SKU 这批货的合计”，不是单件值；分摊按这些合计占比计算。

export const FIRST_MILE_MODES = TRANSPORT_MODES
export type FirstMileMode = TransportMode
export const FIRST_MILE_MODE_LABEL = TRANSPORT_LABEL

export const CUSTOMS_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'CLEARED', 'HELD'] as const
export type CustomsStatus = (typeof CUSTOMS_STATUSES)[number]
export const CUSTOMS_STATUS_LABEL: Record<CustomsStatus, string> = { NOT_STARTED: '未开始', IN_PROGRESS: '清关中', CLEARED: '已清关', HELD: '查验或滞留' }

export const FIRST_MILE_COST_ITEMS = ['FREIGHT', 'CLEARANCE', 'DUTY', 'DELIVERY', 'SURCHARGE'] as const
export type FirstMileCostItem = (typeof FIRST_MILE_COST_ITEMS)[number]
export const FIRST_MILE_COST_LABEL: Record<FirstMileCostItem, string> = { FREIGHT: '运费', CLEARANCE: '清关费', DUTY: '关税', DELIVERY: '送仓费', SURCHARGE: '附加费' }

export const ALLOCATION_METHODS = ['VOLUME', 'WEIGHT', 'VALUE', 'QTY'] as const
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number]
export const ALLOCATION_METHOD_LABEL: Record<AllocationMethod, string> = { VOLUME: '按体积', WEIGHT: '按重量', VALUE: '按货值', QTY: '按件数' }

export const MILESTONE_SOURCES = ['MANUAL', 'FILE_IMPORT', 'API'] as const
export const MILESTONE_SOURCE_LABEL: Record<(typeof MILESTONE_SOURCES)[number], string> = { MANUAL: '手工录入', FILE_IMPORT: '货代文件导入', API: '接口' }

/** 常用节点（录入时可直接选；文件导入时货代的叫法按别名归到这些节点，认不出的原样保留）。 */
export const MILESTONE_PRESETS = ['PICKED_UP', 'DEPARTED', 'ARRIVED_PORT', 'CUSTOMS_CLEARED', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const
export const MILESTONE_LABEL: Record<(typeof MILESTONE_PRESETS)[number], string> = {
  PICKED_UP: '货代提货',
  DEPARTED: '离港或起飞',
  ARRIVED_PORT: '到港',
  CUSTOMS_CLEARED: '清关完成',
  OUT_FOR_DELIVERY: '派送中',
  DELIVERED: '已交付',
}
export const milestoneLabel = (milestone: string): string => (MILESTONE_LABEL as Record<string, string>)[milestone] ?? milestone

/** 货代文件（importers.md F-03）的列：头程单号、节点、发生时间、地点、备注（中英文表头都认）。 */
export const MILESTONE_FILE_COLUMNS = {
  waybill: ['头程单号', '运单号', 'waybill', 'waybill no', 'waybill_no'],
  milestone: ['节点', 'milestone', 'status', 'event'],
  occurredAt: ['发生时间', '时间', 'occurred at', 'occurred_at', 'time', 'date'],
  location: ['地点', 'location'],
  note: ['备注', 'note', 'remark'],
} as const
export const MILESTONE_ALIASES: Record<(typeof MILESTONE_PRESETS)[number], readonly string[]> = {
  PICKED_UP: ['picked up', 'pickup', 'pick up', '提货', '货代提货', '已提货'],
  DEPARTED: ['departed', 'departure', 'etd', 'atd', 'take off', '离港', '起飞', '离港或起飞', '已发运'],
  ARRIVED_PORT: ['arrived', 'arrived port', 'arrival', 'ata', '到港', '抵港', '已到港'],
  CUSTOMS_CLEARED: ['customs cleared', 'cleared', 'customs clearance', '清关完成', '已清关', '放行'],
  OUT_FOR_DELIVERY: ['out for delivery', 'delivering', '派送中', '派送', '送仓中'],
  DELIVERED: ['delivered', 'pod', 'signed', '已交付', '签收', '已签收', '送达'],
}

/** 运单所处阶段：按实际日期推出，不另存一列。 */
export const FIRST_MILE_STAGES = ['PLANNED', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED'] as const
export type FirstMileStage = (typeof FIRST_MILE_STAGES)[number]
export const FIRST_MILE_STAGE_LABEL: Record<FirstMileStage, string> = { PLANNED: '待发运', IN_TRANSIT: '运输中', ARRIVED: '已到港', DELIVERED: '已交付' }
export function firstMileStage(dates: { shipDate: string | null; ataPort: string | null; ataDelivery: string | null }): FirstMileStage {
  if (dates.ataDelivery) return 'DELIVERED'
  if (dates.ataPort) return 'ARRIVED'
  return dates.shipDate ? 'IN_TRANSIT' : 'PLANNED'
}

/** 时效样本：发货日到实际交付日的自然日数；少于这个样本数不回写补货策略，也不当结论。 */
export const TRANSIT_MIN_SAMPLES = 3
export const TRANSIT_WINDOW_DAYS = 365
export const TRANSIT_BASIS = `实际时效 = 发货日到实际交付日的自然日数；统计最近 ${TRANSIT_WINDOW_DAYS} 天内已交付的运单，同一货代、同一运输方式一组；分位数取最近邻法（p50 为中位，p90 为九成运单不超过的天数）；样本少于 ${TRANSIT_MIN_SAMPLES} 单时只显示不建议回写`

/** 分位数（最近邻法）：样本为自然日数，返回样本里的一个值；没有样本返回 null。 */
export function percentileOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

export type FirstMileAction = 'EDIT' | 'ADD_MILESTONE' | 'ADD_COST' | 'ALLOCATE' | 'UNALLOCATE' | 'OUTBOUND'
/** 可用动作（服务端与页面共用）。分摊后费用与明细锁定，要改先撤销分摊；出库后明细不可改。 */
export function firstMileActions(input: { hasCosts: boolean; hasItems: boolean; allocated: boolean; outbound: boolean; hasWarehouse: boolean }): FirstMileAction[] {
  const actions: FirstMileAction[] = ['EDIT', 'ADD_MILESTONE']
  if (!input.allocated) actions.push('ADD_COST')
  if (!input.allocated && input.hasCosts && input.hasItems) actions.push('ALLOCATE')
  if (input.allocated) actions.push('UNALLOCATE')
  if (input.hasWarehouse && !input.outbound && input.hasItems) actions.push('OUTBOUND')
  return actions
}

const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const text = (max: number) => z.string().trim().max(max)
const money = z.number().min(0, '不能为负').max(1_000_000_000_000)
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, '币种应为 3 位字母代码')
const paging = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }

export const FirstMileListQuerySchema = z.object({
  q: text(80).optional(),
  forwarderId: z.string().max(64).optional(),
  mode: z.enum(FIRST_MILE_MODES).optional(),
  stage: z.enum(FIRST_MILE_STAGES).optional(),
  /** deviation=1 只看预估与实际差异比例（绝对值）不低于 deviationPct（缺省 20）的异常单；需要 field.cost（P6-26）。 */
  deviation: z.enum(['1']).optional(),
  deviationPct: z.coerce.number().min(0).max(10_000).default(DEVIATION_DEFAULT_PCT),
  ...paging,
})
export type FirstMileListQuery = z.infer<typeof FirstMileListQuerySchema>

export const FirstMileItemInputSchema = z.object({
  sku: z.string().trim().min(1, '请填写 SKU').max(120),
  purchaseOrderId: z.string().trim().max(64).nullish(),
  quantity: z.number().int().min(1, '数量至少为 1').max(10_000_000),
  cartons: z.number().int().min(0).max(1_000_000).nullish(),
  volumeCbm: z.number().min(0).max(1_000_000).nullish(),
  weightKg: z.number().min(0).max(100_000_000).nullish(),
  goodsValue: money.nullish(),
})
export type FirstMileItemInput = z.infer<typeof FirstMileItemInputSchema>

const shipmentFields = {
  forwarderId: z.string().trim().min(1, '请选择货代').max(64),
  waybillNo: z.string().trim().min(1, '请填写运单号').max(80),
  mode: z.enum(FIRST_MILE_MODES),
  containerNo: text(40).nullish(),
  shipDate: dateText.nullish(),
  etaPort: dateText.nullish(),
  ataPort: dateText.nullish(),
  customsStatus: z.enum(CUSTOMS_STATUSES),
  etaDelivery: dateText.nullish(),
  ataDelivery: dateText.nullish(),
  estimatedCost: money.nullish(),
  /** 预估依据的渠道（P6-26）；改预估金额时一并带上，手工填的金额传 null。 */
  carrierChannelId: z.string().trim().max(64).nullish(),
  currency,
  linkedInboundShipmentIds: z.array(z.string().trim().min(1).max(60)).max(50),
  warehouseId: z.string().trim().max(64).nullish(),
  note: text(1000).nullish(),
  items: z.array(FirstMileItemInputSchema).min(1, '至少录入一个 SKU').max(200),
}

type DateFields = { shipDate?: string | null; etaPort?: string | null; ataPort?: string | null; etaDelivery?: string | null; ataDelivery?: string | null }
/** 日期先后：到港与交付都不能早于发货日；实际交付不能早于实际到港。返回违反的项（服务端对“合并后的完整日期”再检查一遍）。 */
export function shipmentDateIssues(value: DateFields): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = []
  const later = (from: string | null | undefined, to: string | null | undefined, path: string, message: string) => {
    if (from && to && to < from) issues.push({ path, message })
  }
  later(value.shipDate, value.etaPort, 'etaPort', '预计到港不能早于发货日')
  later(value.shipDate, value.ataPort, 'ataPort', '实际到港不能早于发货日')
  later(value.shipDate, value.etaDelivery, 'etaDelivery', '预计交付不能早于发货日')
  later(value.shipDate, value.ataDelivery, 'ataDelivery', '实际交付不能早于发货日')
  later(value.ataPort, value.ataDelivery, 'ataDelivery', '实际交付不能早于实际到港')
  return issues
}
export function refineShipmentDates(value: DateFields, ctx: z.RefinementCtx) {
  for (const issue of shipmentDateIssues(value)) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message })
}
function refineItems(items: readonly { sku: string }[] | undefined, ctx: z.RefinementCtx) {
  if (!items) return
  const skus = items.map(item => item.sku)
  if (new Set(skus).size !== skus.length) ctx.addIssue({ code: 'custom', path: ['items'], message: '同一 SKU 只能出现一次（数量合并后再录）' })
}

export const FirstMileCreateBodySchema = z.object(shipmentFields).superRefine((value, ctx) => {
  refineShipmentDates(value, ctx)
  refineItems(value.items, ctx)
})
export type FirstMileCreateBody = z.infer<typeof FirstMileCreateBodySchema>

/** 修改：只传要改的字段；传了 items 就整体替换明细（分摊或出库后不允许）。 */
export const FirstMileUpdateBodySchema = z
  .object({ version: z.number().int().min(1) })
  .extend(z.object(shipmentFields).partial().shape)
  .superRefine((value, ctx) => {
    refineShipmentDates(value, ctx)
    refineItems(value.items, ctx)
  })
export type FirstMileUpdateBody = z.infer<typeof FirstMileUpdateBodySchema>

const versioned = { version: z.number().int().min(1) }
export const FirstMileMilestoneBodySchema = z.object({
  ...versioned,
  milestone: z.string().trim().min(1, '请填写节点').max(40),
  occurredAt: z
    .string()
    .trim()
    .refine(value => !Number.isNaN(new Date(value).getTime()), '时间格式不正确'),
  location: text(80).nullish(),
  note: text(300).nullish(),
})
export const FirstMileMilestoneImportBodySchema = z
  .object({ ...versioned, fileName: z.string().trim().min(1, '缺少文件名').max(200), content: z.string().min(1, '文件内容为空').max(200_000, '文件过大（上限约 200 KB）') })
  .strict()
export const FirstMileCostBodySchema = z.object({
  ...versioned,
  item: z.enum(FIRST_MILE_COST_ITEMS),
  amount: money.refine(value => value > 0, '金额必须大于 0'),
  incurredAt: dateText,
  note: text(300).nullish(),
})
export const FirstMileAllocateBodySchema = z.object({ ...versioned, method: z.enum(ALLOCATION_METHODS) })
export const FirstMileOutboundBodySchema = z.object({ ...versioned, outboundAt: dateText.optional() })
export const FirstMileVersionQuerySchema = z.object({ version: z.coerce.number().int().min(1) })

export const ForwarderCreateBodySchema = z.object({ name: z.string().trim().min(1, '请填写货代名称').max(120), contact: text(200).nullish(), defaultMode: z.enum(FIRST_MILE_MODES).nullish() })
export const ForwarderUpdateBodySchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  contact: text(200).nullish(),
  defaultMode: z.enum(FIRST_MILE_MODES).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
})
export const ForwarderListQuerySchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), q: text(80).optional(), ...paging })

/** 把统计出的实际时效回写到企业级补货策略的运输时效（生成一个新版本，不改旧版本）。 */
export const TransitApplyBodySchema = z.object({ forwarderId: z.string().trim().min(1).max(64), mode: z.enum(FIRST_MILE_MODES), expectedVersionNo: z.number().int().min(1) })

// ---- 响应 ----

export interface ForwarderRow {
  id: string
  name: string
  contact: string | null
  defaultMode: FirstMileMode | null
  status: string
  version: number
  shipmentCount: number
}
export interface ForwarderListResponse {
  items: ForwarderRow[]
  total: number
  page: number
  pageSize: number
}

export interface FirstMileRow {
  id: string
  forwarderId: string
  forwarderName: string
  waybillNo: string
  mode: FirstMileMode
  modeLabel: string
  containerNo: string | null
  shipDate: string | null
  etaPort: string | null
  ataPort: string | null
  customsStatus: CustomsStatus
  customsLabel: string
  etaDelivery: string | null
  ataDelivery: string | null
  stage: FirstMileStage
  stageLabel: string
  /** 已交付：实际比预计晚的天数（负数是提前）；未交付且已过预计交付日：已逾期天数；没有预计交付日、或还没到预计交付日为 null。 */
  delayDays: number | null
  currency: string
  /** 以下两项需要 field.cost；预估没填、没有任何费用记录时为 null。 */
  estimatedCost?: string | null
  actualCost?: string | null
  /** 实际 − 预估 ÷ 预估 × 100（保留 1 位）；预估或实际任何一边没有、币种不一致为 null；需要 field.cost（P6-26）。 */
  deviationPct?: number | null
  /** 预估依据的渠道；手工填的预估为 null（P6-26）。 */
  carrierChannelId: string | null
  carrierChannelName: string | null
  estimatedAt: string | null
  linkedInboundShipmentIds: string[]
  itemCount: number
  totalQty: number
  warehouseId: string | null
  warehouseName: string | null
  outboundAt: string | null
  allocated: boolean
  version: number
}
export interface FirstMileListResponse {
  items: FirstMileRow[]
  total: number
  page: number
  pageSize: number
  forwarders: Array<{ id: string; name: string; status: string; defaultMode: FirstMileMode | null }>
  warehouses: Array<{ id: string; name: string }>
}

export interface FirstMileItemView {
  sku: string
  purchaseOrderId: string | null
  purchaseOrderNo: string | null
  quantity: number
  cartons: number | null
  volumeCbm: number | null
  weightKg: number | null
  /** 需要 field.cost。 */
  goodsValue?: string | null
}
export interface FirstMileMilestoneView {
  id: string
  milestone: string
  label: string
  occurredAt: string
  location: string | null
  source: string
  sourceLabel: string
  note: string | null
  createdByName: string | null
}
export interface FirstMileCostView {
  id: string
  item: FirstMileCostItem
  itemLabel: string
  amount: string
  incurredAt: string
  note: string | null
  createdByName: string
}
export interface AllocationLineView {
  sku: string
  quantity: number
  allocatedAmount: string
  unitCost: string
  costVersionNo: number | null
  costVersionStatus: string | null
}
export interface AllocationView {
  method: AllocationMethod
  methodLabel: string
  currency: string
  total: string
  createdAt: string
  createdByName: string
  lines: AllocationLineView[]
}
export interface LinkedInboundView {
  shipmentId: string
  /** 在入仓货件同步数据里找不到时为 false，其余字段为 null。 */
  found: boolean
  status: string | null
  destinationFc: string | null
  unitsExpected: number | null
  unitsReceived: number | null
  /** 这个货件各 SKU 已发数量合计（ShipmentItem）；没有明细为 null（P6-26）。 */
  shippedUnits: number | null
}
/** 三处“已发数量”的核对（P6-26）：国内仓出库、头程运单明细、关联入仓货件已发。关联的货件有一个没同步到、或没有明细时不下结论。 */
export interface QtyCheck {
  state: 'MATCH' | 'MISMATCH' | 'NOT_LINKED' | 'INCOMPLETE'
  firstMileUnits: number
  /** 已出库时是国内仓出库流水的合计；没出库为 null。 */
  outboundUnits: number | null
  inboundShippedUnits: number | null
  note: string
}
export interface TransitHint {
  forwarderName: string
  mode: FirstMileMode
  sampleCount: number
  p50Days: number | null
  p90Days: number | null
}
export interface FirstMileDetail {
  shipment: FirstMileRow & { note: string | null; createdAt: string; createdByName: string }
  items: FirstMileItemView[]
  milestones: FirstMileMilestoneView[]
  /** 需要 field.cost。 */
  costs?: FirstMileCostView[]
  allocation?: AllocationView | null
  /** 每种分摊口径能不能用（缺数据时写明缺什么）；需要 field.cost。 */
  allocationReady?: Record<AllocationMethod, string | null>
  attachments: AttachmentRow[]
  linkedInbound: LinkedInboundView[]
  /** 逐个 SKU 列出缺的重量或体积，并给出按商品档案算的建议值（P6-26）。 */
  missingFields: FillSuggestion[]
  qtyCheck: QtyCheck
  actions: FirstMileAction[]
  transitHint: TransitHint | null
}

export interface MilestoneImportResponse {
  imported: number
  skippedDuplicates: number
  sourceFileName: string
  version: number
}
export interface FirstMileActionResult {
  id: string
  version: number
  message?: string
}

export type { TransitApplyResult, TransitMonthPoint, TransitStatRow, TransitStatsResponse } from './first-mile-transit.js'
