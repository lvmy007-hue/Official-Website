import type { Asin360CompareMetric, Asin360CompareRow } from '@nova/api-contracts'
import { changeRatio, safeDivide } from '../overview'
import { NOTE_ADS, NOTE_FORBIDDEN, NOTE_NO_SALES, NOTE_PROFIT, NOTE_SESSIONS, type ProductDay } from './product-overview-math'

// ASIN 360 同环比明细（P6-21）的纯计算：同一组指标算本期与对比期，输出通用结构 {metric, value, prevValue, changeRate, changeValue}。
// 约定与经营表现一致：来源没有接入的列是 null（不是 0）；分母为 0 的比率是 null。

interface Spec {
  metric: Asin360CompareMetric
  label: string
  format: Asin360CompareRow['format']
  /** 取值；null 表示这一天（合计）没有这项数据。 */
  pick: (day: ProductDay) => number | null
  /** 取不到值时的原因：来源没接入，或比率的分母为 0。 */
  missing: { state: Asin360CompareRow['state']; note: string }
  needsProfit?: boolean
}

const SPECS: readonly Spec[] = [
  { metric: 'sales', label: '销售额', format: 'money', pick: day => day.sales, missing: { state: 'NO_DATA', note: NOTE_NO_SALES } },
  { metric: 'units', label: '销量（件）', format: 'number', pick: day => day.units, missing: { state: 'NO_DATA', note: NOTE_NO_SALES } },
  { metric: 'unitPrice', label: '件单价', format: 'money', pick: day => safeDivide(day.sales, day.units), missing: { state: 'NO_DATA', note: '件数为 0，无法计算件单价' } },
  { metric: 'sessions', label: '会话数', format: 'number', pick: day => day.sessions, missing: { state: 'NOT_CONNECTED', note: NOTE_SESSIONS } },
  {
    metric: 'conversion',
    label: '转化率（件数 ÷ 会话）',
    format: 'percent',
    pick: day => safeDivide(day.sessions === null ? null : day.units, day.sessions),
    missing: { state: 'NOT_CONNECTED', note: NOTE_SESSIONS },
  },
  { metric: 'adsSpend', label: '广告花费', format: 'money', pick: day => day.adsSpend, missing: { state: 'NOT_CONNECTED', note: NOTE_ADS } },
  { metric: 'adsSales', label: '广告销售额', format: 'money', pick: day => day.adsSales, missing: { state: 'NOT_CONNECTED', note: NOTE_ADS } },
  { metric: 'profit', label: '净利润', format: 'money', pick: day => day.profit, missing: { state: 'NOT_CONNECTED', note: NOTE_PROFIT }, needsProfit: true },
  {
    metric: 'margin',
    label: '利润率',
    format: 'percent',
    pick: day => safeDivide(day.profit, day.sales),
    missing: { state: 'NOT_CONNECTED', note: '利润率 = 净利润 ÷ 销售额，需要净利润先接入' },
    needsProfit: true,
  },
]

export interface CompareWindowInput {
  total: ProductDay
  has: boolean
}

export interface CompareInput {
  current: CompareWindowInput
  /** 没有选对比期为 null。 */
  previous: CompareWindowInput | null
  canSeeProfit: boolean
}

export function buildCompareRows(input: CompareInput): Asin360CompareRow[] {
  const { current, previous, canSeeProfit } = input
  return SPECS.map((spec): Asin360CompareRow => {
    const base = { metric: spec.metric, label: spec.label, format: spec.format }
    if (spec.needsProfit && !canSeeProfit) return { ...base, value: null, prevValue: null, changeRate: null, changeValue: null, state: 'RESTRICTED', note: NOTE_FORBIDDEN }
    const value = current.has ? spec.pick(current.total) : null
    const prevValue = previous && previous.has ? spec.pick(previous.total) : null
    if (value === null) {
      // 本期没有订单记录：销售类整体 NO_DATA；其余列按来源是否接入判断
      const state = !current.has ? 'NO_DATA' : spec.missing.state
      return { ...base, value: null, prevValue, changeRate: null, changeValue: null, state, note: !current.has ? NOTE_NO_SALES : spec.missing.note }
    }
    const changeValue = prevValue === null ? null : value - prevValue
    const note = previous && prevValue === null ? '对比期没有这项记录，无法计算变化' : null
    return { ...base, value, prevValue, changeRate: changeRatio(value, prevValue), changeValue, state: 'OK', note }
  })
}
