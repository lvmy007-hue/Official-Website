import { z } from 'zod'
import type { AttachmentRow, PurchaseOrderRow } from './procurement.js'

// 供应商契约（P2a-10，06 章 6.8；freeze/api.md `/suppliers*`）。
// 表现指标由系统根据采购单与质检记录重算，空值表示“样本不足”，不是 0；口径写在 SUPPLIER_METRIC_BASIS 里，页面原样显示。

export const SUPPLIER_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export const SUPPLIER_STATUS_LABEL: Record<(typeof SUPPLIER_STATUSES)[number], string> = { ACTIVE: '合作中', INACTIVE: '已停用' }

/** 评级至少需要的已完成采购单数；不足时不评级。 */
export const SUPPLIER_RATING_MIN_ORDERS = 3
export const SUPPLIER_METRIC_BASIS = {
  onTime: '准时交付率 = 已全部到货且填了预计到货日的采购单里，最后一次收货日不晚于预计到货日的占比',
  quality: '质检合格率 = 1 − 全部质检登记的不良数合计 / 抽检数合计',
  leadDays: '平均交期 = 已全部到货的采购单，从下单（审批通过）到最后一次收货的平均天数（四舍五入）',
  rating: `评级 = 准时交付率与质检合格率的平均值（缺质检记录时只看准时交付率）：≥95% 为 A，≥85% 为 B，≥70% 为 C，其余为 D；已完成采购单不足 ${SUPPLIER_RATING_MIN_ORDERS} 张时不评级`,
} as const

/** 评级：没有足够样本返回 null。输入为 0 到 1 的比率。 */
export function supplierRating(input: { onTimeRate: number | null; qualityPassRate: number | null; completedOrders: number }): 'A' | 'B' | 'C' | 'D' | null {
  if (input.completedOrders < SUPPLIER_RATING_MIN_ORDERS || input.onTimeRate === null) return null
  const score = input.qualityPassRate === null ? input.onTimeRate : (input.onTimeRate + input.qualityPassRate) / 2
  if (score >= 0.95) return 'A'
  if (score >= 0.85) return 'B'
  if (score >= 0.7) return 'C'
  return 'D'
}

const text = (max: number) => z.string().trim().max(max)
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, '币种应为 3 位字母代码')

export const SupplierCreateBodySchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, '请填写编码')
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, '编码只能包含字母、数字、下划线与连字符'),
  name: z.string().trim().min(1, '请填写名称').max(120),
  contactName: text(80).optional(),
  email: z.string().trim().email('邮箱格式不正确').max(160).optional(),
  phone: text(40).optional(),
  currency: currency.default('USD'),
  notes: text(1000).optional(),
})
export type SupplierCreateBody = z.infer<typeof SupplierCreateBodySchema>

export const SupplierUpdateBodySchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  contactName: text(80).nullable().optional(),
  email: z.string().trim().email('邮箱格式不正确').max(160).nullable().optional(),
  phone: text(40).nullable().optional(),
  currency: currency.optional(),
  notes: text(1000).nullable().optional(),
  status: z.enum(SUPPLIER_STATUSES).optional(),
})
export type SupplierUpdateBody = z.infer<typeof SupplierUpdateBodySchema>
export const SupplierVersionBodySchema = z.object({ version: z.number().int().min(1) })

export const SupplierListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(SUPPLIER_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type SupplierListQuery = z.infer<typeof SupplierListQuerySchema>

export interface SupplierRow {
  id: string
  code: string
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  currency: string
  status: string
  version: number
  poCount: number
  skuCount: number
  /** 以下四项为系统计算，样本不足时为 null。 */
  onTimeRate: number | null
  qualityPassRate: number | null
  avgLeadDays: number | null
  rating: 'A' | 'B' | 'C' | 'D' | null
  metricsAt: string | null
}

export interface SupplierListResponse {
  items: SupplierRow[]
  total: number
  page: number
  pageSize: number
}

export interface SupplierProductView {
  sku: string
  title: string | null
  orderedQty: number
  lastOrderedAt: string
  /** 报价历史：每张采购单一条（需要 field.cost，没有时整列不存在）。 */
  quotes?: Array<{ poNumber: string; orderedAt: string; unitCost: string | null; currency: string }>
}
export interface SupplierTrendPoint {
  month: string
  completed: number
  onTimeRate: number | null
  avgLeadDays: number | null
}
export interface SupplierInspectionView {
  id: string
  poNumber: string
  result: string
  lotQty: number
  sampleQty: number
  defectQty: number
  defectRatio: number
  inspectedAt: string
}

export interface SupplierDetail {
  supplier: SupplierRow & { notes: string | null; createdAt: string }
  products: SupplierProductView[]
  purchaseOrders: PurchaseOrderRow[]
  trend: SupplierTrendPoint[]
  inspections: SupplierInspectionView[]
  attachments: AttachmentRow[]
  basis: typeof SUPPLIER_METRIC_BASIS
}
