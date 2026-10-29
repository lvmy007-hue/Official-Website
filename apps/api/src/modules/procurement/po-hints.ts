import type { CostDiffHint, DeliveryDeviation, PoFirstMileLink } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { PrismaService } from '../../platform/prisma.service'
import { daysBetween, dayText } from './procurement-common'

// 采购单上的两类提示与补货批次关联：
// - 交期偏差：采购单预计到货日晚于它所来自的补货建议“需要的日期”（发货日，没有则取到仓日、到期日）；
// - 成本差异：商品行单价与该 SKU 当前生效成本版本不一致。
// 都只是提醒，不阻断任何操作；没有关联补货建议或没有生效成本版本时不给提示。

const OPEN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED']

export interface NeedBy {
  sku: string
  needByDate: Date
  batchNo: string | null
}
export interface PoReplenishmentLinks {
  batches: Map<string, string>
  needBy: NeedBy[]
}

/** 每张采购单关联的补货批次与各 SKU 需要到货的日期（来自“生成采购单草稿”的补货动作）。 */
export async function loadReplenishmentLinks(prisma: PrismaService, tenantId: string, poIds: readonly string[]): Promise<Map<string, PoReplenishmentLinks>> {
  const result = new Map<string, PoReplenishmentLinks>()
  if (poIds.length === 0) return result
  const actions = await prisma.replenishmentAction.findMany({
    where: { tenantId, targetDocType: 'PURCHASE_ORDER', targetDocId: { in: [...poIds] } },
    select: {
      targetDocId: true,
      batch: { select: { id: true, batchNo: true } },
      recommendation: { select: { sku: true, shipDate: true, arriveDate: true, dueDate: true } },
    },
    take: 5000,
  })
  for (const action of actions) {
    if (!action.targetDocId) continue
    const links = result.get(action.targetDocId) ?? { batches: new Map<string, string>(), needBy: [] }
    links.batches.set(action.batch.id, action.batch.batchNo)
    const date = action.recommendation.shipDate ?? action.recommendation.arriveDate ?? action.recommendation.dueDate
    links.needBy.push({ sku: action.recommendation.sku, needByDate: date, batchNo: action.batch.batchNo })
    result.set(action.targetDocId, links)
  }
  return result
}

/** 交期偏差（最严重的一条）；订单已到齐、关闭或取消时不提醒。 */
export function deliveryDeviation(order: { status: string; expectedDate: Date | null }, needBy: readonly NeedBy[]): DeliveryDeviation | null {
  if (!order.expectedDate || !OPEN_STATUSES.includes(order.status)) return null
  const expected = order.expectedDate
  const late = needBy.filter(item => item.needByDate.getTime() < expected.getTime()).sort((a, b) => a.needByDate.getTime() - b.needByDate.getTime())[0]
  if (!late) return null
  return {
    expectedDate: dayText(expected) as string,
    needByDate: dayText(late.needByDate) as string,
    lateDays: daysBetween(late.needByDate, expected),
    sku: late.sku,
    batchNo: late.batchNo,
  }
}

/** 每个 SKU 当前生效的成本版本（最新版本号）。 */
export async function loadActiveCosts(prisma: PrismaService, tenantId: string, skus: readonly string[], now: Date = new Date()) {
  const map = new Map<string, { unitProductCost: Prisma.Decimal | null; currency: string }>()
  if (skus.length === 0) return map
  const rows = await prisma.costVersion.findMany({
    where: { tenantId, status: 'ACTIVE', sku: { in: [...skus] }, effectiveFrom: { lte: now } },
    orderBy: [{ versionNo: 'desc' }],
    select: { sku: true, unitProductCost: true, currency: true },
    take: 5000,
  })
  for (const row of rows) if (!map.has(row.sku)) map.set(row.sku, { unitProductCost: row.unitProductCost, currency: row.currency })
  return map
}

export function costDiffOf(unitCost: Prisma.Decimal | null, current: { unitProductCost: Prisma.Decimal | null; currency: string } | undefined, currency: string): CostDiffHint | null {
  if (!current || current.unitProductCost === null || unitCost === null) return null
  const comparable = current.currency === currency
  if (comparable && unitCost.equals(current.unitProductCost)) return null
  const ratio = comparable && !current.unitProductCost.isZero() ? unitCost.minus(current.unitProductCost).div(current.unitProductCost).toNumber() : null
  return { currentUnitCost: current.unitProductCost.toString(), currency: current.currency, ratio, comparable }
}

/** 头程运单明细里引用了这张采购单的运单；同一运单里多个 SKU 都来自这张采购单时数量相加。 */
export function firstMileLinks(items: ReadonlyArray<{ shipmentId: string; quantity: number; shipment: { waybillNo: string; forwarder: { name: string } } }>): PoFirstMileLink[] {
  const byShipment = new Map<string, PoFirstMileLink>()
  for (const item of items) {
    const found = byShipment.get(item.shipmentId)
    if (found) found.quantity += item.quantity
    else byShipment.set(item.shipmentId, { id: item.shipmentId, waybillNo: item.shipment.waybillNo, forwarderName: item.shipment.forwarder.name, quantity: item.quantity })
  }
  return [...byShipment.values()]
}
