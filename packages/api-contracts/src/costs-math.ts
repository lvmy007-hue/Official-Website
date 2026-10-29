import { COST_COMPONENTS, COST_COMPONENT_LABEL, type CostComponent, type CostCompareRow, type CostCoverage, type CostLandedState, type CostPricingBasis, type CostSource } from './costs.js'
import { COST_STALE_DAYS } from './profit-view.js'
import type { InventoryCosting } from './profit.js'

// 商品成本的纯函数（P2b-14）：当前成本取值、计价依据、确认生效时的替换规则、覆盖状态、版本对比、库存成本估算。
// API 用它们装配页面；规则与 worker 的利润计价（profit/costing.ts）保持一致：同一成本项只要有入库批次就只按批次，否则按价格版本。

/** 一个成本版本里与计算相关的部分；金额是数字（展示用的小数文本由 API 另外保留）。日期是 YYYY-MM-DD。 */
export interface CostLite {
  id: string
  versionNo: number
  status: string
  source: CostSource
  effectiveFrom: string
  currency: string
  product: number | null
  firstMile: number | null
  duty: number | null
  other: number | null
  /** 入库批次件数；null 是价格版本。 */
  quantity: number | null
}

const DAY_MS = 86_400_000
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS

export const daysBetween = (from: string, to: string): number => Math.round(dayNumber(to) - dayNumber(from))

export const isPriceSource = (source: CostSource): boolean => source === 'MANUAL' || source === 'FILE_IMPORT'

export const componentsOf = (version: CostLite): CostComponent[] => COST_COMPONENTS.filter(component => version[component] !== null)

/** 比较两个版本谁更新：生效日晚的更新，同一天版本号大的更新。用作排序时新的在前。 */
export const newerFirst = (a: CostLite, b: CostLite): number => (a.effectiveFrom === b.effectiveFrom ? b.versionNo - a.versionNo : a.effectiveFrom < b.effectiveFrom ? 1 : -1)

/**
 * 每个成本项当前的取值：生效中、生效日不晚于 today 的版本里，带有这一项的最新一条。没有为 null。
 * 采购收货的版本只带采购单价、头程分摊的版本只带头程，所以各项可能来自不同的版本。
 */
export function currentVersions(versions: readonly CostLite[], today: string): Record<CostComponent, CostLite | null> {
  const active = versions.filter(version => version.status === 'ACTIVE' && version.effectiveFrom <= today).sort(newerFirst)
  const pick = (component: CostComponent) => active.find(version => version[component] !== null) ?? null
  return { product: pick('product'), firstMile: pick('firstMile'), duty: pick('duty'), other: pick('other') }
}

/**
 * 计价依据（与利润计价一致）：某一项只要有入库批次（件数大于 0 的生效版本），就只按批次计价，价格版本不参与；否则按价格版本。
 * ignored 是被批次压过、实际不参与计价的价格版本，值是被压过的成本项。
 */
export function pricingOf(versions: readonly CostLite[]): { basis: CostPricingBasis; ignored: Map<string, CostComponent[]> } {
  const active = versions.filter(version => version.status === 'ACTIVE')
  const basis: CostPricingBasis = { product: null, firstMile: null, duty: null, other: null }
  const ignored = new Map<string, CostComponent[]>()
  for (const component of COST_COMPONENTS) {
    const has = active.filter(version => version[component] !== null)
    if (has.length === 0) continue
    const batched = has.some(version => version.quantity !== null && version.quantity > 0)
    basis[component] = batched ? 'BATCH' : 'PRICE'
    if (!batched) continue
    for (const version of has) if (version.quantity === null) ignored.set(version.id, [...(ignored.get(version.id) ?? []), component])
  }
  return { basis, ignored }
}

export type ActivationPlan = { ok: true; replaces: CostLite[] } | { ok: false; reason: string }

/**
 * 确认生效时的替换规则。
 * - 入库批次（采购收货、头程分摊）是各自独立的批次，生效不替换任何版本；
 * - 价格版本（手工、导入）：同一个 SKU 同一生效日已有生效中的价格版本且成本项有重叠，旧版本被替换；
 *   旧版本带有而新版本没有的成本项会随之失效，不允许悄悄丢掉，这种情况拒绝并让用户先补全。
 */
export function planActivation(draft: CostLite, actives: readonly CostLite[]): ActivationPlan {
  if (draft.status !== 'DRAFT') return { ok: false, reason: '只有草稿可以确认生效' }
  const mine = componentsOf(draft)
  if (mine.length === 0) return { ok: false, reason: '没有任何成本项' }
  if (!isPriceSource(draft.source)) return { ok: true, replaces: [] }
  const same = actives.filter(
    version =>
      version.id !== draft.id &&
      version.status === 'ACTIVE' &&
      isPriceSource(version.source) &&
      version.effectiveFrom === draft.effectiveFrom &&
      componentsOf(version).some(component => mine.includes(component)),
  )
  for (const version of same) {
    const lost = componentsOf(version).filter(component => !mine.includes(component))
    if (lost.length > 0) {
      const names = lost.map(component => `“${COST_COMPONENT_LABEL[component]}”`).join('、')
      return { ok: false, reason: `同一生效日已有第 ${version.versionNo} 版带有${names}，新版本没有，生效会让它们失效；请在草稿里补上，或改一个生效日` }
    }
  }
  return { ok: true, replaces: same }
}

/** 覆盖状态：有生效的采购单价看是否过期；没有则看有没有草稿。 */
export function coverageOf(input: { productEffectiveFrom: string | null; hasDraft: boolean; today: string }): CostCoverage {
  if (input.productEffectiveFrom) return daysBetween(input.productEffectiveFrom, input.today) > COST_STALE_DAYS ? 'STALE' : 'COVERED'
  return input.hasDraft ? 'DRAFT_ONLY' : 'MISSING'
}

