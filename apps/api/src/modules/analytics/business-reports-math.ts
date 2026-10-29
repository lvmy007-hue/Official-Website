import {
  BR_DEFAULT_DAYS,
  BR_DEFAULT_MONTHS,
  BR_DEFAULT_WEEKS,
  BR_METRIC_INFO,
  BR_METRIC_KEYS,
  type BrAdsSplit,
  type BrAttribution,
  type BrCard,
  type BrFigures,
  type BrFunnelStep,
  type BrGranularity,
  type BrPoint,
} from '@nova/api-contracts'
import { addDays, changeRatio, nullableSum, pointsChange, safeDivide } from '../overview'

// 业务报告的纯计算（P4-02，不访问数据库）：来源取舍、合计、比率、指标卡、漏斗、归因、广告拆分。
// 约定：官方没给的值是 null，不当 0；合计只加有值的行，整段都没有值才是 null；比率只用分子分母同一行都有值的行相除。

export interface BrRow {
  sellerAccountId: string
  /** 日粒度是当天，周与月粒度是该周（周日起）或该月第一天，YYYY-MM-DD。 */
  date: string
  source: string
  orderedSales: number | null
  unitsOrdered: number | null
  ordersCount: number | null
  sessions: number | null
  pageViews: number | null
  buyBoxPct: number | null
  unitSessionPct: number | null
  unitsRefunded: number | null
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const roundOrNull = (value: number | null, digits: number) => (value === null ? null : round(value, digits))

/** 同一店铺同一天两个来源都有时只用数据中心（不逐列混合），没有才用报告补充。 */
export function preferredRows(rows: readonly BrRow[]): BrRow[] {
  const best = new Map<string, BrRow>()
  for (const row of rows) {
    const key = `${row.sellerAccountId}|${row.date}`
    const current = best.get(key)
    if (!current || (row.source === 'DATA_KIOSK' && current.source !== 'DATA_KIOSK')) best.set(key, row)
  }
  return [...best.values()]
}

/** 分子分母同一行都有值才相除：返回 Σ分子 ÷ Σ分母；没有这样的行或分母为 0 返回 null。 */
function paired(rows: readonly BrRow[], numerator: (row: BrRow) => number | null, denominator: (row: BrRow) => number | null): number | null {
  let top = 0
  let bottom = 0
  let found = false
  for (const row of rows) {
    const a = numerator(row)
    const b = denominator(row)
    if (a === null || b === null) continue
    top += a
    bottom += b
    found = true
  }
  return found && bottom > 0 ? top / bottom : null
}

const average = (values: ReadonlyArray<number | null>): number | null => {
  const given = values.filter((value): value is number => value !== null)
  return given.length === 0 ? null : given.reduce((total, value) => total + value, 0) / given.length
}

/** 购物车获得率：按页面浏览量加权；没有页面浏览量用简单平均。 */
function weightedBuyBox(rows: readonly BrRow[]): number | null {
  let top = 0
  let weight = 0
  for (const row of rows) {
    if (row.buyBoxPct === null || row.pageViews === null || row.pageViews <= 0) continue
    top += row.buyBoxPct * row.pageViews
    weight += row.pageViews
  }
  return weight > 0 ? top / weight : average(rows.map(row => row.buyBoxPct))
}

export const EMPTY_FIGURES: BrFigures = {
  orderedSales: null,
  unitsOrdered: null,
  ordersCount: null,
  sessions: null,
  pageViews: null,
  unitSessionPct: null,
  avgPrice: null,
  buyBoxPct: null,
  unitsRefunded: null,
  refundRate: null,
}

/** 一批（已按来源取舍的）店铺日行 → 一组指标。 */
export function figuresOf(rows: readonly BrRow[]): BrFigures {
  if (rows.length === 0) return { ...EMPTY_FIGURES }
  return {
    orderedSales: roundOrNull(nullableSum(rows.map(row => row.orderedSales)), 2),
    unitsOrdered: nullableSum(rows.map(row => row.unitsOrdered)),
    ordersCount: nullableSum(rows.map(row => row.ordersCount)),
    sessions: nullableSum(rows.map(row => row.sessions)),
    pageViews: nullableSum(rows.map(row => row.pageViews)),
    unitSessionPct: roundOrNull(
      paired(
        rows,
        row => row.unitsOrdered,
        row => row.sessions,
      ) ?? average(rows.map(row => row.unitSessionPct)),
      6,
    ),
    avgPrice: roundOrNull(
      paired(
        rows,
        row => row.orderedSales,
        row => row.unitsOrdered,
      ),
      4,
    ),
    buyBoxPct: roundOrNull(weightedBuyBox(rows), 6),
    unitsRefunded: nullableSum(rows.map(row => row.unitsRefunded)),
    refundRate: roundOrNull(
      paired(
        rows,
        row => row.unitsRefunded,
        row => row.unitsOrdered,
      ),
      6,
    ),
  }
}

/** 把行按日期排成点：给了 days 就逐日补齐（没有记录的日子各项为 null、来源为 null），不给就只返回有记录的日期。 */
export function pointsOf(rows: readonly BrRow[], days?: readonly string[]): BrPoint[] {
  const byDate = new Map<string, BrRow[]>()
  const sources = new Map<string, Set<string>>()
  for (const row of rows) {
    byDate.set(row.date, [...(byDate.get(row.date) ?? []), row])
    sources.set(row.date, (sources.get(row.date) ?? new Set()).add(row.source))
  }
  const dates = days ? [...days] : [...byDate.keys()].sort()
  return dates.map<BrPoint>(date => {
    const used = sources.get(date)
    const source = !used ? null : used.size > 1 ? 'MIXED' : used.has('DATA_KIOSK') ? 'DATA_KIOSK' : 'REPORT'
    return { date, source, ...figuresOf(byDate.get(date) ?? []) }
  })
}

/** 范围内有多少天有数据、几天只有报告补充。 */
export function coverageOf(points: readonly BrPoint[]): { days: number; withData: number; reportOnly: number } {
  return { days: points.length, withData: points.filter(point => point.source !== null).length, reportOnly: points.filter(point => point.source === 'REPORT').length }
}

/** 指标卡：本期、对比期、变化（金额与数量用比率，百分比类用百分点差）。 */
export function cardsOf(current: BrFigures, compare: BrFigures | null): BrCard[] {
  return BR_METRIC_KEYS.map<BrCard>(key => {
    const info = BR_METRIC_INFO[key]
    const value = current[key]
    const compareValue = compare ? compare[key] : null
    const ratio = info.format !== 'percent'
    return {
      key,
      label: info.label,
      format: info.format,
      goodWhen: info.goodWhen,
      value,
      compareValue,
      change: ratio ? changeRatio(value, compareValue) : pointsChange(value, compareValue),
      changeKind: ratio ? 'ratio' : 'points',
      basis: info.basis,
    }
  })
}

/** 转化漏斗：会话 → 页面浏览量 → 订单商品数 → 订购件数；每一步写相对上一步的比值，缺任何一边就没有比值。 */
export function funnelOf(figures: BrFigures): BrFunnelStep[] {
  const ratio = (value: number | null, base: number | null) => roundOrNull(safeDivide(value, base), 6)
  return [
    { key: 'sessions', label: '会话', value: figures.sessions, rate: null, rateKind: 'per', rateLabel: '' },
    { key: 'pageViews', label: '页面浏览量', value: figures.pageViews, rate: ratio(figures.pageViews, figures.sessions), rateKind: 'per', rateLabel: '每个会话的页面浏览量' },
    { key: 'ordersCount', label: '订单商品数', value: figures.ordersCount, rate: ratio(figures.ordersCount, figures.pageViews), rateKind: 'percent', rateLabel: '订单商品数 ÷ 页面浏览量' },
    { key: 'unitsOrdered', label: '订购件数', value: figures.unitsOrdered, rate: ratio(figures.unitsOrdered, figures.ordersCount), rateKind: 'per', rateLabel: '每个订单商品的件数' },
  ]
}

/**
 * 指标树归因：销售额 = 会话 × 转化率（件数 ÷ 会话）× 件单价（销售额 ÷ 件数），三个因子用各自范围的合计相除，乘积恰好等于销售额。
 * 任一期缺会话、件数或销售额，或者为 0，就无法归因，返回原因。
 */
export function attributionOf(current: BrFigures, previous: BrFigures | null): { attribution: BrAttribution | null; note: string | null } {
  if (!previous) return { attribution: null, note: '没有选择对比期，无法做变化归因（在顶部范围栏选择“环比”“同比”或自定义对比期）。' }
  const usable = (figures: BrFigures) =>
    figures.sessions !== null && figures.sessions > 0 && figures.unitsOrdered !== null && figures.unitsOrdered > 0 && figures.orderedSales !== null && figures.orderedSales > 0
  if (!usable(current) || !usable(previous)) return { attribution: null, note: '本期或对比期缺少会话、订购件数或销售额（或为 0），三个因子需要都有数据才能归因，不用 0 补。' }
  const factor = (figures: BrFigures) => ({ sessions: figures.sessions!, conversion: figures.unitsOrdered! / figures.sessions!, unitPrice: figures.orderedSales! / figures.unitsOrdered! })
  const before = factor(previous)
  const after = factor(current)
  return {
    attribution: {
      mode: 'THREE_FACTOR',
      factors: [
        { key: 'sessions', label: '会话', before: before.sessions, after: after.sessions },
        { key: 'conversion', label: '转化率（件数 ÷ 会话）', before: before.conversion, after: after.conversion },
        { key: 'unitPrice', label: '件单价', before: before.unitPrice, after: after.unitPrice },
      ],
      sales: { before: previous.orderedSales!, after: current.orderedSales! },
    },
    note: null,
  }
}

const SPLIT_NO_DATA = '所选范围内没有广告销售额：广告账户没有绑定店铺、广告报告还没同步或这些日子的店铺日汇总还没重算，所以无法拆分自然销售与广告销售'

/** 自然销售 = 订购销售额 − 广告销售额；广告销售额缺失不拆，广告大于总额写“口径不符”，不夹成 0。 */
export function splitOf(orderedSales: number | null, adsSales: number | null): BrAdsSplit {
  if (adsSales === null) return { state: 'NO_DATA', note: SPLIT_NO_DATA, adsSales: null, organicSales: null, adsShare: null }
  const ads = round(adsSales, 2)
  if (orderedSales === null) return { state: 'NO_DATA', note: '所选范围内没有官方订购销售额，无法拆分', adsSales: ads, organicSales: null, adsShare: null }
  if (ads > orderedSales + 0.005) {
    return {
      state: 'MISMATCH',
      note: '口径不符：广告销售额大于官方订购销售额（广告按 7 天或 14 天归因窗口计、订购销售额按下单日计），不强行相减',
      adsSales: ads,
      organicSales: null,
      adsShare: null,
    }
  }
  return { state: 'OK', note: null, adsSales: ads, organicSales: round(orderedSales - ads, 2), adsShare: orderedSales > 0 ? round(ads / orderedSales, 6) : null }
}

// ---- 日期 ----

/** 亚马逊的周从周日开始。 */
export function weekStartSunday(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDays(date, -weekday)
}
export const monthStartOf = (date: string) => `${date.slice(0, 7)}-01`

/** 没有选日期范围时各粒度的默认范围（日 30 天、周 12 周、月 12 个月，到今天为止）。 */
export function defaultRangeFor(granularity: BrGranularity, today: string): { from: string; to: string } {
  if (granularity === 'DAY') return { from: addDays(today, 1 - BR_DEFAULT_DAYS), to: today }
  if (granularity === 'WEEK') return { from: addDays(today, 1 - BR_DEFAULT_WEEKS * 7), to: today }
  const [year, month] = today.split('-').map(Number) as [number, number]
  return { from: new Date(Date.UTC(year, month - 1 - (BR_DEFAULT_MONTHS - 1), 1)).toISOString().slice(0, 10), to: today }
}

/** 读数据的起点：周、月粒度的行日期是该周或该月第一天，范围起点落在中间时也要读到包含它的那一周或月。 */
export function readFromOf(granularity: BrGranularity, from: string): string {
  if (granularity === 'WEEK') return weekStartSunday(from)
  if (granularity === 'MONTH') return monthStartOf(from)
  return from
}
