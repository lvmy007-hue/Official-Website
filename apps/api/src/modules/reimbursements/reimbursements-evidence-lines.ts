import type { EvidenceLine, OpportunityEvidence } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'

// 证据包里“证据原始记录”的明细行（P2b-03）：按案件证据引用回读当时的原始记录（台账、货件、退货、移除订单、订单与退款），
// 写成可读的文字。只读我们已经保存的业务字段，不含买家姓名、地址、买家备注。

const IDS_LIMIT = 50
const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null)
const text = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? '尚无记录' : value.toString())
const idsOf = (evidence: readonly OpportunityEvidence[], kind: string) =>
  evidence
    .filter(item => item.kind === kind)
    .map(item => item.id)
    .slice(0, IDS_LIMIT)

export async function evidenceDetailLines(prisma: PrismaService, tenantId: string, evidence: readonly OpportunityEvidence[]): Promise<EvidenceLine[]> {
  const lines: EvidenceLine[] = []
  const ledgerIds = idsOf(evidence, 'LEDGER')
  const shipmentIds = idsOf(evidence, 'SHIPMENT')
  const returnIds = idsOf(evidence, 'RETURN')
  const removalIds = idsOf(evidence, 'REMOVAL')
  const orderIds = idsOf(evidence, 'ORDER')
  const [ledger, shipments, returns, removals, orders, refunds] = await Promise.all([
    ledgerIds.length
      ? prisma.inventoryLedgerEntry.findMany({
          where: { tenantId, id: { in: ledgerIds } },
          select: { eventDate: true, eventType: true, reasonCode: true, fnsku: true, sku: true, quantity: true, fulfillmentCenter: true, disposition: true, referenceId: true },
          take: IDS_LIMIT,
        })
      : [],
    shipmentIds.length
      ? prisma.fbaInboundShipment.findMany({
          where: { id: { in: shipmentIds }, plan: { tenantId } },
          select: {
            shipmentId: true,
            shipmentConfirmationId: true,
            destinationFc: true,
            unitsExpected: true,
            unitsReceived: true,
            discrepancyQuantity: true,
            receivedFirstAt: true,
            receivedDoneAt: true,
            carrier: true,
            trackingNumber: true,
          },
          take: IDS_LIMIT,
        })
      : [],
    returnIds.length
      ? prisma.fbaReturnCase.findMany({
          where: { tenantId, id: { in: returnIds } },
          select: {
            amazonOrderId: true,
            returnDate: true,
            sellerSku: true,
            fnsku: true,
            quantity: true,
            reason: true,
            detailedDisposition: true,
            disposition: true,
            fulfillmentCenterId: true,
            licensePlateNumber: true,
            reportStatus: true,
          },
          take: IDS_LIMIT,
        })
      : [],
    removalIds.length
      ? prisma.removalOrder.findMany({
          where: { tenantId, id: { in: removalIds } },
          select: {
            orderId: true,
            type: true,
            status: true,
            requestDate: true,
            lastUpdatedDate: true,
            sku: true,
            fnsku: true,
            disposition: true,
            requestedQty: true,
            shippedQty: true,
            disposedQty: true,
            cancelledQty: true,
            inProcessQty: true,
          },
          take: IDS_LIMIT,
        })
      : [],
    orderIds.length
      ? prisma.order.findMany({
          where: { tenantId, amazonOrderId: { in: orderIds } },
          select: { amazonOrderId: true, purchaseDate: true, status: true, currency: true, amount: true, shippedAt: true },
          take: IDS_LIMIT,
        })
      : [],
    orderIds.length
      ? prisma.fbaFinancialTransaction.findMany({
          where: { tenantId, amazonOrderId: { in: orderIds }, transactionType: { contains: 'refund', mode: 'insensitive' } },
          select: { amazonOrderId: true, postedAt: true, amount: true, currency: true, transactionType: true },
          orderBy: { postedAt: 'asc' },
          take: 200,
        })
      : [],
  ])
  for (const row of ledger)
    lines.push({
      section: '库存台账',
      item: `${day(row.eventDate)} ${row.eventType} / ${row.reasonCode || '无原因代码'}`,
      detail: `SKU ${row.sku || '尚无记录'}，FNSKU ${row.fnsku}，数量 ${row.quantity}，运营中心 ${row.fulfillmentCenter || '尚无记录'}，库存状态 ${row.disposition || '尚无记录'}，参考编号 ${row.referenceId ?? '尚无记录'}`,
      at: day(row.eventDate),
    })
  for (const row of shipments)
    lines.push({
      section: '入仓货件',
      item: `货件 ${row.shipmentId}（确认号 ${row.shipmentConfirmationId ?? '尚无记录'}）`,
      detail: [
        `目的运营中心 ${row.destinationFc ?? '尚无记录'}`,
        `应发 ${row.unitsExpected}，已收 ${row.unitsReceived}，差异 ${row.discrepancyQuantity}`,
        `承运商 ${row.carrier ?? '尚无记录'}，运单号 ${row.trackingNumber ?? '尚无记录'}`,
        `开始接收 ${day(row.receivedFirstAt) ?? '尚无记录'}，接收完成 ${day(row.receivedDoneAt) ?? '尚无记录'}`,
      ].join('，'),
      at: row.receivedDoneAt?.toISOString() ?? null,
    })
  for (const row of returns)
    lines.push({
      section: '客户退货',
      item: `订单 ${row.amazonOrderId} · SKU ${row.sellerSku}`,
      detail: `数量 ${row.quantity}，原因 ${row.reason ?? '尚无记录'}，处置 ${row.detailedDisposition ?? row.disposition ?? '尚无记录'}，运营中心 ${row.fulfillmentCenterId ?? '尚无记录'}，退货件编号 ${row.licensePlateNumber || '尚无记录'}，报告状态 ${row.reportStatus ?? '尚无记录'}`,
      at: row.returnDate.toISOString(),
    })
  for (const row of removals)
    lines.push({
      section: '移除订单',
      item: `移除订单 ${row.orderId} · SKU ${row.sku}`,
      detail: `类型 ${row.type}，状态 ${row.status || '尚无记录'}，申请 ${row.requestedQty}，已发出 ${row.shippedQty}，已弃置 ${row.disposedQty}，已取消 ${row.cancelledQty}，处理中 ${row.inProcessQty}，最近更新 ${day(row.lastUpdatedDate) ?? '尚无记录'}`,
      at: day(row.requestDate),
    })
  for (const row of orders)
    lines.push({
      section: '订单',
      item: `订单 ${row.amazonOrderId}`,
      detail: `状态 ${row.status}，订单金额 ${text(row.amount)} ${row.currency}，发货 ${day(row.shippedAt) ?? '尚无记录'}`,
      at: row.purchaseDate.toISOString(),
    })
  for (const row of refunds)
    lines.push({ section: '退款交易', item: `订单 ${row.amazonOrderId} · ${row.transactionType ?? '退款'}`, detail: `金额 ${row.amount.toString()} ${row.currency}`, at: row.postedAt.toISOString() })
  return lines
}
