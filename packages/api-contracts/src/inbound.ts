import { z } from 'zod'
import { AmazonSourceAddressSchema } from './core-schemas.js'

// 入仓计划契约（P2a-12，06 章 6.11；freeze/api.md 第九节“入仓”）。
// 数据来源：Fulfillment Inbound API v2024-03-20 与 FBA Inbound Eligibility API。美国站自 2026-01-01 起亚马逊不再提供预处理与贴标服务，
// 两者固定为卖家（01 章 1.7 第 1 条）：契约里没有这两个字段的任何取值，页面也不提供选项。
// 没有数据的列为 null（不是 0）；亚马逊侧的写操作都是异步的，界面展示操作状态直到亚马逊返回结果。

export const INBOUND_READ = 'inbound.read'
export const INBOUND_WRITE = 'inbound.plan.write'
export const INBOUND_OP_JOB = 'FBA_INBOUND_OP'
export const INBOUND_SYNC_JOB = 'FBA_INBOUND_SYNC'
/** 后台等待亚马逊异步操作的上限：超过按超时处理，页面提示人工核对。 */
export const INBOUND_OP_TIMEOUT_MINUTES = 15
export const INBOUND_MAX_ITEMS = 200
export const INBOUND_MAX_BOXES = 500

export const INBOUND_STAGES = [
  'DRAFT',
  'ELIGIBILITY',
  'CREATED',
  'PACKING_CONFIRMED',
  'PACKING_INFO_SUBMITTED',
  'PLACEMENT_CONFIRMED',
  'TRANSPORT_CONFIRMED',
  'LABELS_PRINTED',
  'SHIPPED',
  'RECEIVING',
  'DISCREPANCY',
  'COMPLETED',
  'CANCELLED',
] as const
export type InboundStage = (typeof INBOUND_STAGES)[number]
export const INBOUND_STAGE_LABEL: Record<InboundStage, string> = {
  DRAFT: '草稿',
  ELIGIBILITY: '资格预检通过',
  CREATED: '入仓计划已创建',
  PACKING_CONFIRMED: '装箱方案已确认',
  PACKING_INFO_SUBMITTED: '箱内物品信息已提交',
  PLACEMENT_CONFIRMED: '分仓方案已确认',
  TRANSPORT_CONFIRMED: '运输方案已确认',
  LABELS_PRINTED: '标签已打印',
  SHIPPED: '已发货',
  RECEIVING: '运营中心接收中',
  DISCREPANCY: '差异处理中',
  COMPLETED: '已完结',
  CANCELLED: '已取消',
}
/** 步骤条：状态链（取消是分支，不在链上）。 */
export const INBOUND_STEP_CHAIN = INBOUND_STAGES.filter(stage => stage !== 'CANCELLED') as readonly InboundStage[]
export const inboundStageIndex = (stage: InboundStage) => INBOUND_STEP_CHAIN.indexOf(stage)
export const isInboundStage = (value: string): value is InboundStage => (INBOUND_STAGES as readonly string[]).includes(value)

