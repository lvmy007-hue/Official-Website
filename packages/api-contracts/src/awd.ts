import { z } from 'zod'
import type { DashState } from './dashboard.js'

// 亚马逊仓储分销（AWD，上游仓储）契约（P2a-08，06 章 6.3；freeze/api.md 第八节“上游仓储”）。
// 数据来源：Amazon Warehousing and Distribution API v2024-05-09。官方没有“列出入库订单”的操作，订单只能按编号读取（见 CR-031）。
// 没有数据的列为 null（不是 0）；店铺没有开通上游仓储时状态为 NOT_APPLICABLE，不显示任何数字。

export const AWD_TABS = ['inventory', 'orders', 'shipments'] as const
export type AwdTab = (typeof AWD_TABS)[number]
export const AWD_TAB_LABEL: Record<AwdTab, string> = { inventory: '库存', orders: '入库订单', shipments: '入库货件' }

/** 入库订单状态：前两项是我方状态（没有亚马逊订单编号），其余是亚马逊的订单状态。 */
export const AWD_ORDER_STATUSES = ['LOCAL_DRAFT', 'CREATE_FAILED', 'DRAFT', 'VALIDATING', 'CONFIRMED', 'CLOSED', 'EXPIRED', 'CANCELLED'] as const
export type AwdOrderStatus = (typeof AWD_ORDER_STATUSES)[number]
export const AWD_ORDER_STATUS_LABEL: Record<AwdOrderStatus, string> = {
  LOCAL_DRAFT: '本地草稿（未提交亚马逊）',
  CREATE_FAILED: '提交失败',
  DRAFT: '亚马逊草稿',
  VALIDATING: '亚马逊校验中',
  CONFIRMED: '已确认',
  CLOSED: '已关闭',
  EXPIRED: '已过期',
  CANCELLED: '已取消',
}
export const AWD_PENDING_ACTIONS = ['CREATE', 'UPDATE', 'CONFIRM', 'CANCEL', 'TRANSPORT'] as const
export type AwdPendingAction = (typeof AWD_PENDING_ACTIONS)[number]
export const AWD_PENDING_LABEL: Record<AwdPendingAction, string> = { CREATE: '提交中', UPDATE: '更新中', CONFIRM: '确认中', CANCEL: '取消中', TRANSPORT: '更新运输信息中' }

export const AWD_SHIPMENT_STATUSES = ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'RECEIVING', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const
export type AwdShipmentStatus = (typeof AWD_SHIPMENT_STATUSES)[number]
export const AWD_SHIPMENT_STATUS_LABEL: Record<AwdShipmentStatus, string> = {
  CREATED: '已创建',
  SHIPPED: '已发运',
  IN_TRANSIT: '运输中',
  RECEIVING: '接收中',
  DELIVERED: '已送达',
  CLOSED: '已关闭',
  CANCELLED: '已取消',
}

export const AWD_REGIONS = ['us-west', 'us-east', 'us-southcentral', 'us-southeast'] as const
export const AWD_REGION_LABEL: Record<(typeof AWD_REGIONS)[number], string> = { 'us-west': '美西', 'us-east': '美东', 'us-southcentral': '美中南', 'us-southeast': '美东南' }
export const AWD_PACKAGE_TYPES = ['CASE', 'PALLET'] as const
export const AWD_PACKAGE_TYPE_LABEL: Record<(typeof AWD_PACKAGE_TYPES)[number], string> = { CASE: '箱', PALLET: '托盘' }
export const AWD_LABEL_STATUS_LABEL: Record<string, string> = { GENERATING: '生成中', GENERATED: '已生成', GENERATION_FAILED: '生成失败', NOT_READY: '尚未就绪' }
/** 任务类型：同步读取与写入（后台任务）。写入类任务的流程类型见 @nova/workflow。 */
export const AWD_SYNC_JOB = 'AWD_SYNC'
export const AWD_WRITE_JOB = 'AWD_ORDER_WRITE'
export const AWD_LABELS_JOB = 'AWD_LABELS'
export const AWD_SWITCH_KEY = 'sw.awd.order.write'
/** 一个订单最多装多少种包装（防止超大请求体）。 */
export const AWD_MAX_PACKAGES = 50

// ---- 请求体 ----

