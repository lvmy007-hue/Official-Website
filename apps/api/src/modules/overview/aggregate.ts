import type { AttributionFactor, DashGranularity, TrendPoint, VolatilityRow, WaterfallItem, WeekStartDay } from '@nova/api-contracts'
import { bucketKey } from './period'

// 经营控制台的纯计算（不访问数据库）：合计、变化、分桶、归因因子、瀑布拆解。
// 约定：可空的列（广告、利润、会话）整段都没有数据时合计为 null，而不是 0。

export interface DayValues {
  orders: number
  units: number
  sales: number
  refund: number
  fee: number
  adsSpend: number | null
  adsSales: number | null
  profit: number | null
  sessions: number | null
}

export const ZERO_DAY: DayValues = { orders: 0, units: 0, sales: 0, refund: 0, fee: 0, adsSpend: null, adsSales: null, profit: null, sessions: null }

/** 可空值求和：全部为空返回 null。 */
export function nullableSum(values: ReadonlyArray<number | null | undefined>): number | null {
  let total: number | null = null
  for (const value of values) if (value !== null && value !== undefined) total = (total ?? 0) + value
  return total
}

export function sumDays(days: readonly DayValues[]): DayValues {
  return {
    orders: days.reduce((total, day) => total + day.orders, 0),
    units: days.reduce((total, day) => total + day.units, 0),
    sales: days.reduce((total, day) => total + day.sales, 0),
    refund: days.reduce((total, day) => total + day.refund, 0),
    fee: days.reduce((total, day) => total + day.fee, 0),
    adsSpend: nullableSum(days.map(day => day.adsSpend)),
    adsSales: nullableSum(days.map(day => day.adsSales)),
    profit: nullableSum(days.map(day => day.profit)),
    sessions: nullableSum(days.map(day => day.sessions)),
  }
}

/** 变化比率；对比期为 0 或缺失时无法计算，返回 null（不编造“无穷大”）。 */
export function changeRatio(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null
  return (current - previous) / Math.abs(previous)
}

export const safeDivide = (numerator: number | null, denominator: number | null): number | null => (numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator)

/** 百分点差（用于利润率、广告占比这类本身就是比率的指标）；任一方缺失为 null。 */
export const pointsChange = (current: number | null, previous: number | null): number | null => (current === null || previous === null ? null : current - previous)

/** 本期逐日走势：缺失的日子取 pick 返回的值（可空列保持 null）。 */
export function dailySeries(days: readonly string[], byDate: ReadonlyMap<string, DayValues>, pick: (day: DayValues) => number | null, missing: number | null): Array<number | null> {
  return days.map(date => {
    const row = byDate.get(date)
    return row ? pick(row) : missing
  })
}

/**
 * 分桶：把逐日值按日、周、月合并。bucketOf 取当前期的日期决定分桶；
 * other 给出另一个期（环比、同比）的逐日值，按位置对齐到本期的桶（第 i 天对第 i 天）。
 */
export function bucketize(currentDays: readonly string[], values: ReadonlyArray<number | null>, granularity: DashGranularity, weekDay: WeekStartDay = 'MON'): TrendPoint[] {
  const order: string[] = []
  const sums = new Map<string, number | null>()
  currentDays.forEach((date, index) => {
    const key = bucketKey(date, granularity, weekDay)
    if (!sums.has(key)) {
      order.push(key)
      sums.set(key, null)
    }
    const value = values[index]
    if (value !== null && value !== undefined) sums.set(key, (sums.get(key) ?? 0) + value)
  })
  return order.map(key => ({ key, value: sums.get(key) ?? null }))
}

/** 归因因子：会话、转化率（件数 ÷ 会话）、件单价（销售额 ÷ 件数）；会话缺失时退化为 件数 × 件单价。 */
export function attributionFactors(
  current: Pick<DayValues, 'units' | 'sales' | 'sessions'>,
  previous: Pick<DayValues, 'units' | 'sales' | 'sessions'>,
): { mode: 'THREE_FACTOR' | 'TWO_FACTOR'; factors: AttributionFactor[]; unavailable: Array<{ key: string; label: string; reason: string }> } {
  const unitPrice = (value: Pick<DayValues, 'units' | 'sales'>) => (value.units > 0 ? value.sales / value.units : 0)
  const priceFactor: AttributionFactor = { key: 'unitPrice', label: '件单价', before: unitPrice(previous), after: unitPrice(current) }
  if (current.sessions !== null && previous.sessions !== null && current.sessions > 0 && previous.sessions > 0) {
    return {
      mode: 'THREE_FACTOR',
      factors: [
        { key: 'sessions', label: '会话', before: previous.sessions, after: current.sessions },
        { key: 'conversion', label: '转化率（件数 ÷ 会话）', before: previous.units / previous.sessions, after: current.units / current.sessions },
        priceFactor,
      ],
      unavailable: [],
    }
  }
  const reason = '会话数据尚未接入（业务报告同步随 P4-01 交付），暂时无法把件数再拆成“会话 × 转化率”'
  return {
    mode: 'TWO_FACTOR',
    factors: [{ key: 'units', label: '件数', before: previous.units, after: current.units }, priceFactor],
    unavailable: [
      { key: 'sessions', label: '会话', reason },
      { key: 'conversion', label: '转化率', reason },
    ],
  }
}

