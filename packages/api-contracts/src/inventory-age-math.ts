import { AGE_BUCKETS_COARSE, AGE_BUCKETS_FINE, type AgeBucketDef } from './inventory.js'
import type { AgeCrossing } from './inventory-detail.js'
import { isoDaysBetween, isoPlusDays } from './inventory-assess.js'

// 库龄分段与跨档时间线（06 章 6.1 库存详情第 7 页签）。纯函数；库存详情与预警评估（P2a-15）共用。
// 报告只给“每个库龄分段里有多少件”，不给每件的具体库龄：因此跨档日期只能给出窗口——
// 分段 [from, to] 里的库存，最早 (B − to) 天、最晚 (B − from) 天后到达下一档起点 B；这里的天数从快照日期起算。

export interface InventoryAgeColumns {
  age0to90: number | null
  age91to180: number | null
  age181to270: number | null
  age271to365: number | null
  age365plus: number | null
  age0to30: number | null
  age31to60: number | null
  age61to90: number | null
  age366to455: number | null
  age456plus: number | null
}

export interface InventoryAgeFeeColumns {
  aisEst181To210: number | null
  aisEst211To240: number | null
  aisEst241To270: number | null
  aisEst271To300: number | null
  aisEst301To330: number | null
  aisEst331To365: number | null
  aisEst365Plus: number | null
}

const FINE_KEYS = ['age0to30', 'age31to60', 'age61to90', 'age366to455', 'age456plus'] as const
const COARSE_KEYS = ['age0to90', 'age91to180', 'age181to270', 'age271to365', 'age365plus'] as const

export interface InventoryAgeView {
  granularity: 'FINE' | 'COARSE' | null
  defs: readonly AgeBucketDef[]
  buckets: Array<{ key: string; label: string; qty: number | null }>
}

/** 细分段（8 段）齐全时用 8 段，否则退化为 5 段；5 段也全空则没有库龄数据。 */
export function inventoryAgeView(age: InventoryAgeColumns | null): InventoryAgeView {
  if (!age) return { granularity: null, defs: [], buckets: [] }
  const fine = FINE_KEYS.every(key => age[key] !== null)
  const coarse = COARSE_KEYS.some(key => age[key] !== null)
  const defs = fine ? AGE_BUCKETS_FINE : AGE_BUCKETS_COARSE
  if (!fine && !coarse) return { granularity: null, defs: [], buckets: [] }
  return { granularity: fine ? 'FINE' : 'COARSE', defs, buckets: defs.map(def => ({ key: def.key, label: def.label, qty: (age as unknown as Record<string, number | null>)[def.key] ?? null })) }
}

const sum = (values: Array<number | null>): number | null => (values.every(value => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0))

export function inventoryAgeFeeBands(fees: InventoryAgeFeeColumns | null): Array<{ label: string; amount: number | null }> {
  if (!fees) return []
  return [
    { label: '181-210 天', amount: fees.aisEst181To210 },
    { label: '211-240 天', amount: fees.aisEst211To240 },
    { label: '241-270 天', amount: fees.aisEst241To270 },
    { label: '271-300 天', amount: fees.aisEst271To300 },
    { label: '301-330 天', amount: fees.aisEst301To330 },
    { label: '331-365 天', amount: fees.aisEst331To365 },
    { label: '365 天以上', amount: fees.aisEst365Plus },
  ]
}

// 收取库龄附加费的三个档：进入档起点 → 本档数量所在的分段键 → 本档预估费用的列
const FEE_TIERS: Record<number, { qtyKey: 'age181to270' | 'age271to365' | 'age365plus'; fee: (fees: InventoryAgeFeeColumns) => number | null }> = {
  181: { qtyKey: 'age181to270', fee: fees => sum([fees.aisEst181To210, fees.aisEst211To240, fees.aisEst241To270]) },
  271: { qtyKey: 'age271to365', fee: fees => sum([fees.aisEst271To300, fees.aisEst301To330, fees.aisEst331To365]) },
  366: { qtyKey: 'age365plus', fee: fees => fees.aisEst365Plus },
}
const BOUNDARIES = [91, 181, 271, 366, 456]
const NO_REFERENCE_NOTE = '该 SKU 目前没有处于该档的库存，无法用自身数据推算单价（分档单价随体积与季节调整，系统不内置）'

export function inventoryAgeCrossings(age: InventoryAgeColumns | null, fees: InventoryAgeFeeColumns | null, snapshotDate: string, today: string): AgeCrossing[] {
  const view = inventoryAgeView(age)
  if (!age || view.granularity === null) return []
  const result: AgeCrossing[] = []
  for (const boundary of BOUNDARIES) {
    const lower = view.defs.find(def => def.to === boundary - 1)
    const upper = view.defs.find(def => def.from === boundary) ?? (boundary === 366 ? AGE_BUCKETS_COARSE[4] : undefined)
    if (!lower || !upper) continue
    const qty = view.buckets.find(bucket => bucket.key === lower.key)?.qty ?? 0
    if (qty <= 0) continue
    const earliest = isoPlusDays(snapshotDate, 1)
    const latest = isoPlusDays(snapshotDate, boundary - lower.from)
    const tier = FEE_TIERS[boundary]
    let estimatedIncrease: number | null = null
    let note: string | null = null
    if (tier) {
      const targetQty = age[tier.qtyKey]
      const targetFee = fees ? tier.fee(fees) : null
      if (targetQty !== null && targetQty > 0 && targetFee !== null) estimatedIncrease = Math.round(qty * (targetFee / targetQty) * 100) / 100
      else note = fees ? NO_REFERENCE_NOTE : '尚无库存规划报告里的库龄附加费预估'
    } else note = '该档不收取库龄附加费'
    result.push({
      boundaryDays: boundary,
      toLabel: upper.label,
      qty,
      earliestDate: earliest,
      latestDate: latest,
      likelyCrossed: isoDaysBetween(latest, today) > 0,
      feeTier: Boolean(tier),
      estimatedIncrease,
      note,
    })
  }
  return result
}
