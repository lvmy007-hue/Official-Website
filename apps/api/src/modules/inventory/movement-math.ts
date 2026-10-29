import {
  costVersionAt,
  daysInRange,
  landedUnitCost,
  MV_FLOW_KEYS,
  movementFlowsOf,
  movementTurnoverOf,
  sellThroughOf,
  sumKnown,
  type CostPoint,
  type MvFlowKey,
  type MvRow,
  type MvTotals,
  type MvValues,
} from '@nova/api-contracts'
import type { LedgerSummaryBase } from './ledger-math'

// 进销存报表的纯函数（P6-25）：把库存台账“店铺 × FNSKU × 月”的行（已由 foldLedgerSummary 折好）合并成“SKU × 月”，再配成本版本算货值。
// 期初、变动、期末都是各行相加；一行只有在它下面的每一个台账行都平衡时才算平衡（不让正负差额互相抵消）。

const money = (value: number) => Math.round(value * 100) / 100
const zeroFlows = (): Record<MvFlowKey, number> => Object.fromEntries(MV_FLOW_KEYS.map(key => [key, 0])) as Record<MvFlowKey, number>

/** 该月用来算周转的天数：整月的日历天数，范围结束日落在当月时只算到结束日。 */
export function monthDays(month: string, to: string): number {
  const [year, mon] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10)
  const first = `${month}-01`
  return daysInRange(first, to >= first && to < last ? to : last)
}

export type MvBase = Omit<MvRow, 'values' | 'unitCost' | 'costVersionNo' | 'costEffectiveFrom' | 'valueNote'>

/** 参数 to 是查询范围的结束日：周转天数的天数取该月的日历天数，当月未过完时只算到范围结束日。 */
export function aggregateMovement(rows: readonly LedgerSummaryBase[], to: string): MvBase[] {
  const groups = new Map<string, LedgerSummaryBase[]>()
  for (const row of rows) {
    const sku = row.sku || row.fnsku
    groups.set(`${sku}|${row.month}`, [...(groups.get(`${sku}|${row.month}`) ?? []), row])
  }
  const result: MvBase[] = []
  for (const [id, group] of groups) {
    const sum = (pick: (row: LedgerSummaryBase) => number) => group.reduce((total, row) => total + pick(row), 0)
    const flows = movementFlowsOf({
      receipts: sum(row => row.receipts),
      customerShipments: sum(row => row.customerShipments),
      customerReturns: sum(row => row.customerReturns),
      vendorReturns: sum(row => row.vendorReturns),
      transfers: sum(row => row.transfers),
      found: sum(row => row.found),
      lost: sum(row => row.lost),
      damaged: sum(row => row.damaged),
      disposed: sum(row => row.disposed),
      other: sum(row => row.other),
      unknownEvents: sum(row => row.unknownEvents),
    })
    const openingQty = sum(row => row.startingQty)
    const endingQty = sum(row => row.endingQty)
    const expectedEnding = openingQty + MV_FLOW_KEYS.reduce((total, key) => total + flows[key], 0)
    const periodStart = group.reduce((min, row) => (row.periodStart < min ? row.periodStart : min), group[0]!.periodStart)
    const periodEnd = group.reduce((max, row) => (row.periodEnd > max ? row.periodEnd : max), group[0]!.periodEnd)
    const shippedUnits = Math.max(0, -flows.shipments)
    result.push({
      id,
      sku: group[0]!.sku || group[0]!.fnsku,
      asin: group.find(row => row.asin)?.asin ?? '',
      month: group[0]!.month,
      periodStart,
      periodEnd,
      storeCount: new Set(group.map(row => row.sellerAccountId)).size,
      openingQty,
      flows,
      endingQty,
      expectedEnding,
      difference: endingQty - expectedEnding,
      balanced: group.every(row => row.balanced) && endingQty === expectedEnding,
      shippedUnits,
      turnoverDays: movementTurnoverOf(endingQty, shippedUnits, monthDays(group[0]!.month, to)),
      sellThrough: sellThroughOf(endingQty, shippedUnits),
    })
  }
  return result
}

