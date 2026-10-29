import { daysBetween } from './procurement-common'

// 国内仓库存的汇总与计价（纯函数，口径见契约 warehouse.ts 开头）。
// 一条流水一个方向：数量为正是入库，为负是出库；出库一律先进先出地冲减最早的入库批次（库龄与“有没有缺成本的库存”据此判断）。
// 计价：先进先出 = 剩余批次按各自成本；移动加权平均 = 在库数量 × 按时间顺序滚动出来的平均成本。
// 货值无法可靠算出时（缺入库成本、币种不一致、库存为负）返回 null 并写明原因，不用 0 顶替。

export interface StockMovement {
  occurredAt: Date
  quantity: number
  lockedForShipment: number
  unitCost: number | null
  currency: string | null
}

export interface StockSummary {
  onHand: number
  locked: number
  available: number
  ageDays: number | null
  value: number | null
  currency: string | null
  valueNote: string | null
  /** 当前每件的成本（货值 / 在库），用于给盘点盘盈的入库记成本；算不出为 null。 */
  unitCost: number | null
}

type Layer = { qty: number; cost: number | null; at: Date }

const round6 = (value: number) => Math.round(value * 1e6) / 1e6

export function summarizeStock(movements: readonly StockMovement[], method: 'WEIGHTED_AVERAGE' | 'FIFO', now: Date = new Date()): StockSummary {
  const ordered = [...movements].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  const layers: Layer[] = []
  let locked = 0
  let qty = 0
  let avg: number | null = null
  const currencies = new Set<string>()

  for (const move of ordered) {
    locked += move.lockedForShipment
    if (move.quantity > 0) {
      layers.push({ qty: move.quantity, cost: move.unitCost, at: move.occurredAt })
      if (move.unitCost !== null) {
        if (move.currency) currencies.add(move.currency)
        avg = qty > 0 && avg !== null ? (qty * avg + move.quantity * move.unitCost) / (qty + move.quantity) : move.unitCost
      }
    } else if (move.quantity < 0) {
      let remaining = -move.quantity
      while (remaining > 0 && layers.length > 0) {
        const head = layers[0]
        const used = Math.min(head.qty, remaining)
        head.qty -= used
        remaining -= used
        if (head.qty === 0) layers.shift()
      }
    }
    qty += move.quantity
  }

  const onHand = qty
  const base = { onHand, locked, available: onHand - locked, ageDays: layers.length > 0 ? Math.max(0, daysBetween(layers[0].at, now)) : null }
  const empty = { ...base, value: null, currency: null, unitCost: null }
  if (onHand < 0) return { ...empty, valueNote: '在库数量为负，请先盘点调整后再看货值' }
  if (onHand === 0) return { ...base, value: 0, currency: null, valueNote: null, unitCost: null }
  if (layers.some(layer => layer.cost === null)) return { ...empty, valueNote: '部分库存没有入库成本，货值暂不计算' }
  if (currencies.size > 1) return { ...empty, valueNote: '入库币种不一致，货值暂不计算' }
  const currency = [...currencies][0] ?? null
  // 先进先出的剩余批次合计；移动加权用滚动平均乘在库数量
  const fifoValue = layers.reduce((sum, layer) => sum + layer.qty * (layer.cost as number), 0)
  const value = round6(method === 'FIFO' || avg === null ? fifoValue : onHand * avg)
  return { ...base, value, currency, valueNote: null, unitCost: round6(value / onHand) }
}
