import { isAllocationRuleBasis, monthOfDay, monthText, type AllocationRuleLite } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { EMPTY_ALLOCATION, type AllocationInput } from './fee-allocation'

// 店铺级费用分摊规则与外部权重的读取（P6-19）：规则来自 AllocationRule；货件签收量与移除订单只在有规则用到时才读。都在租户上下文里读。

type Db = Pick<PrismaClient, 'allocationRule' | 'shipmentItem' | 'fbaInboundPlan' | 'removalOrder'>
const CAP = 20_000

const toNumberMap = (value: unknown): Record<string, number> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, number> = {}
  for (const [key, weight] of Object.entries(value as Record<string, unknown>)) if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) out[key] = weight
  return out
}

/** 范围覆盖的月份：起始月第一天（含）到结束月下个月第一天（不含）。 */
export function monthWindow(range: { from: string; to: string }): { start: Date; end: Date } {
  const start = new Date(`${monthOfDay(range.from)}-01T00:00:00Z`)
  const last = new Date(`${monthOfDay(range.to)}-01T00:00:00Z`)
  return { start, end: new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1)) }
}

export async function loadAllocation(db: Db, tenantId: string, range: { from: string; to: string }): Promise<AllocationInput> {
  const rows = await db.allocationRule.findMany({
    where: { tenantId },
    select: { id: true, feeItemId: true, basis: true, manualWeights: true, effectiveMonth: true, version: true },
    orderBy: [{ feeItemId: 'asc' }, { effectiveMonth: 'asc' }],
    take: 5000,
  })
  const rules: AllocationRuleLite[] = []
  for (const row of rows) {
    if (!isAllocationRuleBasis(row.basis)) continue
    rules.push({ id: row.id, feeItemId: row.feeItemId, basis: row.basis, manualWeights: toNumberMap(row.manualWeights), effectiveMonth: monthText(row.effectiveMonth), version: row.version })
  }
  if (rules.length === 0) return EMPTY_ALLOCATION
  const { start, end } = monthWindow(range)
  const shipment = new Map<string, Map<string, number>>()
  const removal = new Map<string, Map<string, number>>()
  const add = (target: Map<string, Map<string, number>>, store: string, month: string, sku: string, qty: number) => {
    if (!sku || qty <= 0) return
    const key = `${store}|${month}`
    const skus = target.get(key) ?? new Map<string, number>()
    skus.set(sku, (skus.get(sku) ?? 0) + qty)
    target.set(key, skus)
  }
  if (rules.some(rule => rule.basis === 'SHIPMENT_RECEIVED_UNITS')) {
    // 货件明细没有签收日期，取签收数最后一次更新所在的月份（见 CR-128 取舍）
    const items = await db.shipmentItem.findMany({
      where: { tenantId, receivedQty: { gt: 0 }, updatedAt: { gte: start, lt: end } },
      select: { sku: true, receivedQty: true, updatedAt: true, planId: true },
      take: CAP,
    })
    const planIds = [...new Set(items.map(item => item.planId))]
    const plans = planIds.length > 0 ? await db.fbaInboundPlan.findMany({ where: { tenantId, id: { in: planIds } }, select: { id: true, sellerAccountId: true }, take: CAP }) : []
    const storeOf = new Map(plans.map(plan => [plan.id, plan.sellerAccountId]))
    for (const item of items) add(shipment, storeOf.get(item.planId) ?? '', monthText(item.updatedAt), item.sku, item.receivedQty ?? 0)
  }
  if (rules.some(rule => rule.basis === 'REMOVAL_ORDER_SKU')) {
    const orders = await db.removalOrder.findMany({
      where: { tenantId, requestDate: { gte: start, lt: end } },
      select: { sellerAccountId: true, sku: true, requestedQty: true, requestDate: true },
      take: CAP,
    })
    for (const order of orders) add(removal, order.sellerAccountId, monthText(order.requestDate), order.sku, order.requestedQty)
  }
  return { rules, shipment, removal }
}
