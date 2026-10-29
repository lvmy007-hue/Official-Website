import { supplierRating, type SupplierTrendPoint } from '@nova/api-contracts'
import { daysBetween, dayText, ratioOf } from './procurement-common'

// 供应商表现指标的计算（纯函数，口径见契约 SUPPLIER_METRIC_BASIS）。
// “已完成”指已全部到货的采购单（completedAt 为最后一次收货日）；样本不足时返回 null，不返回 0。

export interface MetricOrder {
  expectedDate: Date | null
  orderedAt: Date | null
  completedAt: Date | null
}
export interface MetricInspection {
  sampleQty: number
  defectQty: number
}
export interface SupplierMetrics {
  onTimeRate: number | null
  qualityPassRate: number | null
  avgLeadDays: number | null
  completedOrders: number
  rating: 'A' | 'B' | 'C' | 'D' | null
}

const completed = (orders: MetricOrder[]) => orders.filter((order): order is MetricOrder & { completedAt: Date } => order.completedAt !== null)

function onTimeOf(orders: Array<MetricOrder & { completedAt: Date }>): number | null {
  const timed = orders.filter(order => order.expectedDate !== null)
  return ratioOf(timed.filter(order => (dayText(order.completedAt) as string) <= (dayText(order.expectedDate) as string)).length, timed.length)
}

function leadOf(orders: Array<MetricOrder & { completedAt: Date }>): number | null {
  const measured = orders.filter(order => order.orderedAt !== null)
  if (measured.length === 0) return null
  const total = measured.reduce((sum, order) => sum + Math.max(0, daysBetween(order.orderedAt as Date, order.completedAt)), 0)
  return Math.round(total / measured.length)
}

export function computeSupplierMetrics(orders: MetricOrder[], inspections: MetricInspection[]): SupplierMetrics {
  const done = completed(orders)
  const sample = inspections.reduce((sum, item) => sum + item.sampleQty, 0)
  const defect = inspections.reduce((sum, item) => sum + item.defectQty, 0)
  const onTimeRate = onTimeOf(done)
  const qualityPassRate = sample > 0 ? 1 - defect / sample : null
  return {
    onTimeRate,
    qualityPassRate,
    avgLeadDays: leadOf(done),
    completedOrders: done.length,
    rating: supplierRating({ onTimeRate, qualityPassRate, completedOrders: done.length }),
  }
}

/** 按完成月份的交付表现趋势（升序，最多最近 12 个月）。 */
export function supplierTrend(orders: MetricOrder[]): SupplierTrendPoint[] {
  const groups = new Map<string, Array<MetricOrder & { completedAt: Date }>>()
  for (const order of completed(orders)) {
    const month = (dayText(order.completedAt) as string).slice(0, 7)
    groups.set(month, [...(groups.get(month) ?? []), order])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-12)
    .map(([month, items]) => ({ month, completed: items.length, onTimeRate: onTimeOf(items), avgLeadDays: leadOf(items) }))
}