export interface AsinPeriodSales {
  asin: string
  current: number
  previous: number
}

/**
 * 增长归因瀑布（按驱动因素）：
 *   新品（本期有销售、此前从未出现在汇总里的 ASIN） + 增长最多与下滑最多的老 ASIN + 其余老 ASIN + 未归属 ASIN 的销售额变化 = 总变化。
 * totalChange 是店铺汇总的总变化；asinTotalChange 是 ASIN 汇总的总变化（不受候选数量限制）；两者之差是没有 ASIN 的订单行（未归属）。
 */
export function driverWaterfall(input: { totalChange: number; asinTotalChange: number; candidates: readonly AsinPeriodSales[]; newAsins: ReadonlySet<string>; topCount: number }): WaterfallItem[] {
  const fresh = input.candidates.filter(item => input.newAsins.has(item.asin))
  const old = input.candidates.filter(item => !input.newAsins.has(item.asin)).map(item => ({ ...item, delta: item.current - item.previous }))
  const rising = old
    .filter(item => item.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, input.topCount)
  const falling = old
    .filter(item => item.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, input.topCount)
  const listed = [...rising, ...falling]
  const newTotal = fresh.reduce((total, item) => total + (item.current - item.previous), 0)
  const listedTotal = listed.reduce((total, item) => total + item.delta, 0)
  const items: WaterfallItem[] = listed.map(item => ({ key: `asin:${item.asin}`, label: item.asin, amount: item.delta, kind: 'asin' }))
  items.push({ key: 'new', label: '新品', amount: newTotal, kind: 'new', note: '本期有销售、此前汇总里没有出现过的 ASIN' })
  items.push({
    key: 'stockout',
    label: '断货损失',
    amount: null,
    kind: 'stockout',
    estimate: true,
    note: '模型估算（断货天数 × 断货前日均销量）；库存日快照尚未接入，暂无法估算（随 P2a-05、P2a-06）',
  })
  items.push({ key: 'other', label: '其余 ASIN', amount: input.asinTotalChange - newTotal - listedTotal, kind: 'other' })
  items.push({ key: 'unattributed', label: '未归属 ASIN', amount: input.totalChange - input.asinTotalChange, kind: 'unattributed', note: '订单行没有 ASIN，只计入店铺汇总' })
  return items
}

export function storeWaterfall(stores: ReadonlyArray<{ storeId: string; storeName: string; current: number; previous: number }>): WaterfallItem[] {
  return stores
    .map(store => ({ key: `store:${store.storeId}`, label: store.storeName, amount: store.current - store.previous, kind: 'store' as const }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
}

export interface AsinThreePeriod {
  asin: string
  sku: string | null
  current: number
  previous: number
  earlier: number
}

/**
 * 波动异常（三期对比）：销售额连续两期下降（上上期 > 上期 > 本期，且上上期有销售）的 ASIN，
 * 按两期累计下降金额从大到小排，同额按 ASIN 排序；只取前 limit 个。
 */
export function consecutiveDecliners(items: readonly AsinThreePeriod[], limit: number): VolatilityRow[] {
  return items
    .filter(item => item.earlier > 0 && item.earlier > item.previous && item.previous > item.current)
    .map(item => ({
      asin: item.asin,
      sku: item.sku,
      sales: item.current,
      previousSales: item.previous,
      earlierSales: item.earlier,
      salesChange: changeRatio(item.current, item.previous) ?? 0,
      previousChange: changeRatio(item.previous, item.earlier) ?? 0,
      totalDrop: item.earlier - item.current,
    }))
    .sort((a, b) => b.totalDrop - a.totalDrop || a.asin.localeCompare(b.asin))
    .slice(0, limit)
}
