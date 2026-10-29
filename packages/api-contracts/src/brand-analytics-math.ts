import { BA_BASKET_RULES, BA_MIN_SAMPLE, BA_TERM_RULES, type BaBasketAdvice, type BaBreakpoint, type BaPeriod, type BaQuadrant, type BaTermGroup } from './brand-analytics.js'
import type { BaShareSet } from './brand-analytics-types.js'

// 品牌分析的纯计算（P4-04）：周期对齐、份额、中位数、份额漏斗断点、机会象限、热门搜索词分组、购物篮建议。
// 日期一律是 YYYY-MM-DD 文本（亚马逊美国站的日历日，按 UTC 日算，不换算时区）。没有值是 null，不补 0。

const DAY_MS = 86_400_000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const toMs = (text: string) => Date.parse(`${text}T00:00:00Z`)
const toText = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** 日期文本合法（含回写比对，2 月 30 日不算）。 */
export function isDateText(text: string | null | undefined): text is string {
  if (!text || !DATE_PATTERN.test(text)) return false
  const ms = toMs(text)
  return !Number.isNaN(ms) && toText(ms) === text
}

/** 周期起始日是否对齐：周必须是周日，月必须是 1 日，季必须是 1、4、7、10 月的 1 日。 */
export function isPeriodStart(kind: BaPeriod, start: string): boolean {
  if (!isDateText(start)) return false
  const date = new Date(toMs(start))
  if (kind === 'WEEK') return date.getUTCDay() === 0
  if (date.getUTCDate() !== 1) return false
  return kind === 'MONTH' || date.getUTCMonth() % 3 === 0
}

/** 周期的最后一天；起始日没对齐返回 null。 */
export function periodEndOf(kind: BaPeriod, start: string): string | null {
  if (!isPeriodStart(kind, start)) return null
  if (kind === 'WEEK') return toText(toMs(start) + 6 * DAY_MS)
  const date = new Date(toMs(start))
  const months = kind === 'MONTH' ? 1 : 3
  return toText(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1) - DAY_MS)
}

/** 起止日恰好是一个对齐的周、月或季时返回它的种类，否则 null。 */
export function periodKindOf(start: string | null | undefined, end: string | null | undefined): BaPeriod | null {
  if (!isDateText(start) || !isDateText(end)) return null
  for (const kind of ['WEEK', 'MONTH', 'QUARTER'] as const) if (periodEndOf(kind, start) === end) return kind
  return null
}

/** 上一个同种周期的起始日。 */
export function previousPeriodStart(kind: BaPeriod, start: string): string {
  if (kind === 'WEEK') return toText(toMs(start) - 7 * DAY_MS)
  const date = new Date(toMs(start))
  return toText(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - (kind === 'MONTH' ? 1 : 3), 1))
}

/** 最近一个已经结束的周期（结束日早于今天，UTC）：定时申请报告用。 */
export function lastCompletePeriod(kind: BaPeriod, now: Date): { start: string; end: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  let start: number
  if (kind === 'WEEK') {
    const sunday = today - new Date(today).getUTCDay() * DAY_MS // 本周周日
    start = sunday - 7 * DAY_MS
  } else {
    const step = kind === 'MONTH' ? 1 : 3
    const month = new Date(today).getUTCMonth()
    const first = Date.UTC(new Date(today).getUTCFullYear(), kind === 'MONTH' ? month : month - (month % 3), 1)
    start = Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() - step, 1)
  }
  const startText = toText(start)
  return { start: startText, end: periodEndOf(kind, startText)! }
}

/** 逐期取最近 count 个起始日（含 start，最近的在前）。 */
export function recentPeriodStarts(kind: BaPeriod, start: string, count: number): string[] {
  const list: string[] = []
  let current = start
  for (let index = 0; index < count; index += 1) {
    list.push(current)
    current = previousPeriodStart(kind, current)
  }
  return list
}

// ---- 比率与份额 ----

/** 我方 ÷ 总量；任一缺失或总量不为正为 null；结果四舍五入到 6 位小数。 */
export function ratioOf(own: number | null | undefined, total: number | null | undefined): number | null {
  if (own === null || own === undefined || total === null || total === undefined || total <= 0) return null
  return Math.round((own / total) * 1e6) / 1e6
}

/** 份额变化（百分点）：任一期没有为 null。 */
export function shareDelta(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now === null || now === undefined || before === null || before === undefined) return null
  return Math.round((now - before) * 1e6) / 1e6
}

/** 按权重加权的比率：Σ(值 × 权重) ÷ Σ权重，只用值与权重都有的行；没有可用行为 null。 */
export function weightedAverage(items: ReadonlyArray<{ value: number | null; weight: number | null }>): number | null {
  let top = 0
  let bottom = 0
  for (const item of items) {
    if (item.value === null || item.weight === null || item.weight <= 0) continue
    top += item.value * item.weight
    bottom += item.weight
  }
  return bottom > 0 ? Math.round((top / bottom) * 1e6) / 1e6 : null
}