/** 折合美元：汇率是 1 美元折合多少该币种；美元不需要汇率；没有汇率返回 null。 */
export function toUsd(amount: number, currency: string, rate: number | null): number | null {
  if (currency === 'USD') return round6(amount)
  return rate !== null && rate > 0 ? round6(amount / rate) : null
}

/** 到岸成本合计：各项折合美元后相加。没有采购单价合计不完整（不给）；有一项缺汇率也不给。 */
export function landedOf(parts: Record<CostComponent, { usd: number | null } | null>): { usd: number | null; state: CostLandedState } {
  const present = COST_COMPONENTS.flatMap(component => (parts[component] ? [parts[component]] : []))
  if (present.length === 0) return { usd: null, state: 'NO_DATA' }
  if (!parts.product) return { usd: null, state: 'NO_PRODUCT' }
  if (present.some(part => part.usd === null)) return { usd: null, state: 'NO_FX' }
  return { usd: round6(present.reduce((sum, part) => sum + (part.usd as number), 0)), state: 'OK' }
}

/** 版本对比（b 相对 a）：币种相同给差额与百分比；币种不同只给折合美元的差额（两边都有汇率时）。 */
export function compareVersions(a: CostLite, b: CostLite, rateOf: (currency: string) => number | null): CostCompareRow[] {
  const text = (value: number | null) => (value === null ? null : String(value))
  const rows: CostCompareRow[] = []
  for (const component of COST_COMPONENTS) {
    const before = a[component]
    const after = b[component]
    if (before === null && after === null) continue
    const same = a.currency === b.currency
    const delta = same && before !== null && after !== null ? round6(after - before) : null
    const usdBefore = before === null ? null : toUsd(before, a.currency, rateOf(a.currency))
    const usdAfter = after === null ? null : toUsd(after, b.currency, rateOf(b.currency))
    rows.push({
      component,
      label: COST_COMPONENT_LABEL[component],
      a: text(before),
      b: text(after),
      delta,
      deltaPct: delta !== null && before !== null && before > 0 ? round6(delta / before) : null,
      usdDelta: usdBefore !== null && usdAfter !== null ? round6(usdAfter - usdBefore) : null,
    })
  }
  return rows
}

/** 库存估算用的一层成本：qty 为 null 是价格版本；usd 是折合美元的单件成本。 */
export interface StockLayer {
  date: string
  qty: number | null
  usd: number
}

export interface StreamEstimate {
  basis: 'BATCH' | 'PRICE' | null
  value: number
  covered: number
  uncovered: number
}

/**
 * 一个成本项对库存的估值。数量只知道现在的库存件数，不知道每批已经卖了多少，所以是估算：
 * - 先进先出：先入的先卖掉，库存是最新的几批，从最新批次往前取；
 * - 移动加权与月末加权：用全部入库批次的加权平均单价（这里没有逐日销售，两种方法算出的数相同，不再区分）；
 * - 没有入库批次只有价格版本：用今天适用的价格版本单价。
 * 入库批次的总件数少于库存时，多出的件数没有成本（uncovered），不拿别的单价顶替。
 */
export function estimateStream(method: InventoryCosting, layers: readonly StockLayer[], onHand: number, today: string): StreamEstimate {
  const usable = layers.filter(layer => layer.date <= today)
  const batches = usable.filter(layer => layer.qty !== null && layer.qty > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (batches.length > 0) {
    const total = batches.reduce((sum, layer) => sum + (layer.qty as number), 0)
    const covered = Math.min(onHand, total)
    let value = 0
    if (method === 'FIFO') {
      let need = covered
      for (let index = batches.length - 1; index >= 0 && need > 0; index -= 1) {
        const layer = batches[index] as StockLayer
        const take = Math.min(need, layer.qty as number)
        value += take * layer.usd
        need -= take
      }
    } else {
      value = covered * (batches.reduce((sum, layer) => sum + (layer.qty as number) * layer.usd, 0) / total)
    }
    return { basis: 'BATCH', value: round6(value), covered, uncovered: onHand - covered }
  }
  const prices = usable.filter(layer => layer.qty === null).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  if (prices.length > 0) return { basis: 'PRICE', value: round6(onHand * (prices[0] as StockLayer).usd), covered: onHand, uncovered: 0 }
  return { basis: null, value: 0, covered: 0, uncovered: onHand }
}

export interface InventoryEstimate {
  /** 没有采购成本（没有任何一层）时为 null：库存成本不能只算头程与关税。 */
  valueUsd: number | null
  uncoveredUnits: number
  avgUnitUsd: number | null
}

/** 四项成本各自估值后相加；采购单价是必须的，缺它整体不给。onHand 为 0 时库存成本是 0。 */
export function estimateInventory(method: InventoryCosting, streams: Record<CostComponent, readonly StockLayer[]>, onHand: number, today: string): InventoryEstimate {
  const product = estimateStream(method, streams.product, onHand, today)
  if (product.basis === null) return { valueUsd: null, uncoveredUnits: onHand, avgUnitUsd: null }
  const rest = (['firstMile', 'duty', 'other'] as const).map(component => estimateStream(method, streams[component], onHand, today))
  const value = round6(product.value + rest.reduce((sum, item) => sum + item.value, 0))
  return { valueUsd: value, uncoveredUnits: product.uncovered, avgUnitUsd: product.covered > 0 ? round6(value / product.covered) : null }
}
