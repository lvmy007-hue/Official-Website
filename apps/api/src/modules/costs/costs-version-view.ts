import { COST_SOURCE_LABEL, COST_STATUS_LABEL, planActivation, pricingOf, type CostLite, type CostSource, type CostVersionView } from '@nova/api-contracts'
import { closedMessage, closedPeriodOf, liteOf, statusOf, type ClosedPeriod, type CostRecord, type Db } from './costs-common'

// 版本时间线的一行（P2b-14）：把数据库行加上入库批次件数、来源单据号、操作人姓名、被谁替换，以及草稿“能不能生效、会替换谁”。

export interface VersionExtras {
  quantities: ReadonlyMap<string, number | null>
  docNos: ReadonlyMap<string, string>
  names: ReadonlyMap<string, string>
}

const IN_LIMIT = 500

/** 入库批次的件数：采购收货取该采购单这个 SKU 的已收数量，头程分摊取分摊件数；其余为 null（价格版本）。口径与 worker 的利润计价一致，没有行按 0。 */
export async function loadExtras(prisma: Db, tenantId: string, rows: readonly CostRecord[]): Promise<VersionExtras> {
  const quantities = new Map<string, number | null>()
  const docNos = new Map<string, string>()
  const poIds = [...new Set(rows.filter(row => row.source === 'PURCHASE_RECEIPT' && row.sourceDocId).map(row => row.sourceDocId as string))].slice(0, IN_LIMIT)
  const shipmentIds = [...new Set(rows.filter(row => row.source === 'FIRST_MILE_ALLOCATION' && row.sourceDocId).map(row => row.sourceDocId as string))].slice(0, IN_LIMIT)
  const fmVersionIds = rows.filter(row => row.source === 'FIRST_MILE_ALLOCATION').map(row => row.id)
  const [orders, lines, shipments, allocations] = await Promise.all([
    poIds.length ? prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: poIds } }, select: { id: true, number: true }, take: IN_LIMIT }) : [],
    poIds.length ? prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: { in: poIds } }, select: { purchaseOrderId: true, sellerSku: true, receivedQuantity: true }, take: 20_000 }) : [],
    shipmentIds.length ? prisma.firstMileShipment.findMany({ where: { tenantId, id: { in: shipmentIds } }, select: { id: true, waybillNo: true }, take: IN_LIMIT }) : [],
    fmVersionIds.length ? prisma.landedCostAllocation.findMany({ where: { tenantId, costVersionId: { in: fmVersionIds } }, select: { costVersionId: true, quantity: true }, take: 20_000 }) : [],
  ])
  for (const order of orders) docNos.set(order.id, order.number)
  for (const shipment of shipments) docNos.set(shipment.id, shipment.waybillNo)
  const received = new Map<string, number>()
  for (const line of lines) received.set(`${line.purchaseOrderId}|${line.sellerSku}`, (received.get(`${line.purchaseOrderId}|${line.sellerSku}`) ?? 0) + line.receivedQuantity)
  const allocated = new Map<string, number>()
  for (const row of allocations) if (row.costVersionId) allocated.set(row.costVersionId, (allocated.get(row.costVersionId) ?? 0) + row.quantity)
  for (const row of rows) {
    if (row.source === 'PURCHASE_RECEIPT' && row.sourceDocId) quantities.set(row.id, received.get(`${row.sourceDocId}|${row.sku}`) ?? 0)
    else if (row.source === 'FIRST_MILE_ALLOCATION') quantities.set(row.id, allocated.get(row.id) ?? 0)
    else quantities.set(row.id, null)
  }
  const userIds = [...new Set(rows.flatMap(row => [row.createdBy, row.activatedBy]).filter((id): id is string => Boolean(id)))].slice(0, IN_LIMIT)
  const members = userIds.length
    ? await prisma.membership.findMany({ where: { tenantId, userId: { in: userIds } }, select: { userId: true, user: { select: { displayName: true } } }, take: IN_LIMIT })
    : []
  return { quantities, docNos, names: new Map(members.map(member => [member.userId, member.user.displayName])) }
}

export const liteWith = (row: CostRecord, extras: VersionExtras): CostLite => liteOf(row, extras.quantities.get(row.id) ?? null)

/** 来源单据：采购单号、运单号；文件导入的来源是“批次:行号”原样显示；手工录入没有。 */
function docNoOf(row: CostRecord, extras: VersionExtras): string | null {
  if (!row.sourceDocId) return null
  if (row.source === 'FILE_IMPORT') return row.sourceDocId
  return extras.docNos.get(row.sourceDocId) ?? null
}

export function viewsOf(rows: readonly CostRecord[], extras: VersionExtras, closed: readonly ClosedPeriod[]): CostVersionView[] {
  const lites = rows.map(row => liteWith(row, extras))
  const { ignored } = pricingOf(lites)
  const numberOf = new Map(rows.map(row => [row.id, row.versionNo]))
  const actives = lites.filter(lite => lite.status === 'ACTIVE')
  return rows.map((row, index) => {
    const lite = lites[index] as CostLite
    const status = statusOf(row.status)
    const draft = status === 'DRAFT'
    const plan = draft ? planActivation(lite, actives) : null
    const period = draft ? closedPeriodOf(closed, lite.effectiveFrom) : null
    const userOwned = row.source === 'MANUAL' || row.source === 'FILE_IMPORT'
    return {
      id: row.id,
      version: row.version,
      versionNo: row.versionNo,
      status,
      statusLabel: COST_STATUS_LABEL[status],
      source: row.source as CostSource,
      sourceLabel: COST_SOURCE_LABEL[row.source as CostSource] ?? row.source,
      sourceDocId: row.sourceDocId,
      sourceDocNo: docNoOf(row, extras),
      effectiveFrom: lite.effectiveFrom,
      currency: row.currency,
      product: row.unitProductCost?.toString() ?? null,
      firstMile: row.unitFirstMileCost?.toString() ?? null,
      duty: row.unitDutyCost?.toString() ?? null,
      other: row.unitOtherCost?.toString() ?? null,
      quantity: extras.quantities.get(row.id) ?? null,
      note: row.note,
      createdByName: row.createdBy ? (extras.names.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      activatedByName: row.activatedBy ? (extras.names.get(row.activatedBy) ?? null) : null,
      activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
      replacedByVersionNo: row.replacedById ? (numberOf.get(row.replacedById) ?? null) : null,
      replacedAt: row.replacedAt ? row.replacedAt.toISOString() : null,
      ignoredComponents: ignored.get(row.id) ?? [],
      willReplace: plan && plan.ok ? plan.replaces.map(item => item.versionNo) : [],
      blockedReason: period ? closedMessage(lite.effectiveFrom, period) : plan && !plan.ok ? plan.reason : null,
      editable: draft ? (userOwned ? 'ALL' : 'LIMITED') : null,
      canDiscard: draft && userOwned,
    }
  })
}