export const AwdAddressSchema = z.object({
  name: z.string().trim().min(1, '请填写联系人或公司名').max(120),
  addressLine1: z.string().trim().min(1, '请填写地址').max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  stateOrRegion: z.string().trim().min(1, '请填写州或地区').max(100),
  postalCode: z.string().trim().max(20).optional(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, '国家代码为两位字母'),
  phoneNumber: z.string().trim().max(40).optional(),
})
export type AwdAddress = z.infer<typeof AwdAddressSchema>

const positive = (label: string) =>
  z
    .number({ error: issue => (issue.input === undefined ? undefined : `${label}必须是数字`) })
    .positive(`${label}必须大于 0`)
    .max(1_000_000)
export const AwdMeasurementSchema = z.object({
  weight: z.object({ value: positive('重量'), unit: z.enum(['POUNDS', 'KILOGRAMS']) }),
  dimensions: z.object({ length: positive('长'), width: positive('宽'), height: positive('高'), unit: z.enum(['INCHES', 'CENTIMETERS']) }).optional(),
})
export type AwdMeasurement = z.infer<typeof AwdMeasurementSchema>

export const AwdProductSchema = z.object({
  sku: z.string().trim().min(1, '请填写 SKU').max(120),
  quantity: z.number().int('数量必须是整数').min(1, '数量至少为 1').max(1_000_000),
  /** 到期日（有保质期的商品）。预处理方与贴标方固定为卖家，不提供选项（01 章 1.7）。 */
  expiration: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
    .optional(),
})
export type AwdProduct = z.infer<typeof AwdProductSchema>

export interface AwdPackageInput {
  type: (typeof AWD_PACKAGE_TYPES)[number]
  count: number
  measurements: AwdMeasurement
  products?: AwdProduct[]
  /** 托盘里装的箱（只允许一层）。 */
  packages?: AwdPackageInput[]
}
const casePackage: z.ZodType<AwdPackageInput> = z.object({
  type: z.enum(AWD_PACKAGE_TYPES),
  count: z.number().int('数量必须是整数').min(1).max(100_000),
  measurements: AwdMeasurementSchema,
  products: z.array(AwdProductSchema).max(200).optional(),
  packages: z
    .array(z.lazy(() => casePackage))
    .max(AWD_MAX_PACKAGES)
    .optional(),
})
export const AwdPackageSchema = casePackage.superRefine((value, ctx) => {
  const hasProducts = (value.products?.length ?? 0) > 0
  const hasPackages = (value.packages?.length ?? 0) > 0
  if (hasProducts === hasPackages) ctx.addIssue({ code: 'custom', message: '每个包装必须且只能装“商品”或“箱”之一', path: ['products'] })
  if (hasPackages && value.type !== 'PALLET') ctx.addIssue({ code: 'custom', message: '只有托盘可以装箱', path: ['packages'] })
  if (value.packages?.some(inner => (inner.packages?.length ?? 0) > 0 || inner.type !== 'CASE')) ctx.addIssue({ code: 'custom', message: '托盘里只能放装有商品的箱，不能再嵌套', path: ['packages'] })
})

const transportSchema = z.object({
  carrierCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,4}$/, '承运商代码是 2 到 4 位字母（SCAC）')
    .optional(),
  bookingId: z.string().trim().min(1, '请填写预约号或追踪号').max(120),
})

/** POST /awd/orders：submit 为 true 时校验完整并交给后台提交亚马逊；为 false 只保存本地草稿（不会调用亚马逊）。 */
export const AwdOrderCreateBodySchema = z
  .object({
    sellerAccountId: z.string().trim().min(1, '请选择店铺').max(60),
    originAddress: AwdAddressSchema.optional(),
    packages: z.array(AwdPackageSchema).max(AWD_MAX_PACKAGES).optional(),
    preferredRegion: z.enum(AWD_REGIONS).optional(),
    note: z.string().trim().max(500).optional(),
    submit: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (!value.submit) return
    if (!value.originAddress) ctx.addIssue({ code: 'custom', path: ['originAddress'], message: '提交亚马逊前请填写发货地址' })
    if (!value.packages?.length) ctx.addIssue({ code: 'custom', path: ['packages'], message: '提交亚马逊前请至少添加一个包装' })
    else if (awdPackagesMissingDimensions(value.packages) > 0) ctx.addIssue({ code: 'custom', path: ['packages'], message: '提交亚马逊前每个包装都要填写长宽高' })
  })
export type AwdOrderCreateBody = z.infer<typeof AwdOrderCreateBodySchema>

