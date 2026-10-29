import { SNS_FORECAST_MAX_AGE_DAYS, type InventoryDemand, type TransportMode, type TransportPreference } from '@nova/api-contracts'
import { daysBetween } from '../inventory'

// 补货计算链用到的纯数学（06 章 6.2）：服务水平系数、需求波动、订阅省与趋势调整、取整、运输方式拆分。不读数据库。

export const round1 = (value: number) => Math.round(value * 10) / 10
export const round2 = (value: number) => Math.round(value * 100) / 100
export const round3 = (value: number) => Math.round(value * 1000) / 1000
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** 标准正态分布的分位数（Acklam 有理逼近，误差约 1e-9）：服务水平 95% 对应约 1.645。 */
export function zScore(probability: number): number {
  if (!(probability > 0 && probability < 1)) throw new RangeError('服务水平必须在 0 与 1 之间')
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (probability > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - probability))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = probability - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

export function stddev(values: readonly number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length)
}

/**
 * 近 90 天四个时段的日均销量（近 7 天、8–30 天、31–60 天、61–90 天），用来估算需求波动。
 * 历史不足的时段不算；少于 3 个时段时返回 null（波动无法估计，统计安全库存按 0 处理，只剩策略设定的下限）。
 */
export function periodRates(demand: Pick<InventoryDemand, 'source' | 'units7' | 'units30' | 'units60' | 'units90' | 'historyDays'>): number[] | null {
  const history = demand.historyDays ?? (demand.source === 'AMAZON_REPORT' ? 90 : 0)
  const { units7: u7, units30: u30, units60: u60, units90: u90 } = demand
  const rates: number[] = []
  if (u7 !== null && history >= 7) rates.push(u7 / 7)
  if (u7 !== null && u30 !== null && history >= 30) rates.push(Math.max(0, u30 - u7) / 23)
  if (u30 !== null && u60 !== null && history >= 60) rates.push(Math.max(0, u60 - u30) / 30)
  if (u60 !== null && u90 !== null && history >= 90) rates.push(Math.max(0, u90 - u60) / 30)
  return rates.length >= 3 ? rates : null
}

/** 订阅省输入：官方的未来 30 天订阅出货预测与上一个完整自然月的订阅出货件数。 */
export interface SubscribeInput {
  forecastNext30: number | null
  shippedUnitsPrevMonth: number | null
  prevMonthDays: number | null
  snapshotDate: string
  eligibility: string | null
}

// 订阅省页面（P4-06）用同一个天数判断“报价快照是否过期”，常量放契约里，两边不会各改各的。
export const SUBSCRIBE_MAX_AGE_DAYS = SNS_FORECAST_MAX_AGE_DAYS

export interface AdjustedDemand {
  low: number
  mid: number
  high: number
  trendFactor: number
  subscribe: { used: boolean; subRate: number | null; histRate: number | null }
  notes: string[]
}

/**
 * 第 1 步：在历史日销（低、中、高）上叠加订阅省与趋势。
 * - 订阅省：历史销量里已包含上个月的订阅出货，所以先扣掉“上月订阅日均”，再加上官方“未来 30 天订阅日均”，避免重复计算；
 *   缺少上月订阅出货或预测、快照超过 7 天、报价不可售时不叠加，并写明原因；
 * - 趋势：近 7 天日均 ÷ 近 30 天日均 = 比值，调整系数 = 1 + 0.5 ×（比值 − 1），限制在 0.8–1.25，只在订单历史满 30 天时使用；
 * - 季节性：亚马逊规划报告只给“是否季节性”，没有系数，不做数值调整；促销日历尚未接入，同样不调整（页面明说）。
 */
export function adjustDemand(demand: InventoryDemand, subscribe: SubscribeInput | null, today: string): AdjustedDemand | null {
  if (demand.low === null || demand.mid === null || demand.high === null) return null
  const notes: string[] = []
  let factor = 1
  if (demand.source === 'ORDERS' && (demand.historyDays ?? 0) >= 30 && demand.units7 !== null && demand.units30 !== null && demand.units30 > 0) {
    const ratio = demand.units7 / 7 / (demand.units30 / 30)
    factor = round3(clamp(1 + 0.5 * (ratio - 1), 0.8, 1.25))
    notes.push(`趋势：近 7 天日均 ÷ 近 30 天日均 = ${round2(ratio)}，调整系数 ${factor}`)
  } else {
    notes.push('趋势：订单历史不足 30 天或没有近期销量，不做趋势调整')
  }
  let used = false
  let subRate: number | null = null
  let histRate: number | null = null
  if (!subscribe) {
    notes.push('订阅省：尚无订阅省数据（未同步或未参与），不叠加')
  } else if (daysBetween(subscribe.snapshotDate, today) > SUBSCRIBE_MAX_AGE_DAYS) {
    notes.push(`订阅省：数据日期 ${subscribe.snapshotDate} 已超过 ${SUBSCRIBE_MAX_AGE_DAYS} 天，不叠加`)
  } else if (subscribe.eligibility === 'INELIGIBLE' || subscribe.eligibility === 'SUSPENDED') {
    notes.push('订阅省：报价当前不可订阅，不叠加')
  } else if (subscribe.forecastNext30 === null) {
    notes.push('订阅省：官方没有给出未来 30 天订阅出货预测，不叠加')
  } else if (subscribe.shippedUnitsPrevMonth === null || !subscribe.prevMonthDays) {
    notes.push('订阅省：缺少上月订阅出货件数，无法从历史销量里扣除订阅部分，为避免重复计算不叠加')
  } else {
    used = true
    subRate = subscribe.forecastNext30 / 30
    histRate = subscribe.shippedUnitsPrevMonth / subscribe.prevMonthDays
    notes.push(`订阅省：未来 30 天预计出货 ${subscribe.forecastNext30} 件（日均 ${round2(subRate)}），已扣除历史销量中的上月订阅日均 ${round2(histRate)}`)
  }
  const apply = (rate: number) => round3(Math.max(0, rate - (histRate ?? 0)) * factor + (subRate ?? 0))
  return { low: apply(demand.low), mid: apply(demand.mid), high: apply(demand.high), trendFactor: factor, subscribe: { used, subRate, histRate }, notes }
}