export const INBOUND_OPS = [
  'ELIGIBILITY',
  'CREATE_PLAN',
  'GENERATE_PACKING',
  'CONFIRM_PACKING',
  'SUBMIT_PACKING_INFO',
  'GENERATE_PLACEMENT',
  'CONFIRM_PLACEMENT',
  'GENERATE_TRANSPORT',
  'CONFIRM_TRANSPORT',
  'GENERATE_WINDOWS',
  'CONFIRM_WINDOW',
  'UPDATE_TRACKING',
  'CANCEL_PLAN',
  'LABELS',
] as const
export type InboundOp = (typeof INBOUND_OPS)[number]
export const INBOUND_OP_LABEL: Record<InboundOp, string> = {
  ELIGIBILITY: '资格预检',
  CREATE_PLAN: '创建入仓计划',
  GENERATE_PACKING: '生成装箱方案',
  CONFIRM_PACKING: '确认装箱方案',
  SUBMIT_PACKING_INFO: '提交箱内物品信息',
  GENERATE_PLACEMENT: '生成分仓方案',
  CONFIRM_PLACEMENT: '确认分仓方案',
  GENERATE_TRANSPORT: '生成运输方案',
  CONFIRM_TRANSPORT: '确认运输方案',
  GENERATE_WINDOWS: '生成送达时间窗',
  CONFIRM_WINDOW: '确认送达时间窗',
  UPDATE_TRACKING: '回填追踪号',
  CANCEL_PLAN: '取消入仓计划',
  LABELS: '获取标签',
}
export const INBOUND_OP_STATUSES = ['QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'TIMEOUT'] as const
export type InboundOpStatus = (typeof INBOUND_OP_STATUSES)[number]
export const INBOUND_OP_STATUS_LABEL: Record<InboundOpStatus, string> = { QUEUED: '排队中', IN_PROGRESS: '亚马逊处理中', SUCCESS: '成功', FAILED: '失败', TIMEOUT: '等待超时' }

/** 受写入开关控制的操作（freeze/permissions.md 第六节；CR-004 扩大了两项的语义）。生成类操作只产生可比较的方案，不受开关控制。 */
export const INBOUND_SWITCH_OF_OP: Partial<Record<InboundOp, string>> = {
  CREATE_PLAN: 'sw.inbound.plan.create',
  CANCEL_PLAN: 'sw.inbound.plan.create',
  CONFIRM_PACKING: 'sw.inbound.packing.confirm',
  SUBMIT_PACKING_INFO: 'sw.inbound.packinginfo.submit',
  CONFIRM_PLACEMENT: 'sw.inbound.placement.confirm',
  CONFIRM_TRANSPORT: 'sw.inbound.transport.confirm',
  CONFIRM_WINDOW: 'sw.inbound.transport.confirm',
  UPDATE_TRACKING: 'sw.inbound.transport.confirm',
}
export const INBOUND_SWITCH_KEYS = [...new Set(Object.values(INBOUND_SWITCH_OF_OP))] as string[]

// REPLENISHMENT_BATCH 是 P6-08 补货批次转来的草稿（sourceRefId 存批次编号）；REPLENISHMENT 是旧取值，保留兼容
export const INBOUND_SOURCE_TYPES = ['MANUAL', 'REPLENISHMENT', 'REPLENISHMENT_BATCH', 'PURCHASE_ORDER'] as const
export const INBOUND_SOURCE_LABEL: Record<(typeof INBOUND_SOURCE_TYPES)[number], string> = { MANUAL: '手工', REPLENISHMENT: '补货批次', REPLENISHMENT_BATCH: '补货批次', PURCHASE_ORDER: '采购单' }

export const SHIPPING_MODES = ['SPD', 'LTL', 'FTL'] as const
export type ShippingMode = (typeof SHIPPING_MODES)[number]
export const SHIPPING_MODE_LABEL: Record<ShippingMode, string> = { SPD: '小包裹', LTL: '零担', FTL: '整车' }
/** 作废窗口（确认运输方案之后）：小包裹 24 小时，零担与整车 1 小时。 */
export const VOID_WINDOW_HOURS: Record<ShippingMode, number> = { SPD: 24, LTL: 1, FTL: 1 }
export const shippingModeOf = (amazonMode: string | null | undefined): ShippingMode | null => {
  const value = (amazonMode ?? '').toUpperCase()
  if (value === 'GROUND_SMALL_PARCEL') return 'SPD'
  if (value === 'FREIGHT_LTL') return 'LTL'
  if (value.startsWith('FREIGHT_FTL')) return 'FTL'
  return null
}
/** 作废截止时间：优先用亚马逊报价里给的 voidableUntil，没有就按确认时间加窗口时长。 */
export function voidDeadlineOf(confirmedAt: Date, mode: ShippingMode | null, voidableUntil?: Date | null): Date | null {
  if (voidableUntil && voidableUntil.getTime() > confirmedAt.getTime()) return voidableUntil
  return mode ? new Date(confirmedAt.getTime() + VOID_WINDOW_HOURS[mode] * 3_600_000) : null
}
export function voidWindowOf(deadline: Date | null, now: Date) {
  if (!deadline) return { deadline: null as string | null, remainingMs: null as number | null, expired: false, known: false }
  const remainingMs = deadline.getTime() - now.getTime()
  return { deadline: deadline.toISOString(), remainingMs: Math.max(0, remainingMs), expired: remainingMs <= 0, known: true }
}

// ---- 动作可用性：前端按钮与后端校验用同一份 ----

export const INBOUND_ACTIONS = [
  'ELIGIBILITY',
  'SUBMIT',
  'GENERATE_PACKING',
  'CONFIRM_PACKING',
  'SAVE_BOXES',
  'SUBMIT_PACKING_INFO',
  'GENERATE_PLACEMENT',
  'CONFIRM_PLACEMENT',
  'GENERATE_TRANSPORT',
  'GENERATE_WINDOWS',
  'CONFIRM_WINDOW',
  'CONFIRM_TRANSPORT',
  'PRINT_LABELS',
  'MARK_SHIPPED',
  'UPDATE_TRACKING',
  'CANCEL',
] as const
export type InboundAction = (typeof INBOUND_ACTIONS)[number]
export interface InboundActionState {
  allowed: boolean
  reason: string | null
}
const AFTER_CREATE: InboundStage[] = ['CREATED']
const ACTION_STAGES: Record<InboundAction, InboundStage[]> = {
  ELIGIBILITY: ['DRAFT', 'ELIGIBILITY'],
  SUBMIT: ['ELIGIBILITY'],
  GENERATE_PACKING: AFTER_CREATE,
  CONFIRM_PACKING: AFTER_CREATE,
  SAVE_BOXES: ['PACKING_CONFIRMED'],
  SUBMIT_PACKING_INFO: ['PACKING_CONFIRMED'],
  GENERATE_PLACEMENT: ['PACKING_INFO_SUBMITTED'],
  CONFIRM_PLACEMENT: ['PACKING_INFO_SUBMITTED'],
  GENERATE_TRANSPORT: ['PLACEMENT_CONFIRMED'],
  GENERATE_WINDOWS: ['PLACEMENT_CONFIRMED'],
  CONFIRM_WINDOW: ['PLACEMENT_CONFIRMED'],
  CONFIRM_TRANSPORT: ['PLACEMENT_CONFIRMED'],
  PRINT_LABELS: ['TRANSPORT_CONFIRMED', 'LABELS_PRINTED'],
  MARK_SHIPPED: ['LABELS_PRINTED'],
  UPDATE_TRACKING: ['TRANSPORT_CONFIRMED', 'LABELS_PRINTED', 'SHIPPED', 'RECEIVING'],
  CANCEL: [],
}
const CANCEL_FREE: InboundStage[] = ['DRAFT', 'ELIGIBILITY', 'CREATED', 'PACKING_CONFIRMED', 'PACKING_INFO_SUBMITTED', 'PLACEMENT_CONFIRMED']
const NEEDS_PREVIOUS_STEP: Partial<Record<InboundAction, string>> = {
  SUBMIT: '请先完成资格预检',
  GENERATE_PACKING: '请先把计划提交到亚马逊',
  CONFIRM_PACKING: '请先把计划提交到亚马逊',
  PRINT_LABELS: '运输方案确认后才能打印标签',
  MARK_SHIPPED: '请先打印标签',
}

export interface InboundPlanState {
  stage: InboundStage
  pendingOp: string | null
  voidDeadlineAt: Date | string | null
}
export function inboundPlanActions(plan: InboundPlanState, now: Date = new Date()): Record<InboundAction, InboundActionState> {
  const deadline = plan.voidDeadlineAt ? new Date(plan.voidDeadlineAt) : null
  const result = {} as Record<InboundAction, InboundActionState>
  const terminal = plan.stage === 'CANCELLED' || plan.stage === 'COMPLETED'
  for (const action of INBOUND_ACTIONS) {
    let reason: string | null = null
    if (terminal) reason = `计划已${plan.stage === 'CANCELLED' ? '取消' : '完结'}`
    else if (plan.pendingOp) reason = '有操作正在处理中，请等亚马逊返回结果'
    else if (action === 'CANCEL') {
      if (!CANCEL_FREE.includes(plan.stage)) {
        if (plan.stage === 'TRANSPORT_CONFIRMED' || plan.stage === 'LABELS_PRINTED') {
          if (!deadline) reason = '没有取到作废窗口信息，不能取消'
          else if (deadline.getTime() <= now.getTime()) reason = '作废窗口已过，不能取消'
        } else reason = '货件已发出，不能取消计划'
      }
    } else if (!ACTION_STAGES[action].includes(plan.stage)) {
      reason =
        NEEDS_PREVIOUS_STEP[action] && inboundStageIndex(plan.stage) < inboundStageIndex(ACTION_STAGES[action][0])
          ? NEEDS_PREVIOUS_STEP[action]!
          : `当前状态（${INBOUND_STAGE_LABEL[plan.stage]}）不能做这一步`
    }
    result[action] = { allowed: reason === null, reason }
  }
  return result
}

// ---- 请求体 ----

const sku = z.string().trim().min(1, '请填写 SKU').max(120)
const quantity = z
  .number({ error: issue => (issue.input === undefined ? undefined : '数量必须是数字') })
  .int('数量必须是整数')
  .min(1, '数量至少为 1')
  .max(1_000_000)
const version = z.number().int().min(1)
const dateText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .optional()
export const InboundSourceAddressSchema = AmazonSourceAddressSchema.extend({
  companyName: z.string().trim().max(100).optional(),
  email: z.string().trim().email('邮箱格式不正确').max(120).optional(),
})
export const InboundPlanItemInputSchema = z.object({ sku, quantity, expiry: dateText })
export const InboundPlanCreateBodySchema = z.object({
  sellerAccountId: z.string().trim().min(1).max(60).optional(),
  name: z.string().trim().min(1, '请填写计划名称').max(120),
  sourceAddress: InboundSourceAddressSchema,
  items: z
    .array(InboundPlanItemInputSchema)
    .min(1, '至少添加一个商品')
    .max(INBOUND_MAX_ITEMS)
    .superRefine((items, ctx) => {
      const seen = new Set<string>()
      items.forEach((item, index) => {
        if (seen.has(item.sku)) ctx.addIssue({ code: 'custom', message: `SKU ${item.sku} 重复`, path: [index, 'sku'] })
        seen.add(item.sku)
      })
    }),
  sourceType: z.enum(INBOUND_SOURCE_TYPES).default('MANUAL'),
  sourceRefId: z.string().trim().max(60).optional(),
})
export type InboundPlanCreateBody = z.infer<typeof InboundPlanCreateBodySchema>
export const InboundVersionBodySchema = z.object({ version })
export const InboundCancelBodySchema = z.object({ version, reason: z.string().trim().min(2, '请填写取消原因').max(300) })
export const InboundOptionBodySchema = z
  .object({ version, action: z.enum(['GENERATE', 'CONFIRM']), optionId: z.string().trim().min(1).max(120).optional() })
  .refine(body => body.action === 'GENERATE' || !!body.optionId, { message: '确认时请选择一个方案', path: ['optionId'] })
const contact = z.object({
  name: z.string().trim().min(1, '请填写联系人').max(80),
  phoneNumber: z.string().trim().min(1, '请填写电话').max(30),
  email: z.string().trim().email('邮箱格式不正确').max(120),
})
export const InboundTransportBodySchema = z.discriminatedUnion('action', [
  z.object({
    version,
    action: z.literal('GENERATE'),
    shipments: z
      .array(z.object({ shipmentId: z.string().trim().min(1).max(60), readyToShipAt: z.string().datetime({ message: '备货完成时间格式不正确' }), contact }))
      .min(1, '至少选择一个货件')
      .max(100),
  }),
  z.object({
    version,
    action: z.literal('CONFIRM'),
    selections: z
      .array(z.object({ shipmentId: z.string().trim().min(1).max(60), transportOptionId: z.string().trim().min(1).max(120), contact }))
      .min(1, '至少为一个货件选择运输方案')
      .max(100),
  }),
])
export const InboundWindowBodySchema = z
  .object({ version, action: z.enum(['GENERATE', 'CONFIRM']), shipmentId: z.string().trim().min(1).max(60), optionId: z.string().trim().min(1).max(120).optional() })
  .refine(body => body.action === 'GENERATE' || !!body.optionId, { message: '确认时请选择一个时间窗', path: ['optionId'] })
const positiveNumber = (label: string) =>
  z
    .number({ error: issue => (issue.input === undefined ? undefined : `${label}必须是数字`) })
    .positive(`${label}必须大于 0`)
    .max(100_000)
export const InboundBoxInputSchema = z.object({
  boxId: z.string().trim().min(1).max(40).optional(),
  packingGroupId: z.string().trim().min(1).max(120).nullable().optional(),
  quantity: z.number().int('相同箱数必须是整数').min(1, '相同箱数至少为 1').max(10_000).default(1),
  weightLb: positiveNumber('重量'),
  lengthIn: positiveNumber('长'),
  widthIn: positiveNumber('宽'),
  heightIn: positiveNumber('高'),
  items: z.array(z.object({ sku, quantity })).min(1, '每个箱子至少装一种商品').max(100),
})
export type InboundBoxInput = z.infer<typeof InboundBoxInputSchema>
export const InboundBoxesBodySchema = z.object({ version, boxes: z.array(InboundBoxInputSchema).min(1, '至少添加一个箱子').max(INBOUND_MAX_BOXES) })
// 纸张类型是亚马逊 v0 getLabels 的 PageType；P6-12 增加了自定义箱标签用的三种（热敏 4×6 与 A4 每页 2 张、4 张）。
export const INBOUND_LABEL_PAGE_TYPES = [
  'PackageLabel_Letter_2',
  'PackageLabel_Letter_4',
  'PackageLabel_Letter_6',
  'PackageLabel_Plain_Paper',
  'PackageLabel_Thermal_NonPCP',
  'PackageLabel_A4_2',
  'PackageLabel_A4_4',
] as const
// 商品标签（FNSKU）自 P6-12 起改为本地生成的 PDF（POST /inbound/plans/:id/item-labels，走导出中心），不再有“商品标签清单（CSV）”这种打印任务；
// 这里只剩向亚马逊取箱标签。库里已有的 kind = ITEM 历史记录照常显示。
export const InboundLabelBodySchema = z.object({
  kind: z.enum(['BOX']),
  shipmentId: z.string().trim().min(1).max(60).optional(),
  pageType: z.enum(INBOUND_LABEL_PAGE_TYPES).default('PackageLabel_Letter_6'),
})
export const PlacementEstimateSchema = z.object({
  freightPerLb: z.number().min(0).max(1000).nullable().optional(),
  freightPerShipment: z.number().min(0).max(1_000_000).nullable().optional(),
  dailyStockoutCost: z.number().min(0).max(100_000_000).nullable().optional(),
  transitDaysByFc: z.record(z.string().min(1).max(20), z.number().min(0).max(90)).optional(),
})
export type PlacementEstimate = z.infer<typeof PlacementEstimateSchema>
export const InboundCostsBodySchema = z
  .object({
    version,
    prepCost: z.number().min(0).max(100_000_000).nullable().optional(),
    labelCost: z.number().min(0).max(100_000_000).nullable().optional(),
    estimate: PlacementEstimateSchema.optional(),
  })
  .refine(body => body.prepCost !== undefined || body.labelCost !== undefined || body.estimate !== undefined, { message: '请至少修改一项' })
export const InboundTrackingBodySchema = z
  .object({
    version,
    carrier: z.string().trim().max(60).optional(),
    items: z
      .array(z.object({ boxId: z.string().trim().min(1).max(60), trackingId: z.string().trim().min(1).max(60) }))
      .max(INBOUND_MAX_BOXES)
      .optional(),
    billOfLadingNumber: z.string().trim().min(1).max(60).optional(),
    freightBillNumber: z.string().trim().min(1).max(60).optional(),
  })
  .refine(body => (body.items?.length ?? 0) > 0 || !!body.billOfLadingNumber, { message: '请填写每个箱子的追踪号，或零担的提单号', path: ['items'] })
export const InboundShipmentListQuerySchema = z.object({
  planId: z.string().trim().min(1).max(60).optional(),
  status: z.string().trim().min(1).max(30).optional(),
  q: z.string().trim().max(80).optional(),
  /** 目的运营中心；传 discrepancy=1 只看有未消除的差异或不合规问题的货件（P2a-13）。 */
  destinationFc: z.string().trim().min(1).max(32).optional(),
  discrepancy: z.enum(['1']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export const InboundListQuerySchema = z.object({
  stage: z.enum(INBOUND_STAGES).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