export type CostIndex = ReadonlyMap<string, readonly CostPoint[]>

export function indexCosts(points: readonly CostPoint[]): CostIndex {
  const index = new Map<string, CostPoint[]>()
  for (const point of points) index.set(point.sku, [...(index.get(point.sku) ?? []), point])
  return index
}

const NO_VALUE = { values: null, unitCost: null, costVersionNo: null, costEffectiveFrom: null }

/** 给一行配货值：单价取期末日生效的成本版本，整行用同一个单价；没有版本、币种不是美元、成本为空都不估算，写原因。 */
export function withValues(base: MvBase, costs: CostIndex | null): MvRow {
  if (costs === null) return { ...base, ...NO_VALUE, valueNote: null }
  const version = costVersionAt(costs.get(base.sku) ?? [], base.periodEnd)
  if (!version) return { ...base, ...NO_VALUE, valueNote: '该 SKU 在期末日没有生效的成本版本' }
  if (version.currency !== 'USD')
    return {
      ...base,
      ...NO_VALUE,
      costVersionNo: version.versionNo,
      costEffectiveFrom: version.effectiveFrom,
      valueNote: `成本版本 v${version.versionNo} 的币种是 ${version.currency}，尚未折算成美元`,
    }
  const unitCost = landedUnitCost(version)
  if (unitCost === null) return { ...base, ...NO_VALUE, costVersionNo: version.versionNo, costEffectiveFrom: version.effectiveFrom, valueNote: `成本版本 v${version.versionNo} 没有填写任何成本项` }
  const worth = (quantity: number) => money(quantity * unitCost)
  const values: MvValues = {
    opening: worth(base.openingQty),
    flows: Object.fromEntries(MV_FLOW_KEYS.map(key => [key, worth(base.flows[key])])) as Record<MvFlowKey, number>,
    ending: worth(base.endingQty),
    difference: worth(base.difference),
  }
  return { ...base, values, unitCost, costVersionNo: version.versionNo, costEffectiveFrom: version.effectiveFrom, valueNote: null }
}

export function totalsOf(rows: readonly MvRow[]): MvTotals {
  const flows = zeroFlows()
  for (const row of rows) for (const key of MV_FLOW_KEYS) flows[key] += row.flows[key]
  return {
    openingQty: rows.reduce((total, row) => total + row.openingQty, 0),
    flows,
    endingQty: rows.reduce((total, row) => total + row.endingQty, 0),
    difference: rows.reduce((total, row) => total + row.difference, 0),
    openingValue: sumKnown(rows.map(row => row.values?.opening ?? null)),
    endingValue: sumKnown(rows.map(row => row.values?.ending ?? null)),
  }
}

type SortField = 'month' | 'sku' | 'endingQty' | 'turnoverDays' | 'difference'

/** 排序：空值永远排最后；同值按月份、SKU 稳定排。 */
export function sortMovement(rows: readonly MvRow[], field: SortField, dir: 'asc' | 'desc'): MvRow[] {
  const sign = dir === 'asc' ? 1 : -1
  const tie = (a: MvRow, b: MvRow) => b.month.localeCompare(a.month) || a.sku.localeCompare(b.sku) || a.id.localeCompare(b.id)
  return [...rows].sort((a, b) => {
    if (field === 'month') return sign * a.month.localeCompare(b.month) || a.sku.localeCompare(b.sku)
    if (field === 'sku') return sign * a.sku.localeCompare(b.sku) || tie(a, b)
    const x = a[field]
    const y = b[field]
    if (x === null && y === null) return tie(a, b)
    if (x === null) return 1
    if (y === null) return -1
    return sign * (x - y) || tie(a, b)
  })
}
