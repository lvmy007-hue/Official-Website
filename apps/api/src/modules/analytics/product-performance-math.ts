import { PP_FAST_KEYS, PP_METRICS, type PpCell, type PpMetricKey } from '@nova/api-contracts'
import { marginOf, type Totals } from '../profit'

// 商品表现宽表的纯计算（P6-22）：把 店铺 × ASIN 的事实按维度合并成行，算每个指标的本期、上期、涨跌与汇总行。
// 金额先按分取整再相加：汇总行是各行取整后的金额之和，所以“汇总行 = 明细之和”精确到分；比率（转化率、ACOS、毛利率…）用合计重算，不对比率求平均。
// null 永远表示“没有数据”，不是 0。

export const round2 = (value: number) => Math.round(value * 100) / 100
const round6 = (value: number) => Math.round(value * 1e6) / 1e6
const plus = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0))

/** 一个 店铺 × ASIN 在一段时间内的事实（来自数据库汇总）；null = 没有来源。 */
export interface Facts {
  units: number | null
  orders: number | null
  sales: number | null
  b2bSales: number | null
  sessions: number | null
  pageViews: number | null
  buyBox: number | null
  adSpend: number | null
  adSales: number | null
}
export const NO_FACTS: Facts = { units: null, orders: null, sales: null, b2bSales: null, sessions: null, pageViews: null, buyBox: null, adSpend: null, adSales: null }

/** 可相加的合计：购物车赢得率按浏览量加权，所以存“分子、分母”。 */
export interface Acc {
  units: number | null
  orders: number | null
  sales: number | null
  b2bSales: number | null
  sessions: number | null
  pageViews: number | null
  bbNum: number | null
  bbDen: number | null
  adSpend: number | null
  adSales: number | null
}
export const emptyAcc = (): Acc => ({ units: null, orders: null, sales: null, b2bSales: null, sessions: null, pageViews: null, bbNum: null, bbDen: null, adSpend: null, adSales: null })

export function accOf(facts: Facts): Acc {
  const weighted = facts.buyBox !== null && facts.pageViews !== null && facts.pageViews > 0
  return {
    units: facts.units,
    orders: facts.orders,
    sales: facts.sales,
    b2bSales: facts.b2bSales,
    sessions: facts.sessions,
    pageViews: facts.pageViews,
    bbNum: weighted ? facts.buyBox! * facts.pageViews! : null,
    bbDen: weighted ? facts.pageViews : null,
    adSpend: facts.adSpend,
    adSales: facts.adSales,
  }
}

export function addAcc(a: Acc, b: Acc): Acc {
  return {
    units: plus(a.units, b.units),
    orders: plus(a.orders, b.orders),
    sales: plus(a.sales, b.sales),
    b2bSales: plus(a.b2bSales, b.b2bSales),
    sessions: plus(a.sessions, b.sessions),
    pageViews: plus(a.pageViews, b.pageViews),
    bbNum: plus(a.bbNum, b.bbNum),
    bbDen: plus(a.bbDen, b.bbDen),
    adSpend: plus(a.adSpend, b.adSpend),
    adSales: plus(a.adSales, b.adSales),
  }
}

/** 一段时间内一行的全部输入：销售流量广告合计 + 利润合计（没有利润权限或没有利润记录为 null）。 */
export interface Period {
  acc: Acc
  profit: Totals | null
}
export const emptyPeriod = (): Period => ({ acc: emptyAcc(), profit: null })

export type Values = Partial<Record<PpMetricKey, number | null>>

const ratio = (top: number | null, bottom: number | null): number | null => (top === null || bottom === null || bottom <= 0 ? null : round6(top / bottom))
const money = (value: number | null) => (value === null ? null : round2(value))

/** 这一段的全部快指标；利润类指标按 `canProfit`、`canCost` 决定要不要算。 */
export function valuesOf(period: Period, canProfit: boolean, canCost: boolean): Values {
  const { acc, profit } = period
  const sales = money(acc.sales)
  const adSpend = money(acc.adSpend)
  const adSales = money(acc.adSales)
  const out: Values = {
    units: acc.units,
    orders: acc.orders,
    sales,
    avgPrice: acc.units !== null && acc.units > 0 && sales !== null ? round2(sales / acc.units) : null,
    b2bSales: money(acc.b2bSales),
    sessions: acc.sessions,
    pageViews: acc.pageViews,
    conversion: ratio(acc.units, acc.sessions),
    buyBox: acc.bbDen !== null && acc.bbDen > 0 && acc.bbNum !== null ? round6(acc.bbNum / acc.bbDen) : null,
    adSpend,
    adSales,
    acos: ratio(adSpend, adSales),
    tacos: ratio(adSpend, sales),
    acoas: null,
    asoas: null,
    cpc: null,
    adOrderShare: null,
  }
  if (canProfit) {
    const hasProfit = profit !== null && profit.rows > 0
    out.netSales = hasProfit && sales !== null ? round2(sales - profit.refunds) : null
    out.grossProfit = hasProfit && profit.profit !== null ? round2(profit.profit) : null
    out.margin = hasProfit ? marginOf(out.grossProfit, profit.revenue) : null
  }
  if (canProfit && canCost) {
    const cost = profit && profit.productCost !== null ? profit.productCost + (profit.firstMileCost ?? 0) + (profit.dutyCost ?? 0) : null
    out.roi = out.grossProfit !== null && out.grossProfit !== undefined ? ratio(out.grossProfit, cost) : null
  }
  return out
}

