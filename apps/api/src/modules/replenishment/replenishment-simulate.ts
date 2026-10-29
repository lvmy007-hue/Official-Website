import { SIM_HORIZON_DAYS, type SimPoint, type StockoutRange, type TrendSimulation } from '@nova/api-contracts'
import { plusDays } from '../inventory'
import { round1 } from './replenishment-math'

// 库存走势模拟（06 章 6.2“模拟”）：未来 90 天，三条曲线——不补货、按建议补货、自定义补货；按日扣减需求，库存见底后的需求算缺口（不累计成欠账）。
// 需求取补货计算链第 1 步的日销（中档），全程不变；在途数量没有预计到仓日，按假设天数一次性到达，假设写进 assumptions。

export interface Arrival {
  day: number
  qty: number
}

interface CurveInput {
  start: number
  arrivals: readonly Arrival[]
  rate: number
}

function run({ start, arrivals, rate }: CurveInput, today: string) {
  const stock: number[] = [start]
  const shortage: number[] = [0]
  let level = start
  for (let day = 1; day <= SIM_HORIZON_DAYS; day += 1) {
    level += arrivals.filter(arrival => arrival.day === day).reduce((total, arrival) => total + arrival.qty, 0)
    const sold = Math.min(level, rate)
    shortage.push(rate - sold)
    level -= sold
    stock.push(level)
  }
  // 连续缺货日合并成一段
  const ranges: StockoutRange[] = []
  const last = () => ranges[ranges.length - 1]
  const acc: number[] = []
  for (let day = 1; day <= SIM_HORIZON_DAYS; day += 1) {
    if (shortage[day] <= 1e-9) continue
    const from = plusDays(today, day)
    if (ranges.length > 0 && last().to === plusDays(today, day - 1)) {
      last().to = from
      last().days += 1
      acc[acc.length - 1] += shortage[day]
    } else {
      ranges.push({ from, to: from, days: 1, shortage: 0 })
      acc.push(shortage[day])
    }
    last().shortage = Math.round(acc[acc.length - 1])
  }
  return { stock, ranges }
}

export interface TrendInput {
  today: string
  sellable: number
  inboundCounted: number
  inboundArrivalDays: number
  /** 补货计算链第 1 步的日销（中档）；null 表示没有销量记录。 */
  dailyDemand: number | null
  /** 按建议补货：各发运批次的到仓天数与数量（建议量为 0 或无法计算时为空）。 */
  recommended: readonly Arrival[]
  recommendedNote: string | null
  custom: Arrival | null
}

export function simulateTrend(input: TrendInput): TrendSimulation {
  const assumptions = [
    `在途 ${input.inboundCounted} 件没有预计到仓日，按 ${input.inboundArrivalDays} 天后一次性到仓可售计算`,
    '日销取补货计算链第 1 步的中档预测，未来 90 天保持不变（不含促销与季节波动）',
    '库存见底后的需求计为缺口，不累计成欠账；补货到仓当天即可售',
  ]
  if (input.dailyDemand === null) {
    return { kind: 'TREND', state: 'NO_DATA', note: '没有销量记录，无法模拟库存走势', points: [], stockouts: { none: [], recommended: [], custom: [] }, assumptions, dailyDemand: null }
  }
  const base: Arrival[] = input.inboundCounted > 0 ? [{ day: input.inboundArrivalDays, qty: input.inboundCounted }] : []
  const curve = (extra: readonly Arrival[]) =>
    run({ start: input.sellable, arrivals: [...base, ...extra.filter(arrival => arrival.day <= SIM_HORIZON_DAYS)], rate: input.dailyDemand as number }, input.today)
  const none = curve([])
  const recommended = input.recommended.length > 0 ? curve(input.recommended) : null
  const custom = input.custom ? curve([input.custom]) : null
  const points: SimPoint[] = Array.from({ length: SIM_HORIZON_DAYS + 1 }, (_, day) => ({
    day,
    date: plusDays(input.today, day),
    none: round1(none.stock[day]),
    recommended: recommended ? round1(recommended.stock[day]) : null,
    custom: custom ? round1(custom.stock[day]) : null,
  }))
  return {
    kind: 'TREND',
    state: 'OK',
    note: recommended ? null : (input.recommendedNote ?? '当前没有可执行的补货建议，只显示不补货曲线'),
    points,
    stockouts: { none: none.ranges, recommended: recommended?.ranges ?? [], custom: custom?.ranges ?? [] },
    assumptions,
    dailyDemand: input.dailyDemand,
  }
}
