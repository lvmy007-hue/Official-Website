import { ledgerExpectedEnding, type LedgerFlows, type LedgerSummaryRow } from '@nova/api-contracts'

// 库存台账汇总（R-13）折成“店铺 × FNSKU × 月”的纯函数。
// 报告按日、库位、处置状态逐行给出期初、变动、期末：
//   月内变动 = 各行变动相加；
//   月初余额 = 每个（库位、处置状态）在本月最早一行的期初之和；月末余额 = 每个（库位、处置状态）在本月最后一行的期末之和。
// 同一个月里同时有不同汇总粒度的行（逐日与逐周混在一起）时只取最细的一档，避免变动被重复计算。

export interface LedgerSummaryInput extends LedgerFlows {
  sellerAccountId: string
  date: Date
  fnsku: string
  sku: string
  asin: string
  fulfillmentCenter: string
  disposition: string
  aggregation: string
}

export type LedgerSummaryBase = Omit<LedgerSummaryRow, 'storeName' | 'live'>

const GRANULARITY = ['DAILY', 'WEEKLY', 'MONTHLY']
const FLOW_KEYS = ['receipts', 'customerShipments', 'customerReturns', 'vendorReturns', 'transfers', 'found', 'lost', 'damaged', 'disposed', 'other', 'unknownEvents'] as const
const dayOf = (date: Date) => date.toISOString().slice(0, 10)

function finest(rows: LedgerSummaryInput[]): LedgerSummaryInput[] {
  const rank = (row: LedgerSummaryInput) => {
    const index = GRANULARITY.indexOf(row.aggregation)
    return index < 0 ? GRANULARITY.length : index
  }
  const best = Math.min(...rows.map(rank))
  return rows.filter(row => rank(row) === best)
}

export function foldLedgerSummary(rows: readonly LedgerSummaryInput[]): LedgerSummaryBase[] {
  const groups = new Map<string, LedgerSummaryInput[]>()
  for (const row of rows) {
    const key = `${row.sellerAccountId}|${row.fnsku}|${dayOf(row.date).slice(0, 7)}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const result: LedgerSummaryBase[] = []
  for (const [key, group] of groups) {
    const chosen = finest(group).sort((a, b) => a.date.getTime() - b.date.getTime())
    const edges = new Map<string, { first: LedgerSummaryInput; last: LedgerSummaryInput }>()
    for (const row of chosen) {
      const edgeKey = `${row.fulfillmentCenter}|${row.disposition}`
      const edge = edges.get(edgeKey)
      if (edge) edge.last = row
      else edges.set(edgeKey, { first: row, last: row })
    }
    const totals = Object.fromEntries(FLOW_KEYS.map(flow => [flow, chosen.reduce((sum, row) => sum + row[flow], 0)])) as Record<(typeof FLOW_KEYS)[number], number>
    const startingQty = [...edges.values()].reduce((sum, edge) => sum + edge.first.startingQty, 0)
    const endingQty = [...edges.values()].reduce((sum, edge) => sum + edge.last.endingQty, 0)
    const latest = chosen[chosen.length - 1]
    const named = [...chosen].reverse().find(row => row.sku) ?? latest
    const flows: LedgerFlows = { startingQty, endingQty, ...totals }
    const expectedEnding = ledgerExpectedEnding(flows)
    result.push({
      key,
      sellerAccountId: latest.sellerAccountId,
      fnsku: latest.fnsku,
      sku: named.sku,
      asin: [...chosen].reverse().find(row => row.asin)?.asin ?? '',
      month: dayOf(latest.date).slice(0, 7),
      periodStart: dayOf(chosen[0].date),
      periodEnd: dayOf(latest.date),
      ...flows,
      expectedEnding,
      difference: endingQty - expectedEnding,
      balanced: endingQty === expectedEnding,
    })
  }
  return result
}

/** 每个（店铺、FNSKU）最近一个月的行，用来挂库存接口比对。 */
export function latestMonthKeys(rows: readonly LedgerSummaryBase[]): Set<string> {
  const latest = new Map<string, LedgerSummaryBase>()
  for (const row of rows) {
    const id = `${row.sellerAccountId}|${row.fnsku}`
    const current = latest.get(id)
    if (!current || row.month > current.month) latest.set(id, row)
  }
  return new Set([...latest.values()].map(row => row.key))
}
