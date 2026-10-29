import type { OrderDigest } from '../importers/orders/v2026-types'
import { AMOUNT_EPSILON, money, nearEdge, type ParityDiff, type ParityReport, type ParityWindow } from './types'

// 订单核对：旧接口（v0 订单列表）与新接口（v2026-01-01）在同一时间窗内的订单逐单比对：是否都有、状态、总额。
// 旧接口只调了订单头，没有逐行；行级金额由新接口独有的明细表承载，不在核对范围内。

export type LegacyOrder = { amazonOrderId: string; purchaseDate: Date; lastUpdate?: Date; status: string; amount?: number }

export type CompareOrdersInput = {
  legacy: LegacyOrder[]
  next: OrderDigest[]
  window: ParityWindow
}

export function compareOrders(input: CompareOrdersInput): ParityReport {
  const { window } = input
  const legacy = new Map(input.legacy.map(order => [order.amazonOrderId, order]))
  const next = new Map(input.next.map(order => [order.amazonOrderId, order]))
  const diffs: ParityDiff[] = []
  let matched = 0

  for (const [id, old] of legacy) {
    const now = next.get(id)
    if (!now) {
      diffs.push(
        nearEdge(old.purchaseDate, window)
          ? { category: 'TIME_BASIS', entityKey: id, field: 'presence', legacyValue: '有', newValue: '无', explanation: '下单时间落在时间窗边界，两个接口的截止时刻相差几分钟导致只有一边包含' }
          : { category: 'UNEXPLAINED', entityKey: id, field: 'presence', legacyValue: '有', newValue: '无', explanation: '旧接口返回了该订单，新接口在同一时间窗内没有返回，且不在窗口边界' },
      )
      continue
    }
    const before = diffs.length
    const oldUpdated = old.lastUpdate ?? old.purchaseDate
    const updatedLater = now.lastUpdated.getTime() > oldUpdated.getTime()
    if (old.status !== now.status) {
      diffs.push(
        updatedLater
          ? { category: 'TIME_BASIS', entityKey: id, field: 'status', legacyValue: old.status, newValue: now.status, explanation: '新接口取到的订单更新时间晚于旧接口，两次拉取之间订单状态已变化' }
          : { category: 'UNEXPLAINED', entityKey: id, field: 'status', legacyValue: old.status, newValue: now.status, explanation: '订单状态不一致，且新接口的更新时间并不更晚' },
      )
    }
    if (old.amount === undefined && now.amount !== undefined && old.status === 'Pending') {
      diffs.push({ category: 'SCOPE', entityKey: id, field: 'amount', legacyValue: '无', newValue: money(now.amount), explanation: '待付款订单旧接口不返回订单总额，新接口返回了合计金额' })
    } else if (old.amount !== undefined && now.amount !== undefined && Math.abs(old.amount - now.amount) >= AMOUNT_EPSILON) {
      const gap = Math.abs(old.amount - now.amount)
      if (now.taxAmount > 0 && Math.abs(gap - now.taxAmount) < AMOUNT_EPSILON)
        diffs.push({
          category: 'ATTRIBUTION_BASIS',
          entityKey: id,
          field: 'amount',
          legacyValue: money(old.amount),
          newValue: money(now.amount),
          explanation: `两个总额相差正好等于税额 ${money(now.taxAmount)}：新旧接口对税是否计入订单总额的归属不同`,
        })
      else if (updatedLater)
        diffs.push({
          category: 'TIME_BASIS',
          entityKey: id,
          field: 'amount',
          legacyValue: money(old.amount),
          newValue: money(now.amount),
          explanation: '新接口取到的订单更新时间晚于旧接口，两次拉取之间订单金额已变化',
        })
      else
        diffs.push({
          category: 'UNEXPLAINED',
          entityKey: id,
          field: 'amount',
          legacyValue: money(old.amount),
          newValue: money(now.amount),
          explanation: '订单总额不一致，差额不等于税额，且新接口的更新时间并不更晚',
        })
    } else if ((old.amount === undefined) !== (now.amount === undefined)) {
      diffs.push({
        category: 'UNEXPLAINED',
        entityKey: id,
        field: 'amount',
        legacyValue: old.amount === undefined ? '无' : money(old.amount),
        newValue: now.amount === undefined ? '无' : money(now.amount),
        explanation: '只有一边有订单总额',
      })
    }
    if (diffs.length === before) matched += 1
  }

  for (const [id, now] of next) {
    if (legacy.has(id)) continue
    if (now.status === 'InvoiceUnconfirmed')
      diffs.push({
        category: 'SCOPE',
        entityKey: id,
        field: 'presence',
        legacyValue: '无',
        newValue: '有',
        explanation: '该订单处于“发票待确认”状态：旧接口调用时的状态筛选不包含这个状态，新接口返回全部状态',
      })
    else if (nearEdge(now.purchaseDate, window))
      diffs.push({ category: 'TIME_BASIS', entityKey: id, field: 'presence', legacyValue: '无', newValue: '有', explanation: '下单时间落在时间窗边界，两个接口的截止时刻相差几分钟导致只有一边包含' })
    else diffs.push({ category: 'UNEXPLAINED', entityKey: id, field: 'presence', legacyValue: '无', newValue: '有', explanation: '新接口返回了该订单，旧接口在同一时间窗内没有返回，且不在窗口边界' })
  }
  return { legacyCount: legacy.size, newCount: next.size, matchedCount: matched, diffs }
}
