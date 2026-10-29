import type { AwdOrderDetail } from '@nova/api-contracts'
import type { AwdInboundOrder, AwdInboundShipment } from '@prisma/client'

// 订单时间线：只用真实发生过的记录——我方的操作审计、亚马逊给出的创建与更新时间、货件的创建时间。没有的不编造。

const ACTION_TITLE: Record<string, string> = {
  AWD_ORDER_CREATED: '创建入库订单',
  AWD_ORDER_UPDATED: '修改入库订单',
  AWD_ORDER_CONFIRMED: '确认入库订单',
  AWD_ORDER_CANCELLED: '取消入库订单',
  AWD_ORDER_TRANSPORT_UPDATED: '更新运输信息',
  REPLENISHMENT_AWD_DRAFT_RECORDED: '由补货建议生成草稿',
}

export interface TimelineEvent {
  action: string
  result: string
  createdAt: Date
  reason: string | null
}

export function orderTimeline(order: AwdInboundOrder, shipments: readonly AwdInboundShipment[], events: readonly TimelineEvent[]): AwdOrderDetail['timeline'] {
  const entries: Array<{ at: Date; title: string; detail: string | null }> = []
  for (const event of events) {
    const title = ACTION_TITLE[event.action]
    if (!title) continue
    entries.push({ at: event.createdAt, title: event.result === 'SUCCEEDED' ? title : `${title}（未成功）`, detail: event.reason })
  }
  if (order.amazonCreatedAt) entries.push({ at: order.amazonCreatedAt, title: '亚马逊创建订单', detail: order.orderId })
  for (const shipment of shipments) {
    if (shipment.amazonCreatedAt) entries.push({ at: shipment.amazonCreatedAt, title: '亚马逊生成入库货件', detail: shipment.shipmentId })
  }
  if (order.amazonUpdatedAt) entries.push({ at: order.amazonUpdatedAt, title: '亚马逊最近更新', detail: null })
  if (order.lastErrorMessage) entries.push({ at: order.updatedAt, title: '最近一次提交失败', detail: order.lastErrorMessage })
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime()).map(entry => ({ at: entry.at.toISOString(), title: entry.title, detail: entry.detail }))
}
