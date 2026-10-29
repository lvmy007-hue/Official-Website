import {
  ASIN360_TRAFFIC_TERM_LIMIT,
  BA_BREAKPOINT_BASIS,
  BA_BREAKPOINTS,
  BA_FUNNEL_LABEL,
  BA_FUNNEL_STAGES,
  BA_MIN_SAMPLE,
  breakpointOf,
  medianShares,
  periodEndOf,
  previousPeriodStart,
  ratioOf,
  shareDelta,
  type Asin360BreakpointSummary,
  type Asin360CoreTerm,
  type Asin360FunnelPeriod,
  type Asin360TrafficPoint,
  type Asin360TrafficSummary,
  type BaBreakpoint,
  type BaFunnelKey,
  type BaFunnelStage,
  type BaPeriod,
  type BaShareSet,
} from '@nova/api-contracts'
import { nullableSum } from '../overview'

// ASIN 360 流量转化页签的纯计算（P4-08）：逐日流量取数据中心优先、合计与加权、搜索词漏斗与断点。没有数据的指标一律是 null，不补 0。

export interface TrafficRow {
  date: string
  source: string
  sessions: number | null
  pageViews: number | null
  units: number | null
  sales: number | null
  buyBoxPct: number | null
  unitSessionPct: number | null
}

const ratio = (top: number | null, bottom: number | null): number | null => (top === null || bottom === null || bottom <= 0 ? null : Math.round((top / bottom) * 1e6) / 1e6)

/** 同一天两个来源都有时取数据中心（DATA_KIOSK），否则用报告补充来源。 */
export function preferKiosk(rows: readonly TrafficRow[]): Map<string, TrafficRow> {
  const byDate = new Map<string, TrafficRow>()
  for (const row of rows) {
    const held = byDate.get(row.date)
    if (!held || (row.source === 'DATA_KIOSK' && held.source !== 'DATA_KIOSK')) byDate.set(row.date, row)
  }
  return byDate
}

/** 范围内每一天一个点；没有记录的日子各指标都是 null（不是 0）。转化率缺省时用件数 ÷ 会话补算。 */
export function trafficPoints(days: readonly string[], byDate: ReadonlyMap<string, TrafficRow>): Asin360TrafficPoint[] {
  return days.map(date => {
    const row = byDate.get(date)
    if (!row) return { date, sessions: null, pageViews: null, units: null, sales: null, buyBoxPct: null, unitSessionPct: null }
    return {
      date,
      sessions: row.sessions,
      pageViews: row.pageViews,
      units: row.units,
      sales: row.sales,
      buyBoxPct: row.buyBoxPct,
      unitSessionPct: row.unitSessionPct ?? ratio(row.units, row.sessions),
    }
  })
}

/** 合计：转化率与购物车获得率只用“两个口径都有记录”的日子（不让缺记录的日子拉低或抬高）。没有任何记录返回 null。 */
export function summarizeTraffic(points: readonly Asin360TrafficPoint[]): Asin360TrafficSummary | null {
  const recorded = points.filter(point => point.sessions !== null || point.pageViews !== null || point.units !== null || point.sales !== null)
  if (recorded.length === 0) return null
  const both = recorded.filter(point => point.sessions !== null && point.units !== null)
  const weighted = recorded.filter(point => point.sessions !== null && point.sessions > 0 && point.buyBoxPct !== null)
  const sessions = nullableSum(recorded.map(point => point.sessions))
  const pageViews = nullableSum(recorded.map(point => point.pageViews))
  const weightSum = weighted.reduce((sum, point) => sum + point.sessions!, 0)
  return {
    sessions,
    pageViews,
    units: nullableSum(recorded.map(point => point.units)),
    sales: nullableSum(recorded.map(point => point.sales)),
    unitSessionPct: ratio(nullableSum(both.map(point => point.units)), nullableSum(both.map(point => point.sessions))),
    buyBoxPct: weightSum > 0 ? Math.round((weighted.reduce((sum, point) => sum + point.buyBoxPct! * point.sessions!, 0) / weightSum) * 1e6) / 1e6 : null,
    pageViewsPerSession: sessions !== null && pageViews !== null ? ratio(pageViews, sessions) : null,
    days: recorded.length,
  }
}