export function baMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  return Math.round(value * 1e6) / 1e6
}

export const emptyShares = (): BaShareSet => ({ impression: null, click: null, cartAdd: null, purchase: null })

const SHARE_KEYS = ['impression', 'click', 'cartAdd', 'purchase'] as const

/** 各份额在全部词中的中位数；任何一个份额带值的词不足 BA_MIN_SAMPLE 个就整体不分析（null）。 */
export function medianShares(rows: ReadonlyArray<BaShareSet>): BaShareSet | null {
  const result = emptyShares()
  for (const key of SHARE_KEYS) {
    const values = rows.flatMap(row => (row[key] === null ? [] : [row[key]!]))
    if (values.length < BA_MIN_SAMPLE) return null
    result[key] = baMedian(values)
  }
  return result
}

/** 份额漏斗断点（M-146）：上游优先，只有相关两个份额都有值才判断。 */
export function breakpointOf(shares: BaShareSet, medians: BaShareSet | null): BaBreakpoint | null {
  if (!medians) return null
  const high = (key: (typeof SHARE_KEYS)[number]) => shares[key] !== null && medians[key] !== null && shares[key]! >= medians[key]!
  const low = (key: (typeof SHARE_KEYS)[number]) => shares[key] !== null && medians[key] !== null && shares[key]! < medians[key]!
  if (high('impression') && low('click')) return 'CLICK'
  if (high('click') && low('cartAdd')) return 'CART'
  if (high('cartAdd') && low('purchase')) return 'PURCHASE'
  return null
}

/** 机会象限（M-148）：搜索量与购买份额都不低于中位数算高。 */
export function baQuadrantOf(volume: number | null, purchaseShare: number | null, medians: { volume: number; purchaseShare: number } | null): BaQuadrant | null {
  if (!medians || volume === null || purchaseShare === null) return null
  const highVolume = volume >= medians.volume
  const highShare = purchaseShare >= medians.purchaseShare
  if (highVolume) return highShare ? 'STAR' : 'OPPORTUNITY'
  return highShare ? 'NICHE' : 'WATCH'
}

/** 象限的中位数：搜索量与购买份额都带值的词不足 BA_MIN_SAMPLE 个为 null。 */
export function baQuadrantMedians(rows: ReadonlyArray<{ volume: number | null; purchaseShare: number | null }>): { volume: number; purchaseShare: number } | null {
  const both = rows.filter((row): row is { volume: number; purchaseShare: number } => row.volume !== null && row.purchaseShare !== null)
  if (both.length < BA_MIN_SAMPLE) return null
  return { volume: baMedian(both.map(row => row.volume))!, purchaseShare: baMedian(both.map(row => row.purchaseShare))! }
}

// ---- 热门搜索词 ----

export interface TermShareSlot {
  asin: string | null
  clickShare: number | null
}

/** 点击份额前三里我方 ASIN 的最高点击份额；前三里没有我方返回 null，用 inTop3 区分“在前三但份额缺失”。 */
export function ownTopOf(slots: ReadonlyArray<TermShareSlot>, own: ReadonlySet<string>): { inTop3: boolean; bestClickShare: number | null } {
  let inTop3 = false
  let best: number | null = null
  for (const slot of slots.slice(0, BA_TERM_RULES.topN)) {
    if (!slot.asin || !own.has(slot.asin)) continue
    inTop3 = true
    if (slot.clickShare !== null && (best === null || slot.clickShare > best)) best = slot.clickShare
  }
  return { inTop3, bestClickShare: best }
}

/** 机会词与风险词（规则见 BA_TERM_RULES）。上一周期没有这个词（previous 为 null）时不判断。 */
export function termGroupOf(
  now: { rank: number | null; inTop3: boolean; bestClickShare: number | null },
  previous: { rank: number | null; inTop3: boolean; bestClickShare: number | null } | null,
): BaTermGroup | null {
  if (!previous) return null
  if (previous.inTop3 && !now.inTop3) return 'RISK'
  if (previous.inTop3 && now.inTop3) {
    const drop = shareDelta(previous.bestClickShare, now.bestClickShare)
    if (drop !== null && drop >= BA_TERM_RULES.shareDrop - 1e-9) return 'RISK'
  }
  if (!now.inTop3 && now.rank !== null && previous.rank !== null && previous.rank > 0 && now.rank < previous.rank) {
    if ((previous.rank - now.rank) / previous.rank >= BA_TERM_RULES.riseRatio - 1e-9) return 'OPPORTUNITY'
  }
  return null
}

// ---- 购物篮 ----

export function basketAdviceOf(input: { pairedOwn: boolean; combinationPct: number | null }): BaBasketAdvice | null {
  if (input.combinationPct === null) return null
  if (input.pairedOwn) return input.combinationPct >= BA_BASKET_RULES.bundleMinPct - 1e-9 ? 'BUNDLE' : null
  return input.combinationPct >= BA_BASKET_RULES.targetMinPct - 1e-9 ? 'PRODUCT_TARGETING' : null
}
