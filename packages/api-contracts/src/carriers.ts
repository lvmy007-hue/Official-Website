import { z } from 'zod'
import { BILLING_MODES, CARRIER_STATUSES, SHIPMENT_GAP_FILTERS, type BillingMode, type CarrierStatus, type FreightEstimate, type MissingFreightField, type ShipmentGaps } from './freight-pricing.js'

// 物流渠道与报价、头程预估、货件三种差异的契约（P6-26；freeze/api.md `/first-mile/carriers*`、`/first-mile/:id/estimate`、`/inbound/shipments/discrepancies`）。
// 计费规则与纯函数在 freight-pricing.ts（零 zod）；这里放请求校验与响应形状。报价金额属 field.cost，没有字段权限时键不存在。

const text = (max: number) => z.string().trim().max(max)
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const paging = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }
const versioned = { version: z.number().int().min(1) }
const code = z
  .string()
  .trim()
  .min(1, '请填写代码')
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, '代码只能用字母、数字、下划线和短横线')
  .transform(value => value.toUpperCase())

export const CarrierListQuerySchema = z.object({ q: text(80).optional(), status: z.enum(CARRIER_STATUSES).optional(), ...paging })

export const CarrierCreateBodySchema = z.object({ name: z.string().trim().min(1, '请填写物流商名称').max(80), code })
export const CarrierUpdateBodySchema = z.object({ ...versioned, name: z.string().trim().min(1).max(80).optional(), code: code.optional(), status: z.enum(CARRIER_STATUSES).optional() })

const divisor = z.number().gt(0, '材积除数必须大于 0').max(1_000_000)
const split = z.number().gt(0, '分抛系数必须大于 0').max(1, '分抛系数不能超过 1')
export const ChannelCreateBodySchema = z.object({ name: z.string().trim().min(1, '请填写渠道名称').max(80), code, volumetricDivisor: divisor, splitFactor: split })
export const ChannelUpdateBodySchema = z.object({
  ...versioned,
  name: z.string().trim().min(1).max(80).optional(),
  code: code.optional(),
  volumetricDivisor: divisor.optional(),
  splitFactor: split.optional(),
  status: z.enum(CARRIER_STATUSES).optional(),
})

const rateFields = {
  region: z.string().trim().min(1, '请填写目的地区').max(40),
  weightFrom: z.number().min(0, '重量下限不能为负').max(100_000_000),
  weightTo: z.number().max(100_000_000).nullish(),
  unitPrice: z.number().min(0, '单价不能为负').max(1_000_000_000),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, '币种应为 3 位字母代码'),
  billingMode: z.enum(BILLING_MODES),
  effectiveFrom: dateText,
  effectiveTo: dateText.nullish(),
}
type RateShape = { weightFrom?: number; weightTo?: number | null; effectiveFrom?: string; effectiveTo?: string | null }
function refineRate(value: RateShape, ctx: z.RefinementCtx) {
  if (value.weightFrom !== undefined && value.weightTo !== undefined && value.weightTo !== null && value.weightTo <= value.weightFrom) {
    ctx.addIssue({ code: 'custom', path: ['weightTo'], message: '重量上限必须大于下限（留空表示无上限）' })
  }
  if (value.effectiveFrom && value.effectiveTo && value.effectiveTo < value.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: '截止日不能早于起始日' })
}
export const RateCreateBodySchema = z.object(rateFields).superRefine(refineRate)
export const RateUpdateBodySchema = z
  .object({ version: z.number().int().min(1) })
  .extend(z.object(rateFields).partial().shape)
  .superRefine(refineRate)
export const RateListQuerySchema = z.object({ region: text(40).optional(), ...paging })

/** 预估：渠道缺省时用运单上已选的渠道；地区必填（报价按目的地区分段）。 */
export const EstimateBodySchema = z.object({ channelId: z.string().trim().min(1).max(64).optional(), region: z.string().trim().min(1, '请选择目的地区').max(40) })

/** 批量补录：只补空着的重量与体积（已有值不覆盖）；行里什么都没填的不提交。 */
export const FillItemsBodySchema = z.object({
  ...versioned,
  rows: z
    .array(z.object({ sku: z.string().trim().min(1).max(120), weightKg: z.number().min(0).max(100_000_000).nullish(), volumeCbm: z.number().min(0).max(1_000_000).nullish() }))
    .min(1, '至少补录一个 SKU')
    .max(200),
})

export const ShipmentGapQuerySchema = z.object({
  gap: z.enum(SHIPMENT_GAP_FILTERS).optional(),
  q: text(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

// ---- 响应 ----

export interface RateRow {
  id: string
  region: string
  weightFrom: number
  weightTo: number | null
  /** 需要 field.cost。 */
  unitPrice?: string
  currency: string
  billingMode: BillingMode
  billingModeLabel: string
  effectiveFrom: string
  effectiveTo: string | null
  version: number
}
export interface RateListResponse {
  items: RateRow[]
  total: number
  page: number
  pageSize: number
  /** 这个渠道已有报价的目的地区（预估时选地区用）。 */
  regions: string[]
}

export interface ChannelRow {
  kind: 'CHANNEL'
  id: string
  carrierId: string
  carrierName: string
  name: string
  code: string
  volumetricDivisor: number
  splitFactor: number
  status: CarrierStatus
  version: number
  rateCount: number
  regions: string[]
  shipmentCount: number
}
export interface CarrierRow {
  kind: 'CARRIER'
  id: string
  name: string
  code: string
  status: CarrierStatus
  version: number
  channelCount: number
  channels: ChannelRow[]
}
export interface CarrierListResponse {
  items: CarrierRow[]
  total: number
  page: number
  pageSize: number
  canManage: boolean
  manageBlockedReason: string | null
}

export interface EstimateResponse {
  channelId: string
  channelName: string
  carrierName: string
  region: string
  /** 估价日（今天）；按这一天生效的报价计算。 */
  on: string
  estimate: FreightEstimate
}

export interface FillSuggestion extends MissingFreightField {
  /** 按商品档案里的单件包装尺寸、重量乘数量算出的建议值；档案没有就为 null。 */
  suggestedWeightKg: number | null
  suggestedVolumeCbm: number | null
}

export interface ShipmentGapRow extends ShipmentGaps {
  id: string
  shipmentId: string
  shipmentConfirmationId: string | null
  planId: string
  planName: string
  destinationFc: string | null
  status: string
  closed: boolean
  declared: number | null
  shipped: number | null
  received: number | null
}
export interface ShipmentGapResponse {
  items: ShipmentGapRow[]
  total: number
  page: number
  pageSize: number
  /** 扫描上限内没有看完（候选货件过多）时为 true。 */
  truncated: boolean
  note: string
}

export interface FillItemsResult {
  id: string
  version: number
  filled: number
}
