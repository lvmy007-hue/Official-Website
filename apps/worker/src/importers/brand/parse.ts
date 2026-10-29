import { isDateText, periodKindOf, type BaPeriod } from '@nova/api-contracts'
import { count, money, round } from '../../datakiosk/json'
import type { Row } from '../../streaming/rows'

// 品牌分析报告（R-35 至 R-39，GET_BRAND_ANALYTICS_*）行解析的共用小工具：纯函数，不碰数据库。
// 官方没给的值一律是 null（不补 0）；份额与比率按 0 到 1 的小数读，超出范围当作“没给”；计数超过整型上限或为负当作“没给”。
// **字段名按官方样例整理，没有对真实店铺核对。**

const INT_MAX = 2_147_483_647

export interface BrandReportOptions {
  reportJobId?: string | null
  /** 报告申请的窗口；行里没有起止日时用它（必须恰好是一个对齐的周、月或季）。 */
  from?: Date | null
  to?: Date | null
  /** 测试用：固定“现在”。 */
  now?: Date
}

export interface ReportPeriod {
  kind: BaPeriod
  start: string
  end: string
}

const dayText = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null)

/** 行自带的起止日优先，没有则用申请窗口；起止日不是一个对齐的周、月、季时返回 null（这一行跳过，不猜周期）。 */
export function readPeriod(row: Row, options: BrandReportOptions): ReportPeriod | null {
  const start = typeof row.startDate === 'string' ? row.startDate.slice(0, 10) : dayText(options.from)
  const end = typeof row.endDate === 'string' ? row.endDate.slice(0, 10) : dayText(options.to)
  if (!isDateText(start) || !isDateText(end)) return null
  const kind = periodKindOf(start, end)
  return kind ? { kind, start, end } : null
}

export const dateOnly = (text: string) => new Date(`${text}T00:00:00Z`)

/** 非负整数计数；超过整型上限、负数、小数部分以外的非法值为 null。 */
export function qty(value: unknown): number | null {
  const n = count(value)
  return n !== null && n >= 0 && n <= INT_MAX ? Math.trunc(n) : null
}

/** 正整数（排名）：必须 ≥1。 */
export function rank(value: unknown): number | null {
  const n = qty(value)
  return n !== null && n >= 1 ? n : null
}

/** 份额或比率：0 到 1 的小数，超出范围为 null。 */
export function fraction(value: unknown): number | null {
  const n = count(value)
  return n !== null && n >= 0 && n <= 1 ? round(n) : null
}

/** 金额（价格、销售额）：`{ amount, currencyCode }`；负数为 null。 */
export function price(value: unknown): { amount: number; currency: string | null } | null {
  const parsed = money(value)
  return parsed && parsed.amount >= 0 ? { amount: round(parsed.amount), currency: parsed.currency } : null
}

/** ASIN：10 位字母数字，统一大写；其他为 null。 */
export function asinOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toUpperCase()
  return /^[A-Z0-9]{10}$/.test(text) ? text : null
}

/** 文本字段：去空白，空为 null。 */
export function textOf(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null
}

/** 多个价格里第一个有币种的币种（同一行的价格同币种）。 */
export const firstCurrency = (...values: Array<{ currency: string | null } | null>): string | null => values.find(item => item?.currency)?.currency ?? null
