import { orderStatusLabel, cancelledByLabel, type OrderIdentityResponse, type OrderTimelineItem } from '@nova/api-contracts'

const SOURCE_LABEL: Readonly<Record<string, string>> = { API: '订单接口同步', PUSH: '订单变更推送', REPORT: '报告导入' }

/** 配送承诺的计算依据：只用该订单包裹上记录的承运商与服务；没有包裹就明说，不去猜。 */
export function promiseBasis(packages: ReadonlyArray<{ carrier: string; shippingService: string | null }>): OrderIdentityResponse['overview']['basis'] {
  const carriers = [...new Set(packages.map(pack => pack.carrier).filter(Boolean))]
  const services = [...new Set(packages.flatMap(pack => (pack.shippingService ? [pack.shippingService] : [])))]
  if (packages.length === 0) return { carriers, services, note: '这个订单还没有包裹记录，承运商与服务待发货后（或物流报告同步后）显示' }
  return { carriers, services, note: '来自包裹记录上的承运商与配送服务；最晚发货与送达时间由亚马逊订单接口给出' }
}

type TimelineInput = {
  purchaseDate: Date
  history: ReadonlyArray<{ status: string; occurredAt: Date; source: string }>
  cancellation: { cancelledBy: string; reasonCode: string; requestedAt: Date | null; cancelledAt: Date | null } | null
  packages: ReadonlyArray<{ carrier: string; trackingNumber: string; shipDate: Date | null }>
}

/** 时间线：下单、每次状态变化、取消请求与取消、各包裹发货；按时间升序，同一时间下单排在最前。 */
export function buildTimeline(input: TimelineInput): OrderTimelineItem[] {
  const items: Array<OrderTimelineItem & { rank: number }> = [{ at: input.purchaseDate.toISOString(), kind: 'PURCHASE', title: '买家下单', source: '订单接口同步', rank: 0 }]
  for (const entry of input.history)
    items.push({ at: entry.occurredAt.toISOString(), kind: 'STATUS', title: `订单状态变为「${orderStatusLabel(entry.status)}」`, source: SOURCE_LABEL[entry.source] ?? entry.source, rank: 1 })
  const cancel = input.cancellation
  if (cancel?.requestedAt) items.push({ at: cancel.requestedAt.toISOString(), kind: 'CANCELLATION', title: `${cancelledByLabel(cancel.cancelledBy)}提出取消请求`, source: '订单接口同步', rank: 2 })
  if (cancel?.cancelledAt) items.push({ at: cancel.cancelledAt.toISOString(), kind: 'CANCELLATION', title: `订单已由${cancelledByLabel(cancel.cancelledBy)}取消`, source: '订单接口同步', rank: 2 })
  for (const pack of input.packages) {
    if (!pack.shipDate) continue
    const via = [pack.carrier, pack.trackingNumber].filter(Boolean).join(' ')
    items.push({ at: pack.shipDate.toISOString(), kind: 'PACKAGE', title: via ? `包裹发出（${via}）` : '包裹发出', source: '物流报告 / 订单接口', rank: 3 })
  }
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.rank - b.rank).map(({ rank: _rank, ...item }) => item)
}
