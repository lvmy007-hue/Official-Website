import { addAwCells, awTotalsOf, costVersionAt, emptyAwCells, landedUnitCost, sumKnown, type AwCells, type AwChild, type AwKind, type AwRow, type CostPoint } from '@nova/api-contracts'

// 跨仓总览的纯函数（P6-25）：把各来源的“仓 × SKU”数量按 SKU 聚合，保留每个仓的明细（展开用）。
// 同一个仓的同一个 SKU 只出现一次；已到仓与在途互斥由来源的选取保证（见 all-warehouses.service.ts），这里只负责相加与取价。

export interface Slot {
  sku: string
  kind: AwKind
  /** 仓或店铺的编号；头程在途用运单编号。同一个（kind, ownerId）同一个 SKU 合并成一个子行。 */
  ownerId: string
  label: string
  cells: Partial<AwCells>
}

export class Stacker {
  private readonly skus = new Map<string, { title: string | null; children: Map<string, AwChild> }>()

  add(slot: Slot) {
    const sku = this.skus.get(slot.sku) ?? { title: null, children: new Map<string, AwChild>() }
    const id = `${slot.kind}|${slot.ownerId}`
    const held = sku.children.get(id) ?? { id, kind: slot.kind, label: slot.label, cells: emptyAwCells(), total: null }
    held.cells = addAwCells(held.cells, slot.cells)
    sku.children.set(id, held)
    this.skus.set(slot.sku, sku)
  }

  title(sku: string, title: string) {
    const held = this.skus.get(sku)
    if (held && !held.title) held.title = title
  }

  /** 每个 SKU 一行；没有任何数量的 SKU 不出行。 */
  rows(): Array<Omit<AwRow, 'unitCost' | 'stockValue'>> {
    const result: Array<Omit<AwRow, 'unitCost' | 'stockValue'>> = []
    for (const [sku, entry] of this.skus) {
      const children = [...entry.children.values()].map(child => ({ ...child, total: awTotalsOf(child.cells).total }))
      const cells = children.reduce((sum, child) => addAwCells(sum, child.cells), emptyAwCells())
      const totals = awTotalsOf(cells)
      if (totals.total === null && Object.values(cells).every(value => value === null)) continue
      result.push({ id: sku, sku, title: entry.title, cells, ...totals, children: children.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)) })
    }
    return result
  }
}

/** 给行配货值：单价取今天生效的成本版本（美元），货值 = 合计数量 × 单价（含在途）；没有版本、币种不是美元、成本为空都是 null，不估算。 */
export function priced(rows: ReadonlyArray<Omit<AwRow, 'unitCost' | 'stockValue'>>, versions: ReadonlyMap<string, readonly CostPoint[]> | null, today: string): AwRow[] {
  return rows.map(row => {
    const version = versions ? costVersionAt(versions.get(row.sku) ?? [], today) : null
    const unitCost = version && version.currency === 'USD' ? landedUnitCost(version) : null
    return { ...row, unitCost, stockValue: unitCost !== null && row.total !== null ? Math.round(row.total * unitCost * 100) / 100 : null }
  })
}

export function summaryOf(rows: readonly AwRow[]) {
  const cells = rows.reduce((sum, row) => addAwCells(sum, row.cells), emptyAwCells())
  return { cells, ...awTotalsOf(cells), stockValue: sumKnown(rows.map(row => row.stockValue)) }
}

type SortField = 'sku' | 'total' | 'onHand' | 'inTransit'

/** 排序：空值永远排最后；同值按 SKU 稳定排。 */
export function sortRows(rows: readonly AwRow[], field: SortField, dir: 'asc' | 'desc'): AwRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (field === 'sku') return sign * a.sku.localeCompare(b.sku)
    const x = a[field]
    const y = b[field]
    if (x === null && y === null) return a.sku.localeCompare(b.sku)
    if (x === null) return 1
    if (y === null) return -1
    return sign * (x - y) || a.sku.localeCompare(b.sku)
  })
}
