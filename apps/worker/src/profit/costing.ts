import type { InventoryCosting } from '@nova/api-contracts'

// 存货计价（P2b-09）：给定一个 SKU 的成本批次与逐日卖出件数，算出每天卖出的件数各按什么单价计成本。纯函数，不碰数据库、不折算汇率。
//
// 批次（CostLayer）：quantity 有值是“入库批次”（采购收货生成的成本版本取收货数量，头程分摊取分摊的件数），按数量参与计价；
// quantity 为空是“价格版本”（手工或文件导入的成本版本没有数量），它只说明某天起单价是多少。
// 一条成本流里只要有入库批次，就只用入库批次计价（价格版本忽略）；否则按价格版本：当天适用的是生效日不晚于当天的最新一条。
// 入库当天的批次可以供当天的销售使用；卖出件数超过已入库的数量，超出的部分没有成本（uncovered），不拿别的单价顶替。

export interface CostLayer {
  /** 生效或入库日期，YYYY-MM-DD。 */
  date: string
  unitCost: number
  currency: string
  quantity: number | null
}
export interface CostPiece {
  qty: number
  unitCost: number
  currency: string
}
export interface DayCost {
  pieces: CostPiece[]
  /** 这一天没有成本可用的件数。 */
  uncovered: number
  /** 没有成本的原因是入库批次已经用完（不是“压根没有批次”）。 */
  exhausted: boolean
  /** 加权平均的暂估：月末加权平均且还没过完这个月。 */
  provisional: boolean
  /** 加权平均时有别的币种的批次没有计入。 */
  mixedCurrency: boolean
}

const byDate = (a: CostLayer, b: CostLayer) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
const nextMonth = (month: string) => {
  const [year, mm] = month.split('-').map(Number) as [number, number]
  return mm === 12 ? `${year + 1}-01` : `${year}-${String(mm + 1).padStart(2, '0')}`
}
const blank = (): DayCost => ({ pieces: [], uncovered: 0, exhausted: false, provisional: false, mixedCurrency: false })

function priceStream(layers: CostLayer[], days: string[], sales: ReadonlyMap<string, number>): Map<string, DayCost> {
  const sorted = [...layers].sort(byDate)
  const out = new Map<string, DayCost>()
  for (const day of days) {
    const units = sales.get(day) ?? 0
    const cost = blank()
    let hit: CostLayer | undefined
    for (const layer of sorted) if (layer.date <= day) hit = layer
    if (hit) cost.pieces.push({ qty: units, unitCost: hit.unitCost, currency: hit.currency })
    else cost.uncovered = units
    out.set(day, cost)
  }
  return out
}

function fifo(layers: CostLayer[], days: string[], sales: ReadonlyMap<string, number>): Map<string, DayCost> {
  const out = new Map<string, DayCost>()
  const queue: Array<{ remaining: number; layer: CostLayer }> = []
  let next = 0
  for (const day of days) {
    while (next < layers.length && layers[next]!.date <= day) {
      queue.push({ remaining: layers[next]!.quantity as number, layer: layers[next]! })
      next += 1
    }
    let need = sales.get(day) ?? 0
    const cost = blank()
    while (need > 0 && queue.length > 0) {
      const head = queue[0]!
      const take = Math.min(head.remaining, need)
      cost.pieces.push({ qty: take, unitCost: head.layer.unitCost, currency: head.layer.currency })
      head.remaining -= take
      need -= take
      if (head.remaining <= 0) queue.shift()
    }
    cost.uncovered = need
    cost.exhausted = need > 0 && next > 0
    out.set(day, cost)
  }
  return out
}

function movingAverage(layers: CostLayer[], days: string[], sales: ReadonlyMap<string, number>): Map<string, DayCost> {
  const out = new Map<string, DayCost>()
  const currency = layers[0]!.currency
  let onHand = 0
  let value = 0
  let next = 0
  let received = false
  let mixed = false
  for (const day of days) {
    while (next < layers.length && layers[next]!.date <= day) {
      const layer = layers[next]!
      next += 1
      if (layer.currency !== currency) {
        mixed = true
        continue
      }
      onHand += layer.quantity as number
      value += (layer.quantity as number) * layer.unitCost
      received = true
    }
    const need = sales.get(day) ?? 0
    const average = onHand > 0 ? value / onHand : 0
    const take = Math.min(onHand, need)
    const cost = blank()
    if (take > 0) cost.pieces.push({ qty: take, unitCost: average, currency })
    onHand -= take
    value -= take * average
    cost.uncovered = need - take
    cost.exhausted = cost.uncovered > 0 && received
    cost.mixedCurrency = mixed
    out.set(day, cost)
  }
  return out
}

function monthAverage(layers: CostLayer[], days: string[], sales: ReadonlyMap<string, number>, today: string): Map<string, DayCost> {
  const out = new Map<string, DayCost>()
  const currency = layers[0]!.currency
  const firstMonth = [layers[0]!.date, days[0]!].sort()[0]!.slice(0, 7)
  const lastMonth = days[days.length - 1]!.slice(0, 7)
  let onHand = 0
  let value = 0
  let mixed = false
  for (let month = firstMonth; month <= lastMonth; month = nextMonth(month)) {
    let monthQty = onHand
    let monthValue = value
    for (const layer of layers) {
      if (layer.date.slice(0, 7) !== month) continue
      if (layer.currency !== currency) {
        mixed = true
        continue
      }
      monthQty += layer.quantity as number
      monthValue += (layer.quantity as number) * layer.unitCost
    }
    const average = monthQty > 0 ? monthValue / monthQty : 0
    let available = monthQty
    let sold = 0
    for (const day of days.filter(item => item.slice(0, 7) === month)) {
      const need = sales.get(day) ?? 0
      const take = Math.min(available, need)
      const cost = blank()
      if (take > 0) cost.pieces.push({ qty: take, unitCost: average, currency })
      available -= take
      sold += take
      cost.uncovered = need - take
      cost.exhausted = cost.uncovered > 0 && monthQty > 0
      cost.provisional = month === today.slice(0, 7)
      cost.mixedCurrency = mixed
      out.set(day, cost)
    }
    onHand = monthQty - sold
    value = monthValue - sold * average
  }
  return out
}

/**
 * 逐日成本：sales 是该 SKU 逐日卖出件数（从第一批入库之前就开始给，才能让先进先出等方法接上历史）。
 * 返回的 Map 里每个有销售的日子都有一项。today（YYYY-MM-DD）用来判断月末加权平均是否还在“暂估”的当月。
 */
export function consumeStream(method: InventoryCosting, layers: readonly CostLayer[], sales: ReadonlyMap<string, number>, today: string): Map<string, DayCost> {
  const days = [...sales.entries()]
    .filter(([, units]) => units > 0)
    .map(([day]) => day)
    .sort()
  if (days.length === 0) return new Map()
  const quantified = layers.filter(layer => layer.quantity !== null && layer.quantity > 0).sort(byDate)
  if (quantified.length === 0)
    return priceStream(
      layers.filter(layer => layer.quantity === null),
      days,
      sales,
    )
  if (method === 'FIFO') return fifo(quantified, days, sales)
  if (method === 'MOVING_AVG') return movingAverage(quantified, days, sales)
  return monthAverage(quantified, days, sales, today)
}
