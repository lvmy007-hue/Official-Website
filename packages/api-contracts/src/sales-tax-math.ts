import { addDaysText, daysBetweenText, roundCash } from './cashflow-math.js'
import { DEFAULT_TAX_KIND, SALES_TAX_MONTHS_MAX, SALES_TAX_TOLERANCE_ABS, SALES_TAX_TOLERANCE_RATIO, type SalesTaxReconState } from './sales-tax.js'

// 销售税纯函数（P2b-12）：按月切时间窗、报告与订单合计对账、报告里州与税种文字的整理。日期都是 YYYY-MM-DD 文本，不用 Date 做日历运算。

export interface TaxWindow {
  /** YYYY-MM */
  month: string
  from: string
  to: string
}

const monthOf = (day: string) => day.slice(0, 7)
const lastDayOfMonth = (month: string) => {
  const [year, mon] = month.split('-').map(Number)
  return new Date(Date.UTC(year!, mon!, 0)).toISOString().slice(0, 10)
}

/**
 * 把 [from, to] 切成按月的时间窗（首尾月不满月就只取范围内的部分）。
 * 范围超过 maxMonths 个月时只保留最近 maxMonths 个月（起点收窄到那个月的范围内第一天），clamped 为 true。
 */
export function taxWindowsOf(from: string, to: string, maxMonths: number = SALES_TAX_MONTHS_MAX): { windows: TaxWindow[]; clamped: boolean } {
  if (daysBetweenText(from, to) < 0) return { windows: [], clamped: false }
  const windows: TaxWindow[] = []
  let cursor = from
  while (daysBetweenText(cursor, to) >= 0) {
    const month = monthOf(cursor)
    const end = lastDayOfMonth(month) < to ? lastDayOfMonth(month) : to
    windows.push({ month, from: cursor, to: end })
    cursor = addDaysText(end, 1)
  }
  if (windows.length <= maxMonths) return { windows, clamped: false }
  return { windows: windows.slice(windows.length - maxMonths), clamped: true }
}

/** 一致的容差：max(0.05, 0.1% × 较大的一边)。 */
export const taxTolerance = (a: number, b: number) => Math.max(SALES_TAX_TOLERANCE_ABS, SALES_TAX_TOLERANCE_RATIO * Math.max(Math.abs(a), Math.abs(b)))

/**
 * 报告合计对订单接口合计。null 表示“这一边没有任何记录”（不是 0）：
 * 两边都没有 → null（这个月不列）；只有一边 → 报告没有 / 订单没有；两边都有 → 一致或有差异（diff = 报告 − 订单）。
 */
export function reconcileTax(reportTax: number | null, ordersTax: number | null): { state: SalesTaxReconState; diff: number | null } | null {
  if (reportTax === null && ordersTax === null) return null
  if (reportTax === null) return { state: 'NO_REPORT', diff: null }
  if (ordersTax === null) return { state: 'NO_ORDERS', diff: null }
  const diff = roundCash(reportTax - ordersTax)
  return { state: Math.abs(reportTax - ordersTax) <= taxTolerance(reportTax, ordersTax) ? 'MATCHED' : 'DIFFERENT', diff: diff === 0 ? 0 : diff }
}

/** 州：去空白、转大写；空值返回 null（这一行没法归州）。 */
export function normalizeTaxState(value: string | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, ' ').toUpperCase()
  return text ? text.slice(0, 64) : null
}

/** 税种：大写、非字母数字换成下划线；没有给就是默认的销售税。 */
export function normalizeTaxKind(value: string | undefined): string {
  const text = (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return text ? text.slice(0, 64) : DEFAULT_TAX_KIND
}

/** 辖区：去空白、转大写；没有给就是空串（州一级）。 */
export function normalizeJurisdiction(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, 120)
}
