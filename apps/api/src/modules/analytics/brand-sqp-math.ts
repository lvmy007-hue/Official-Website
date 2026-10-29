import {
  BA_BREAKPOINT_BASIS,
  BA_BREAKPOINTS,
  BA_FUNNEL_LABEL,
  BA_FUNNEL_STAGES,
  BA_MIN_SAMPLE,
  BA_OVERVIEW_ROOTS,
  BA_QUADRANT_BASIS,
  BA_QUADRANT_POINTS,
  BA_QUADRANTS,
  BA_SHIPPING_LABEL,
  BA_SHIPPING_SPEEDS,
  baQuadrantMedians,
  baQuadrantOf,
  breakpointOf,
  medianShares,
  ratioOf,
  shareDelta,
  termTokens,
  weightedAverage,
  type BaBreakpoint,
  type BaBreakpointSummary,
  type BaFunnelKey,
  type BaFunnelStage,
  type BaOverview,
  type BaPriceRow,
  type BaQuadrant,
  type BaQuadrantSummary,
  type BaRootRow,
  type BaShareSet,
  type BaShippingRow,
  type BaShippingSpeed,
  type BaTrendPoint,
} from '@nova/api-contracts'

// 搜索查询表现的汇总计算（P4-04，纯函数，不碰数据库）：份额按次数重算（我方次数 ÷ 市场总次数），不对份额做简单平均；
// 官方没给的值是 null（不补 0）。一个 SqpGroup 是“一个搜索词在一个周期里、所选 ASIN 合计后的结果”。

export interface Counts {
  impressions: number | null
  clicks: number | null
  cartAdds: number | null
  purchases: number | null
}
export interface PricePair {
  own: number | null
  total: number | null
}
export interface SqpGroup {
  searchQuery: string
  volume: number | null
  score: number | null
  own: Counts
  total: Counts
  /** 官方给的我方份额（只在所选只有一个 ASIN 时可作次数缺失时的后备）。 */
  official: BaShareSet
  prices: { click: PricePair; cartAdd: PricePair; purchase: PricePair }
  ship: Record<BaShippingSpeed, PricePair>
  asinCount: number
}

export const sumNullable = (values: ReadonlyArray<number | null>): number | null => {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0)
}
const clamp = (value: number | null): number | null => (value === null ? null : Math.min(1, Math.max(0, value)))
const round4 = (value: number) => Math.round(value * 1e4) / 1e4

const STAGE_KEY: Record<BaFunnelKey, keyof BaShareSet> = { impressions: 'impression', clicks: 'click', cartAdds: 'cartAdd', purchases: 'purchase' }

/** 一个词的四个份额：次数算得出就用次数，算不出且只选了一个 ASIN 时用官方份额。 */
export function sharesOf(group: SqpGroup): BaShareSet {
  const one = group.asinCount === 1
  const pick = (key: BaFunnelKey) => clamp(ratioOf(group.own[key], group.total[key])) ?? (one ? group.official[STAGE_KEY[key]] : null)
  return { impression: pick('impressions'), click: pick('clicks'), cartAdd: pick('cartAdds'), purchase: pick('purchases') }
}

/** 全部词合计的漏斗：市场次数、我方次数、份额，与上一周期对比。 */
export function funnelOf(groups: readonly SqpGroup[], previous: readonly SqpGroup[]): BaFunnelStage[] {
  const share = (list: readonly SqpGroup[], key: BaFunnelKey) => ratioOf(sumNullable(list.map(group => group.own[key])), sumNullable(list.map(group => group.total[key])))
  return BA_FUNNEL_STAGES.map(key => {
    const now = share(groups, key)
    const before = share(previous, key)
    return {
      key,
      label: BA_FUNNEL_LABEL[key],
      market: sumNullable(groups.map(group => group.total[key])),
      own: sumNullable(groups.map(group => group.own[key])),
      share: now,
      previousShare: before,
      shareChange: shareDelta(now, before),
    }
  })
}

/** 逐期趋势：同一批搜索词在每个周期的搜索量合计与四个份额。starts 是从早到晚的起始日。 */
export function trendOf(byPeriod: ReadonlyMap<string, readonly SqpGroup[]>, starts: readonly string[]): BaTrendPoint[] {
  return starts.map(periodStart => {
    const groups = byPeriod.get(periodStart) ?? []
    const share = (key: BaFunnelKey) => ratioOf(sumNullable(groups.map(group => group.own[key])), sumNullable(groups.map(group => group.total[key])))
    return {
      periodStart,
      volume: sumNullable(groups.map(group => group.volume)),
      shares: { impression: share('impressions'), click: share('clicks'), cartAdd: share('cartAdds'), purchase: share('purchases') },
    }
  })
}

/** 价格对比：每个词的中位价按搜索量加权平均（不是整体的中位数）；价差 = 我方 ÷ 市场 - 1。 */
export function priceRowsOf(groups: readonly SqpGroup[]): BaPriceRow[] {
  const stages = [
    { stage: 'click', label: '点击' },
    { stage: 'cartAdd', label: '加购' },
    { stage: 'purchase', label: '购买' },
  ] as const
  return stages.map(({ stage, label }) => {
    const own = weightedAverage(groups.map(group => ({ value: group.prices[stage].own, weight: group.volume })))
    const market = weightedAverage(groups.map(group => ({ value: group.prices[stage].total, weight: group.volume })))
    return { stage, label, own, market, gap: own !== null && market !== null && market > 0 ? round4(own / market - 1) : null }
  })
}

