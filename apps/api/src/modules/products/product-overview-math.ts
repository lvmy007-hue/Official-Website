import type { Asin360DailyPoint, Asin360KpiCard, Asin360OverviewResponse, Asin360TableRow, DashState } from '@nova/api-contracts'
import { attributionFactors, changeRatio, nullableSum, pointsChange, safeDivide } from '../overview'

// ASIN 360“经营表现”页签的纯计算（不访问数据库）。约定与经营控制台一致：
// 可空的列（会话、广告、利润）整段都没有数据时合计为 null，页面显示“尚未接入”，永远不当 0。

export const NOTE_PROFIT = '净利润来自利润日表，利润计算在阶段 2b（P2b-09）交付，目前尚未接入'
export const NOTE_ADS = '广告数据同步在阶段 3 交付，目前尚未接入'
export const NOTE_SESSIONS = '会话数据来自业务报告，同步在阶段 4（P4-01）交付，目前尚未接入'
export const NOTE_FORBIDDEN = '需要“利润”字段权限（财务相关角色）才能查看'
export const NOTE_NO_SALES = '所选范围内没有这个商品的订单记录（可能该时段没有销售，也可能还没同步）'
export const NOTE_REFUNDS = '按商品的退款来自退货与财务交易，在阶段 2b（P2b-02、P2b-17）交付，目前尚未接入'

/** 一天（或一段时间的合计）的取值；null 表示来源没有接入或没有数据。 */
export interface ProductDay {
  units: number
  sales: number
  sessions: number | null
  adsSpend: number | null
  adsSales: number | null
  profit: number | null
}

export const sumProductDays = (days: readonly ProductDay[]): ProductDay => ({
  units: days.reduce((total, day) => total + day.units, 0),
  sales: days.reduce((total, day) => total + day.sales, 0),
  sessions: nullableSum(days.map(day => day.sessions)),
  adsSpend: nullableSum(days.map(day => day.adsSpend)),
  adsSales: nullableSum(days.map(day => day.adsSales)),
  profit: nullableSum(days.map(day => day.profit)),
})

const absent = (state: DashState, note: string) => ({ state, value: null, compareValue: null, change: null, changeKind: 'ratio' as const, note })

export interface CardInput {
  current: ProductDay
  hasCurrent: boolean
  /** 选中的对比期合计；没有对比期为 null。 */
  compare: ProductDay | null
  hasCompare: boolean
  canSeeProfit: boolean
}

export function buildCards(input: CardInput): Asin360KpiCard[] {
  const { current } = input
  const compare = input.compare && input.hasCompare ? input.compare : null
  const card = (key: Asin360KpiCard['key'], label: string, format: Asin360KpiCard['format'], body: Omit<Asin360KpiCard, 'key' | 'label' | 'format'>): Asin360KpiCard => ({
    key,
    label,
    format,
    ...body,
  })

  const sales = input.hasCurrent
    ? {
        state: 'OK' as const,
        value: current.sales,
        compareValue: compare?.sales ?? null,
        change: compare ? changeRatio(current.sales, compare.sales) : null,
        changeKind: 'ratio' as const,
        note: input.compare && !input.hasCompare ? '对比期没有这个商品的订单记录，无法计算变化' : null,
      }
    : absent('NO_DATA', NOTE_NO_SALES)

  const profitReady = input.canSeeProfit && current.profit !== null
  const profit = !input.canSeeProfit
    ? absent('RESTRICTED', NOTE_FORBIDDEN)
    : current.profit === null
      ? absent('NOT_CONNECTED', NOTE_PROFIT)
      : {
          state: 'OK' as const,
          value: current.profit,
          compareValue: compare?.profit ?? null,
          change: compare ? changeRatio(current.profit, compare.profit) : null,
          changeKind: 'ratio' as const,
          note: null,
        }

  const margin = !input.canSeeProfit
    ? absent('RESTRICTED', NOTE_FORBIDDEN)
    : !profitReady
      ? absent('NOT_CONNECTED', '利润率 = 净利润 ÷ 销售额，需要净利润先接入')
      : {
          state: 'OK' as const,
          value: safeDivide(current.profit, current.sales),
          compareValue: compare ? safeDivide(compare.profit, compare.sales) : null,
          change: compare ? pointsChange(safeDivide(current.profit, current.sales), safeDivide(compare.profit, compare.sales)) : null,
          changeKind: 'points' as const,
          note: safeDivide(current.profit, current.sales) === null ? '销售额为 0，无法计算利润率' : null,
        }

  const conversionOf = (day: ProductDay) => safeDivide(day.sessions === null ? null : day.units, day.sessions)
  const conversion =
    current.sessions === null
      ? absent('NOT_CONNECTED', NOTE_SESSIONS)
      : {
          state: 'OK' as const,
          value: conversionOf(current),
          compareValue: compare ? conversionOf(compare) : null,
          change: compare ? pointsChange(conversionOf(current), conversionOf(compare)) : null,
          changeKind: 'points' as const,
          note: conversionOf(current) === null ? '会话为 0，无法计算转化率' : null,
        }

  const shareOf = (day: ProductDay) => safeDivide(day.adsSpend, day.sales)
  const adsShare =
    current.adsSpend === null
      ? absent('NOT_CONNECTED', NOTE_ADS)
      : {
          state: 'OK' as const,
          value: shareOf(current),
          compareValue: compare ? shareOf(compare) : null,
          change: compare ? pointsChange(shareOf(current), shareOf(compare)) : null,
          changeKind: 'points' as const,
          note: shareOf(current) === null ? '销售额为 0，无法计算广告占比' : null,
        }

  return [
    card('sales', '销售额', 'money', sales),
    card('profit', '净利润', 'money', profit),
    card('margin', '利润率', 'percent', margin),
    card('conversion', '转化率（件数 ÷ 会话）', 'percent', conversion),
    card('adsShare', '广告占总销售比（广告花费 ÷ 销售额）', 'percent', adsShare),
  ]
}