/** 选中的品牌分析周期：传了起始日就用它（可能没有数据），没传取最近一个有数据的周期；这一种周期一个都没有为 null。 */
export function resolveFunnelPeriod(kind: BaPeriod, requested: string | undefined, available: readonly string[]): Asin360FunnelPeriod | null {
  const start = requested ?? available[0]
  if (!start) return null
  return { kind, start, end: periodEndOf(kind, start), previousStart: previousPeriodStart(kind, start), available: [...available] }
}

// ---- 搜索词漏斗 ----

export interface TermCounts {
  impressions: number | null
  clicks: number | null
  cartAdds: number | null
  purchases: number | null
}

export interface TermRow {
  searchQuery: string
  searchVolume: number | null
  own: TermCounts
  total: TermCounts
  /** 官方给的份额（只有一个 ASIN 时我方次数缺失就用它）。 */
  official: BaShareSet
}

const OFFICIAL_KEY: Record<BaFunnelKey, keyof BaShareSet> = { impressions: 'impression', clicks: 'click', cartAdds: 'cartAdd', purchases: 'purchase' }
const clamp = (value: number | null) => (value === null ? null : Math.min(1, Math.max(0, value)))

/** 一个词的四个份额：我方次数 ÷ 市场总次数；次数缺失时退回官方给的份额。 */
export function termShares(row: TermRow): BaShareSet {
  const pick = (key: BaFunnelKey) => clamp(ratioOf(row.own[key], row.total[key])) ?? row.official[OFFICIAL_KEY[key]]
  return { impression: pick('impressions'), click: pick('clicks'), cartAdd: pick('cartAdds'), purchase: pick('purchases') }
}

/** 全部词合计的漏斗，与上一周期对比（上一周期没有数据传 null）。 */
export function funnelStages(current: readonly TermRow[], previous: readonly TermRow[] | null): BaFunnelStage[] {
  const share = (rows: readonly TermRow[], key: BaFunnelKey) => ratioOf(nullableSum(rows.map(row => row.own[key])), nullableSum(rows.map(row => row.total[key])))
  return BA_FUNNEL_STAGES.map(key => {
    const now = share(current, key)
    const before = previous ? share(previous, key) : null
    return {
      key,
      label: BA_FUNNEL_LABEL[key],
      market: nullableSum(current.map(row => row.total[key])),
      own: nullableSum(current.map(row => row.own[key])),
      share: now,
      previousShare: before,
      shareChange: shareDelta(now, before),
    }
  })
}

const byVolume = (a: TermRow, b: TermRow) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1) || (a.searchQuery < b.searchQuery ? -1 : a.searchQuery > b.searchQuery ? 1 : 0)

/** 核心搜索词（按搜索量从高到低）与断点诊断：中位数用这个 ASIN 自己的全部搜索词算。 */
export function coreTerms(rows: readonly TermRow[]): { terms: Asin360CoreTerm[]; breakpoints: Asin360BreakpointSummary } {
  const sorted = [...rows].sort(byVolume)
  const shared = sorted.map(row => termShares(row))
  const medians = medianShares(shared)
  const counts = Object.fromEntries(BA_BREAKPOINTS.map(key => [key, 0])) as Record<BaBreakpoint, number>
  const terms = sorted.map<Asin360CoreTerm>((row, index) => {
    const breakpoint = breakpointOf(shared[index]!, medians)
    if (breakpoint) counts[breakpoint] += 1
    return { searchQuery: row.searchQuery, searchVolume: row.searchVolume, shares: shared[index]!, ownPurchases: row.own.purchases, breakpoint }
  })
  const breakpoints: Asin360BreakpointSummary = medians
    ? { state: 'OK', note: BA_BREAKPOINT_BASIS, counts, medians }
    : { state: 'INSUFFICIENT', note: `展示、点击、加购、购买四个份额各自带值的搜索词都要不少于 ${BA_MIN_SAMPLE} 个才做断点诊断`, counts, medians: null }
  return { terms: terms.slice(0, ASIN360_TRAFFIC_TERM_LIMIT), breakpoints }
}