/** 按箱规向上取整；没有箱规时取整到件。 */
export const roundUpTo = (qty: number, unit: number | null) => (qty <= 0 ? 0 : unit && unit > 1 ? Math.ceil(qty / unit) * unit : Math.ceil(qty))

export interface ModeLead {
  mode: TransportMode
  leadDays: number
  unitCost: number | null
}

export interface SplitPart {
  mode: TransportMode
  qty: number
}

export interface SplitResult {
  parts: SplitPart[]
  note: string
}

/**
 * 第 7 步：运输方式拆分。目标是总到仓成本最低且不断货：
 * - 偏好固定方式：全部走该方式；只有一种方式：全部走它；
 * - 自动：任一方式没设成本就无法比较，全部走时效最快的；
 * - 成本都有：最便宜的方式若在预计断货日前到仓，全部走它；否则用“更快且成本最低的方式”补上断货前的缺口（缺口 = 日销 ×（主方式到仓天数 − max(断货天数, 补位方式到仓天数））），其余走最便宜的方式；
 *   没有任何方式能在断货前到仓时，补位方式取最快的，残余断货天数在发运批次的“晚到天数”里如实显示。
 */
export function splitTransport(args: { qty: number; coverDays: number; mid: number; modes: readonly ModeLead[]; preference: TransportPreference; casePack: number | null }): SplitResult {
  const { qty, mid, casePack } = args
  const cover = Math.max(0, args.coverDays)
  const modes = [...args.modes].sort((a, b) => a.leadDays - b.leadDays)
  if (qty <= 0 || modes.length === 0) return { parts: [], note: '没有需要运输的数量或运输选项' }
  const all = (mode: ModeLead, note: string): SplitResult => ({ parts: [{ mode: mode.mode, qty }], note })
  if (modes.length === 1) return all(modes[0], '只设置了一种运输方式，全部走该方式')
  if (args.preference !== 'AUTO') {
    const preferred = modes.find(mode => mode.mode === args.preference)
    if (preferred) return all(preferred, '策略指定了运输方式，全部走该方式（不做成本与断货风险比较）')
  }
  if (modes.some(mode => mode.unitCost === null)) return all(modes[0], '有运输方式没有设置每件成本，无法比较总到仓成本，按时效最快的方式全部发运')
  const cheapest = [...modes].sort((a, b) => (a.unitCost as number) - (b.unitCost as number) || a.leadDays - b.leadDays)[0]
  if (cheapest.leadDays <= cover) return all(cheapest, `成本最低的方式（${cheapest.mode}）在预计断货日前到仓，全部走该方式`)
  const faster = modes.filter(mode => mode.leadDays < cheapest.leadDays)
  if (faster.length === 0) return all(cheapest, '成本最低的方式同时也是最快的，全部走该方式')
  const inTime = faster.filter(mode => mode.leadDays <= cover).sort((a, b) => (a.unitCost as number) - (b.unitCost as number))
  const bridge = inTime[0] ?? faster[0]
  const gapUnits = Math.ceil(mid * (cheapest.leadDays - Math.max(cover, bridge.leadDays)))
  const bridgeQty = Math.min(qty, roundUpTo(Math.max(0, gapUnits), casePack))
  if (bridgeQty <= 0) return all(cheapest, '补位数量为 0，全部走成本最低的方式')
  const note = `成本最低的方式（${cheapest.mode}）晚于预计断货日到仓，先用${bridge.mode}补 ${bridgeQty} 件覆盖断货前后的缺口，其余走${cheapest.mode}${inTime[0] ? '' : '；补位方式也来不及断货前到仓'}`
  return { parts: [{ mode: bridge.mode, qty: bridgeQty }, ...(qty - bridgeQty > 0 ? [{ mode: cheapest.mode, qty: qty - bridgeQty }] : [])], note }
}