export interface Windowed {
  value: ProductDay
  has: boolean
}
const TABLE_ROWS: ReadonlyArray<{ key: Asin360TableRow['key']; label: string; format: Asin360TableRow['format']; read: (day: ProductDay) => number | null }> = [
  { key: 'sales', label: '销售额', format: 'money', read: day => day.sales },
  { key: 'units', label: '销售件数', format: 'number', read: day => day.units },
  { key: 'unitPrice', label: '件单价', format: 'money', read: day => (day.units > 0 ? day.sales / day.units : null) },
]

/** 同比、环比表：没有记录的时段取值为 null（与“0 件”区分），变化比率对比期为 0 时为 null。 */
export function buildTable(current: Windowed, previous: Windowed, yoy: Windowed): Asin360TableRow[] {
  return TABLE_ROWS.map(({ key, label, format, read }) => {
    const now = current.has ? read(current.value) : null
    const before = previous.has ? read(previous.value) : null
    const year = yoy.has ? read(yoy.value) : null
    return { key, label, format, current: now, previous: before, yoy: year, momChange: changeRatio(now, before), yoyChange: changeRatio(now, year) }
  })
}

export function buildSplit(current: ProductDay, hasCurrent: boolean, canSeeAds = true): Asin360OverviewResponse['split'] {
  if (!canSeeAds || current.adsSales === null) return { state: 'NOT_CONNECTED', note: NOTE_ADS, adsSales: null, organicSales: null, adsShare: null }
  if (!hasCurrent) return { state: 'NO_DATA', note: NOTE_NO_SALES, adsSales: current.adsSales, organicSales: null, adsShare: null }
  const organic = current.sales - current.adsSales
  if (organic < 0)
    return {
      state: 'OK',
      note: '广告归因销售额超过订单销售额（两者的归因口径不同），无法拆出自然销售',
      adsSales: current.adsSales,
      organicSales: null,
      adsShare: safeDivide(current.adsSales, current.sales),
    }
  return { state: 'OK', note: null, adsSales: current.adsSales, organicSales: organic, adsShare: safeDivide(current.adsSales, current.sales) }
}

export function buildProfit(daily: readonly Asin360DailyPoint[], canSeeProfit: boolean): Asin360OverviewResponse['profit'] {
  if (!canSeeProfit) return { state: 'RESTRICTED', note: NOTE_FORBIDDEN }
  if (daily.every(day => day.profit === null)) return { state: 'NOT_CONNECTED', note: NOTE_PROFIT }
  return { state: 'OK', note: null }
}

/** 销售额变化归因：件数 × 件单价（会话接入后自动变成会话 × 转化率 × 件单价）。没有对比期或任一期没有记录返回 null。 */
export function buildAttribution(current: ProductDay, compare: ProductDay | null, hasBoth: boolean): Asin360OverviewResponse['attribution'] {
  if (!compare || !hasBoth) return null
  return attributionFactors(current, compare)
}