/** 涨跌：本期与上期都有数、上期不为 0 才有比例（分母取绝对值，上期为负时方向仍然对）。 */
export function changeOf(value: number | null | undefined, previous: number | null | undefined): number | null {
  if (value === null || value === undefined || previous === null || previous === undefined || previous === 0) return null
  return round6((value - previous) / Math.abs(previous))
}

export function cellsOf(current: Values, previous: Values | null, keys: readonly PpMetricKey[]): Partial<Record<PpMetricKey, PpCell>> {
  const cells: Partial<Record<PpMetricKey, PpCell>> = {}
  for (const key of keys) {
    const value = current[key] ?? null
    const before = previous ? (previous[key] ?? null) : null
    cells[key] = { value, previous: before, change: changeOf(value, before) }
  }
  return cells
}

/** 一行的内部形态（还没取整成对外的格子）：本期与上期的输入与指标值。 */
export interface CalcRow {
  id: string
  title: string
  current: Period
  previous: Period | null
  values: Values
  before: Values | null
}

export function calcRow(id: string, title: string, current: Period, previous: Period | null, canProfit: boolean, canCost: boolean): CalcRow {
  return { id, title, current, previous, values: valuesOf(current, canProfit, canCost), before: previous ? valuesOf(previous, canProfit, canCost) : null }
}

/** 合并 profit 合计（两边都没有 → null）。 */
function mergeProfit(a: Totals | null, b: Totals | null, merge: (x: Totals, y: Totals) => Totals): Totals | null {
  return a && b ? merge(a, b) : (a ?? b)
}
export const mergePeriod = (a: Period, b: Period, merge: (x: Totals, y: Totals) => Totals): Period => ({ acc: addAcc(a.acc, b.acc), profit: mergeProfit(a.profit, b.profit, merge) })

// ---- 排序与汇总 ----

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 排序：没有值的永远排在最后（不管升降序），并列按编号保证稳定。 */
export function sortRows(rows: readonly CalcRow[], field: string, direction: 'asc' | 'desc'): CalcRow[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (field === 'title') return sign * compareText(a.title, b.title) || compareText(a.id, b.id)
    const left = a.values[field as PpMetricKey] ?? null
    const right = b.values[field as PpMetricKey] ?? null
    if (left === null || right === null) return left === right ? compareText(a.id, b.id) : left === null ? 1 : -1
    return left === right ? compareText(a.id, b.id) : (left - right) * sign
  })
}

const sumOf = (rows: readonly CalcRow[], key: PpMetricKey): number | null => {
  let total: number | null = null
  for (const row of rows) {
    const value = row.values[key]
    if (value !== null && value !== undefined) total = (total ?? 0) + value
  }
  return total === null ? null : Math.round(total * 100) / 100
}

/** 汇总行：数量与金额是各行之和；比率用合计重算；没有任何行有值的指标是 null。 */
export function summarize(rows: readonly CalcRow[], canProfit: boolean, canCost: boolean): Values {
  let acc = emptyAcc()
  let revenue: number | null = null
  let cost: number | null = null
  let profitRows = 0
  for (const row of rows) {
    acc = addAcc(acc, row.current.acc)
    const p = row.current.profit
    // 利润率与 ROI 的分母只取“利润已算出”的行，和分子（各行毛利之和）口径一致
    if (p && p.rows > 0 && row.values.grossProfit !== null && row.values.grossProfit !== undefined) {
      profitRows += 1
      revenue = plus(revenue, p.revenue)
      if (p.productCost !== null) cost = plus(cost, p.productCost + (p.firstMileCost ?? 0) + (p.dutyCost ?? 0))
    }
  }
  const keys = ['units', 'orders', 'sales', 'b2bSales', 'sessions', 'pageViews', 'adSpend', 'adSales'] as const
  const out: Values = {}
  for (const key of keys) out[key] = sumOf(rows, key)
  out.avgPrice = out.units !== null && out.units !== undefined && out.units > 0 && out.sales !== null && out.sales !== undefined ? round2(out.sales / out.units) : null
  out.conversion = ratio(out.units ?? null, out.sessions ?? null)
  out.buyBox = acc.bbDen !== null && acc.bbDen > 0 && acc.bbNum !== null ? round6(acc.bbNum / acc.bbDen) : null
  out.acos = ratio(out.adSpend ?? null, out.adSales ?? null)
  out.tacos = ratio(out.adSpend ?? null, out.sales ?? null)
  out.acoas = null
  out.asoas = null
  out.cpc = null
  out.adOrderShare = null
  if (canProfit) {
    out.netSales = sumOf(rows, 'netSales')
    out.grossProfit = sumOf(rows, 'grossProfit')
    out.margin = profitRows > 0 && out.grossProfit !== null && out.grossProfit !== undefined ? marginOf(out.grossProfit, revenue) : null
  }
  if (canProfit && canCost) out.roi = out.grossProfit !== null && out.grossProfit !== undefined ? ratio(out.grossProfit, cost) : null
  return out
}

export const FAST_KEYS_SET: ReadonlySet<PpMetricKey> = new Set(PP_FAST_KEYS)
export const metricRequires = (key: PpMetricKey) => PP_METRICS[key].require
