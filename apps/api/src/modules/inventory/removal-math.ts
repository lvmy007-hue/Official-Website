import { removalReceiptState, removalStatusLabel, REMOVAL_TYPES, type RemovalReconRow, type RemovalTimelineItem, type RemovalType } from '@nova/api-contracts'

// 移除订单的纯计算：详情编号、类型归一、退回件收货核对、时间线。

/** 详情编号：`<店铺编号>:<移除订单号>`（移除订单号是卖家自己起的，不同店铺可能重名，所以带上店铺）。 */
export const removalId = (sellerAccountId: string, orderId: string) => `${sellerAccountId}:${orderId}`

export function parseRemovalId(id: string): { sellerAccountId: string; orderId: string } | null {
  const index = id.indexOf(':')
  if (index <= 0 || index === id.length - 1) return null
  return { sellerAccountId: id.slice(0, index), orderId: id.slice(index + 1) }
}

export const removalTypeOf = (value: string | null | undefined): RemovalType => ((REMOVAL_TYPES as readonly string[]).includes(value ?? '') ? (value as RemovalType) : 'OTHER')

export interface ReceiptTotals {
  sku: string
  receivedQty: number
  sellableQty: number
  damagedQty: number
}

/** 逐 SKU 核对：应收 = 订单上该 SKU 的已发货数量合计；实收 = 该 SKU 全部登记合计；没有任何登记时实收为 null。 */
export function reconcile(type: string, lines: ReadonlyArray<{ sku: string; shippedQty: number }>, receipts: ReadonlyArray<ReceiptTotals>): RemovalReconRow[] {
  const expected = new Map<string, number>()
  for (const line of lines) expected.set(line.sku, (expected.get(line.sku) ?? 0) + line.shippedQty)
  const received = new Map<string, ReceiptTotals>()
  for (const receipt of receipts) {
    const current = received.get(receipt.sku)
    received.set(receipt.sku, {
      sku: receipt.sku,
      receivedQty: (current?.receivedQty ?? 0) + receipt.receivedQty,
      sellableQty: (current?.sellableQty ?? 0) + receipt.sellableQty,
      damagedQty: (current?.damagedQty ?? 0) + receipt.damagedQty,
    })
  }
  return [...expected.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sku, expectedQty]) => {
      const got = received.get(sku) ?? null
      return {
        sku,
        expectedQty,
        receivedQty: got ? got.receivedQty : null,
        sellableQty: got ? got.sellableQty : null,
        damagedQty: got ? got.damagedQty : null,
        difference: got ? got.receivedQty - expectedQty : null,
        state: removalReceiptState(type, expectedQty, got ? got.receivedQty : null),
      }
    })
}

export interface TimelineInput {
  requestDate: string
  requestedQty: number
  typeLabel: string
  status: string
  lastUpdatedDate: string | null
  shipments: ReadonlyArray<{ shipDate: string | null; shippedQty: number; carrier: string | null; trackingNumber: string | null; sku: string }>
  receipts: ReadonlyArray<{ receivedAt: string; sku: string; receivedQty: number }>
}

/** 时间线只列有日期的事实：提交、发货、登记收货、最近一次状态更新；没有日期的信息（如已取消数量）在明细表里看。 */
export function buildTimeline(input: TimelineInput): RemovalTimelineItem[] {
  const items: RemovalTimelineItem[] = [{ at: input.requestDate, title: '提交移除订单', detail: `${input.typeLabel}，请求 ${input.requestedQty} 件` }]
  for (const shipment of input.shipments) {
    if (!shipment.shipDate) continue
    const carrier = [shipment.carrier, shipment.trackingNumber].filter(Boolean).join(' ')
    items.push({ at: shipment.shipDate, title: `已发货 ${shipment.shippedQty} 件`, detail: [shipment.sku, carrier].filter(Boolean).join('；') || null })
  }
  for (const receipt of input.receipts) items.push({ at: receipt.receivedAt, title: `登记收货 ${receipt.receivedQty} 件`, detail: receipt.sku })
  if (input.lastUpdatedDate) items.push({ at: input.lastUpdatedDate, title: `亚马逊最近一次更新：${removalStatusLabel(input.status)}`, detail: null })
  return items.sort((a, b) => a.at.localeCompare(b.at))
}
