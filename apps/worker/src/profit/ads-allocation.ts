import type { AllocationBasis } from '@nova/api-contracts'

// 广告花费分摊到商品（P3-16，07 章 7.9）：一个店铺一天的广告账户总花费，先按“广告商品报表”归属到被推广的 ASIN，
// 剩余的部分再按销售额（默认）或销量分摊到当天有销售的 SKU。纯函数，不碰数据库；金额用整数微元（1e-6 美元）计算，
// 用最大余数法取整，保证“各 SKU 分摊额之和 + 未分摊额 = 账户总花费”恰好相等（验收条件）。

export interface AllocationRow {
  sku: string
  asin: string | null
  revenue: number
  units: number
}

export interface AllocationInput {
  /** 该店铺当天的账户总花费（美元，不小于 0）。 */
  total: number
  basis: AllocationBasis
  /** 广告商品报表里各被推广 ASIN 的花费合计（美元）。 */
  direct: ReadonlyMap<string, number>
  /** 该店铺当天有销售的 SKU 行（不含店铺级行）。 */
  rows: readonly AllocationRow[]
  /** 店铺的 ASIN → SKU 对照（商品目录）：当天没有该 ASIN 的销售行时，用它找到归属的 SKU。 */
  asinSkus: ReadonlyMap<string, readonly string[]>
}

export interface AllocationResult {
  /** SKU → 分摊到的花费（美元，6 位小数）；包含只因广告报表归属而新出现的 SKU。 */
  bySku: Map<string, number>
  /** 新出现的 SKU（当天没有销售行）对应的 ASIN。 */
  addedAsins: Map<string, string>
  /** 没有分摊出去的花费（当天没有可分摊的销售等）。 */
  unallocated: number
  /** 广告商品报表合计大于账户总花费，归属金额已按比例缩小。 */
  exceeded: boolean
  /** 广告商品报表里找不到对应 SKU、并入剩余部分一起分摊的花费。 */
  unmapped: number
}

const MICRO = 1_000_000
const toMicro = (value: number): number => Math.round(value * MICRO)
const fromMicro = (value: number): number => value / MICRO

/** 把整数 total 按权重拆成整数份，份额之和恰好等于 total（最大余数法，余数相同取靠前的）。权重全为 0 时平均分。 */
export function splitMicro(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return []
  const sum = weights.reduce((acc, weight) => acc + weight, 0)
  const effective = sum > 0 ? weights : weights.map(() => 1)
  const effectiveSum = sum > 0 ? sum : weights.length
  const exact = effective.map(weight => (total * weight) / effectiveSum)
  const parts = exact.map(value => Math.floor(value))
  let left = total - parts.reduce((acc, part) => acc + part, 0)
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let cursor = 0; left > 0 && order.length > 0; cursor = (cursor + 1) % order.length, left -= 1) parts[order[cursor]!.index]! += 1
  return parts
}

const weightOf = (row: AllocationRow, basis: AllocationBasis): number => Math.max(0, basis === 'BY_UNITS' ? row.units : row.revenue)

export function allocateAds(input: AllocationInput): AllocationResult {
  const totalMicro = Math.max(0, toMicro(input.total))
  const bySkuMicro = new Map<string, number>()
  const addedAsins = new Map<string, string>()
  const add = (sku: string, micro: number) => {
    if (micro > 0) bySkuMicro.set(sku, (bySkuMicro.get(sku) ?? 0) + micro)
  }
  const known = new Set(input.rows.map(row => row.sku))

  // 1. 广告商品报表：每个 ASIN 的花费归给销售它的 SKU；报表合计超过账户总花费时按比例缩小
  const entries = [...input.direct].filter(([, spend]) => spend > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const rawMicro = entries.map(([, spend]) => toMicro(spend))
  const rawSum = rawMicro.reduce((acc, value) => acc + value, 0)
  const exceeded = rawSum > totalMicro
  const directMicro = exceeded ? splitMicro(totalMicro, rawMicro) : rawMicro
  let attributed = 0
  let unmapped = 0
  entries.forEach(([asin], index) => {
    const amount = directMicro[index] ?? 0
    if (amount <= 0) return
    const sameAsin = input.rows.filter(row => row.asin === asin)
    let targets: Array<{ sku: string; weight: number }>
    if (sameAsin.length > 0) targets = sameAsin.map(row => ({ sku: row.sku, weight: weightOf(row, input.basis) }))
    else {
      const skus = [...new Set(input.asinSkus.get(asin) ?? [])].sort()
      targets = skus.map(sku => ({ sku, weight: 0 }))
    }
    if (targets.length === 0) {
      unmapped += amount
      return
    }
    const shares = splitMicro(
      amount,
      targets.map(target => target.weight),
    )
    targets.forEach((target, position) => {
      add(target.sku, shares[position] ?? 0)
      if (!known.has(target.sku)) addedAsins.set(target.sku, asin)
    })
    attributed += amount
  })

  // 2. 剩余的账户级花费（含找不到 SKU 的归属部分）按规则分摊到当天有销售的 SKU
  const pool = totalMicro - attributed
  const weighted = input.rows.map(row => ({ sku: row.sku, weight: weightOf(row, input.basis) })).filter(item => item.weight > 0)
  let unallocatedMicro = pool
  if (pool > 0 && weighted.length > 0) {
    const shares = splitMicro(
      pool,
      weighted.map(item => item.weight),
    )
    weighted.forEach((item, position) => add(item.sku, shares[position] ?? 0))
    unallocatedMicro = 0
  }

  return {
    bySku: new Map([...bySkuMicro].map(([sku, micro]) => [sku, fromMicro(micro)])),
    addedAsins,
    unallocated: fromMicro(unallocatedMicro),
    exceeded,
    unmapped: fromMicro(unmapped),
  }
}