/** PATCH /awd/orders/:id：本地草稿与亚马逊草稿可改地址、包装与区域偏好；已确认的订单只能更新运输信息。 */
export const AwdOrderUpdateBodySchema = z.object({
  version: z.number().int().min(1),
  originAddress: AwdAddressSchema.optional(),
  packages: z.array(AwdPackageSchema).min(1).max(AWD_MAX_PACKAGES).optional(),
  preferredRegion: z.enum(AWD_REGIONS).optional(),
  note: z.string().trim().max(500).optional(),
  /** 本地草稿 / 提交失败的订单：true 表示改完立即提交亚马逊。 */
  submit: z.boolean().optional(),
  transport: transportSchema.optional(),
})
export type AwdOrderUpdateBody = z.infer<typeof AwdOrderUpdateBodySchema>

export const AwdVersionBodySchema = z.object({ version: z.number().int().min(1) })
export const AwdCancelBodySchema = z.object({ version: z.number().int().min(1), reason: z.string().trim().min(2, '请填写原因').max(500) })

export const AwdListQuerySchema = z.object({
  storeIds: z.string().max(2000).optional(),
  status: z.string().max(40).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type AwdListQuery = z.infer<typeof AwdListQuerySchema>

// ---- 响应 ----

export interface AwdWriteStatus {
  /** 服务端按“权限 → 连接 → 写入开关”判断的结果；页面据此禁用按钮并显示原因。 */
  allowed: boolean
  step: 'PERMISSION' | 'CONNECTION' | 'SWITCH' | null
  reason: string | null
  remedyPath: string | null
}

export interface AwdFreshness {
  status: string
  statusLabel: string
  lastSuccessAt: string | null
  errorMessage: string | null
}

export interface AwdInventoryRow {
  sellerAccountId: string
  storeName: string
  sku: string
  snapshotDate: string
  onhandQty: number | null
  availableQty: number | null
  reservedForReplenishment: number | null
  inboundToAwdQty: number | null
  outboundToFbaInTransit: number | null
  expiryDate: string | null
  expirations: Array<{ expiration: string | null; onhandQuantity: number | null }>
}

export interface AwdInventoryResponse {
  state: DashState | 'NOT_APPLICABLE'
  note: string | null
  items: AwdInventoryRow[]
  total: number
  page: number
  pageSize: number
  /** 范围内最近一次库存快照日期；没有为 null。 */
  snapshotDate: string | null
  totals: { onhandQty: number | null; availableQty: number | null; reservedForReplenishment: number | null; inboundToAwdQty: number | null; outboundToFbaInTransit: number | null }
  freshness: AwdFreshness | null
}

export interface AwdOrderRow {
  id: string
  sellerAccountId: string
  storeName: string
  orderId: string | null
  externalReferenceId: string | null
  status: AwdOrderStatus
  statusLabel: string
  pendingAction: AwdPendingAction | null
  expectedUnits: number | null
  receivedUnits: number | null
  packageDeliveryMode: string | null
  destinationRegion: string | null
  createdAt: string
  updatedAt: string
  version: number
  lastErrorMessage: string | null
}

export interface AwdOrderListResponse {
  state: DashState | 'NOT_APPLICABLE'
  note: string | null
  items: AwdOrderRow[]
  total: number
  page: number
  pageSize: number
  write: AwdWriteStatus
  freshness: AwdFreshness | null
}

export interface AwdShipmentItemRow {
  sku: string
  expectedQty: number | null
  receivedQty: number | null
  unit: string | null
  expiryDate: string | null
  prepInfo: unknown
}

export interface AwdShipmentRow {
  id: string
  shipmentId: string
  orderId: string | null
  orderRowId: string | null
  status: AwdShipmentStatus | string
  statusLabel: string
  carrier: string | null
  trackingNumber: string | null
  destination: string | null
  shipBy: string | null
  createdAt: string | null
  updatedAt: string | null
  labelStatus: string | null
  expectedUnits: number | null
  receivedUnits: number | null
  items?: AwdShipmentItemRow[]
}

export interface AwdShipmentListResponse {
  state: DashState | 'NOT_APPLICABLE'
  note: string | null
  items: AwdShipmentRow[]
  total: number
  page: number
  pageSize: number
  freshness: AwdFreshness | null
}

export interface AwdOrderDetail extends AwdOrderRow {
  originAddress: AwdAddress | null
  packages: AwdPackageInput[]
  preferredRegion: string | null
  note: string | null
  draft: { source: string; batchId: string | null; items: Array<{ sku: string; qty: number }> } | null
  shipments: AwdShipmentRow[]
  timeline: Array<{ at: string; title: string; detail: string | null }>
  write: AwdWriteStatus
  /** 当前状态下可以做的动作（服务端算出；页面不自己推断）。 */
  actions: AwdOrderActionKey[]
}

export interface AwdLabelResponse {
  shipmentId: string
  labelStatus: string | null
  labelStatusLabel: string
  /** 已生成并存入文件存储时给出带签名的短时下载链接；否则为 null。 */
  url: string | null
  expiresAt: string | null
  note: string | null
}

export interface AwdActionResponse {
  order: AwdOrderRow
  /** SAVED：只保存了本地数据；QUEUED：已交给后台任务调用亚马逊（结果以订单状态为准）。 */
  state: 'SAVED' | 'QUEUED'
  jobId: string | null
}

// ---- 动作规则（前后端共用，纯函数）----

export type AwdOrderActionKey = 'EDIT' | 'SUBMIT' | 'CONFIRM' | 'CANCEL' | 'TRANSPORT'

/** 当前状态下允许的动作。有后台操作在途时不允许任何动作；运输信息只在有亚马逊货件的已确认订单上更新。 */
export function awdOrderActions(order: { status: string; orderId: string | null; pendingAction: string | null }, hasShipment: boolean): AwdOrderActionKey[] {
  if (order.pendingAction) return []
  switch (order.status) {
    case 'LOCAL_DRAFT':
    case 'CREATE_FAILED':
      return ['EDIT', 'SUBMIT', 'CANCEL']
    case 'DRAFT':
      return ['EDIT', 'CONFIRM', 'CANCEL']
    case 'CONFIRMED':
      return hasShipment ? ['CANCEL', 'TRANSPORT'] : ['CANCEL']
    default:
      return []
  }
}

/** 本地草稿与提交失败的订单动作只改本地，不调用亚马逊；其余动作都是亚马逊写入（受写入开关控制）。 */
export const awdActionCallsAmazon = (action: AwdOrderActionKey, status: string): boolean => {
  if (action === 'EDIT') return status === 'DRAFT'
  if (action === 'CANCEL') return status !== 'LOCAL_DRAFT' && status !== 'CREATE_FAILED'
  return true
}

/** 递归统计包装里的商品件数（箱数 × 每箱件数；托盘里的箱同理）。 */
export function awdPackageUnits(packages: readonly AwdPackageInput[]): number {
  return packages.reduce((sum, pack) => {
    const own = (pack.products ?? []).reduce((inner, product) => inner + product.quantity, 0)
    return sum + pack.count * (own + awdPackageUnits(pack.packages ?? []))
  }, 0)
}

/** 包装方式：全是箱 CASE，全是托盘 PALLET，混合 MIXED；没有包装为 null。 */
export function awdDeliveryMode(packages: readonly AwdPackageInput[]): 'CASE' | 'PALLET' | 'MIXED' | null {
  const types = new Set(packages.map(pack => pack.type))
  if (types.size === 0) return null
  return types.size > 1 ? 'MIXED' : types.has('CASE') ? 'CASE' : 'PALLET'
}

/** 亚马逊要求创建入库订单时每个包装都填尺寸（官方模型：Dimensions are required when creating an inbound order）；返回缺尺寸的包装数（含托盘里的箱）。 */
export function awdPackagesMissingDimensions(packages: readonly AwdPackageInput[]): number {
  return packages.reduce((sum, pack) => sum + (pack.measurements.dimensions ? 0 : 1) + awdPackagesMissingDimensions(pack.packages ?? []), 0)
}

/** 库存详情的“上游仓储”页签：这个 SKU 在店铺 AWD 的库存与未完结的入库货件。没有快照时 stock 为 null（不显示 0）。 */
export interface AwdTabResponse {
  state: DashState | 'NOT_APPLICABLE'
  note: string | null
  snapshotDate: string | null
  stock: {
    onhandQty: number | null
    availableQty: number | null
    reservedForReplenishment: number | null
    inboundToAwdQty: number | null
    outboundToFbaInTransit: number | null
    expiryDate: string | null
    expirations: Array<{ expiration: string | null; onhandQuantity: number | null }>
  } | null
  inboundShipments: Array<{
    id: string
    shipmentId: string
    orderRowId: string | null
    status: string
    statusLabel: string
    expectedQty: number | null
    receivedQty: number | null
    unit: string | null
  }>
  freshness: AwdFreshness | null
}