/** 配送速度：购买阶段，各档的我方购买次数、市场购买次数与份额。 */
export function shippingRowsOf(groups: readonly SqpGroup[]): BaShippingRow[] {
  return BA_SHIPPING_SPEEDS.map(speed => {
    const own = sumNullable(groups.map(group => group.ship[speed].own))
    const market = sumNullable(groups.map(group => group.ship[speed].total))
    return { speed, label: BA_SHIPPING_LABEL[speed], own, market, share: ratioOf(own, market) }
  })
}

const byVolume = <T extends { volume: number | null; searchQuery: string }>(a: T, b: T) =>
  (b.volume ?? -1) - (a.volume ?? -1) || (a.searchQuery < b.searchQuery ? -1 : a.searchQuery > b.searchQuery ? 1 : 0)

const emptyCounts = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>

/** 机会象限：横轴搜索量、纵轴购买份额，中位数在全部词上算；点数只返回搜索量最高的 BA_QUADRANT_POINTS 个。 */
export function quadrantOf(groups: ReadonlyArray<{ searchQuery: string; volume: number | null; shares: BaShareSet }>): BaQuadrantSummary {
  const medians = baQuadrantMedians(groups.map(group => ({ volume: group.volume, purchaseShare: group.shares.purchase })))
  const counts = emptyCounts<BaQuadrant>(BA_QUADRANTS)
  if (!medians) return { state: 'INSUFFICIENT', note: `带搜索量与购买份额的搜索词不足 ${BA_MIN_SAMPLE} 个，不做象限分析（样本太少，中位数没有意义）`, medians: null, counts, points: [] }
  const points = groups
    .flatMap(group => {
      const quadrant = baQuadrantOf(group.volume, group.shares.purchase, medians)
      return quadrant ? [{ searchQuery: group.searchQuery, volume: group.volume!, purchaseShare: group.shares.purchase!, quadrant }] : []
    })
    .sort((a, b) => b.volume - a.volume || (a.searchQuery < b.searchQuery ? -1 : 1))
  for (const point of points) counts[point.quadrant] += 1
  return { state: 'OK', note: BA_QUADRANT_BASIS, medians, counts, points: points.slice(0, BA_QUADRANT_POINTS) }
}

const EXAMPLES_PER_BREAKPOINT = 5

/** 份额漏斗断点诊断：高低以各份额在全部词中的中位数为界；每种断点列出搜索量最高的几个词做例子。 */
export function breakpointsOf(groups: ReadonlyArray<{ searchQuery: string; volume: number | null; shares: BaShareSet }>): BaBreakpointSummary {
  const medians = medianShares(groups.map(group => group.shares))
  const counts = emptyCounts<BaBreakpoint>(BA_BREAKPOINTS)
  const examples: BaBreakpointSummary['examples'] = { CLICK: [], CART: [], PURCHASE: [] }
  if (!medians) return { state: 'INSUFFICIENT', note: `展示、点击、加购、购买四个份额各自带值的搜索词都要不少于 ${BA_MIN_SAMPLE} 个才做断点诊断`, medians: null, counts, examples }
  for (const group of [...groups].sort(byVolume)) {
    const kind = breakpointOf(group.shares, medians)
    if (!kind) continue
    counts[kind] += 1
    if (examples[kind].length < EXAMPLES_PER_BREAKPOINT) examples[kind].push({ searchQuery: group.searchQuery, searchVolume: group.volume, shares: group.shares })
  }
  return { state: 'OK', note: BA_BREAKPOINT_BASIS, medians, counts, examples }
}

const FORMS_PER_ROOT = 3

/** 品牌搜索份额总览：按词根合并搜索词，看每个词根下我方点击与购买占市场的比例；只列市场点击最多的前几个词根。 */
export function overviewOf(groups: readonly SqpGroup[]): BaOverview {
  const roots = new Map<string, { forms: Map<string, number>; terms: number; marketClicks: number; ownClicks: number; marketPurchases: number; ownPurchases: number }>()
  for (const group of groups) {
    for (const token of termTokens(group.searchQuery)) {
      const bucket = roots.get(token.root) ?? { forms: new Map(), terms: 0, marketClicks: 0, ownClicks: 0, marketPurchases: 0, ownPurchases: 0 }
      bucket.forms.set(token.form, (bucket.forms.get(token.form) ?? 0) + 1)
      bucket.terms += 1
      bucket.marketClicks += group.total.clicks ?? 0
      bucket.ownClicks += group.own.clicks ?? 0
      bucket.marketPurchases += group.total.purchases ?? 0
      bucket.ownPurchases += group.own.purchases ?? 0
      roots.set(token.root, bucket)
    }
  }
  const rows = [...roots.entries()]
    .map<BaRootRow>(([root, bucket]) => ({
      root,
      forms: [...bucket.forms.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, FORMS_PER_ROOT)
        .map(([form]) => form),
      terms: bucket.terms,
      marketClicks: bucket.marketClicks,
      ownClicks: bucket.ownClicks,
      clickShare: ratioOf(bucket.ownClicks, bucket.marketClicks),
      marketPurchases: bucket.marketPurchases,
      ownPurchases: bucket.ownPurchases,
      purchaseShare: ratioOf(bucket.ownPurchases, bucket.marketPurchases),
    }))
    .sort((a, b) => b.marketClicks - a.marketClicks || (a.root < b.root ? -1 : 1))
    .slice(0, BA_OVERVIEW_ROOTS)
  return rows.length === 0
    ? { state: 'NO_DATA', note: '所选周期没有可拆成词根的搜索词', rows: [] }
    : { state: 'OK', note: '按词根合并搜索词（单复数还原，去掉虚词）；一个搜索词含多个词根时每个词根各算一次，所以各行之和可以大于总数', rows }
}
