// 统一格式化工具（3.3：等宽数字、正负色、金额必带币种、时间必带时区、百分比）。
// 页面与表格一律通过这里格式化，禁止在组件里直接 toFixed、toLocaleString 或手拼金额。

export const EMPTY_VALUE = '—'
// 亚马逊美国站业务时区；服务端按此时区切日，页面默认也按此显示。
export const MARKETPLACE_TIME_ZONE = 'America/Los_Angeles'

type Numeric = number | string | null | undefined

export function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const numberFormatCache = new Map<string, Intl.NumberFormat>()
function numberFormat(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let f = numberFormatCache.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-US', options)
    numberFormatCache.set(key, f)
  }
  return f
}

function withSign(text: string, n: number, sign: boolean): string {
  if (!sign || n <= 0) return text
  return `+${text}`
}

export interface NumberOptions {
  digits?: number
  compact?: boolean
  sign?: boolean
}

export function formatNumber(value: Numeric, options: NumberOptions = {}): string {
  const n = toNumber(value)
  if (n === null) return EMPTY_VALUE
  const { digits = 0, compact = false, sign = false } = options
  const f = numberFormat(`n:${digits}:${compact}`, {
    minimumFractionDigits: compact ? 0 : digits,
    maximumFractionDigits: digits,
    notation: compact ? 'compact' : 'standard',
  })
  return withSign(f.format(n), n, sign)
}

export interface MoneyOptions extends NumberOptions {
  /** 不传时默认 2 位小数 */
  digits?: number
}

// 美元显示为 $，其余币种显示三位币种代码，保证金额永远带币种。
export function formatMoney(value: Numeric, currency = 'USD', options: MoneyOptions = {}): string {
  const n = toNumber(value)
  if (n === null) return EMPTY_VALUE
  const { digits = 2, compact = false, sign = false } = options
  const isUsd = currency === 'USD'
  const f = numberFormat(`m:${currency}:${digits}:${compact}`, {
    style: 'currency',
    currency,
    currencyDisplay: isUsd ? 'narrowSymbol' : 'code',
    minimumFractionDigits: compact ? 0 : digits,
    maximumFractionDigits: digits,
    notation: compact ? 'compact' : 'standard',
  })
  const text = f.format(n).replace(/\u00a0/g, ' ')
  return withSign(text, n, sign)
}

// 比率（0.123 表示 12.3%），不是百分数本身。
export function formatPercent(ratio: Numeric, options: Pick<NumberOptions, 'digits' | 'sign'> = {}): string {
  const n = toNumber(ratio)
  if (n === null) return EMPTY_VALUE
  const { digits = 1, sign = false } = options
  const f = numberFormat(`p:${digits}`, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits })
  return withSign(f.format(n), n, sign)
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function parts(date: Date, timeZone: string, seconds: boolean): Record<string, string> {
  const key = `${timeZone}:${seconds}`
  let f = dtfCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: seconds ? '2-digit' : undefined,
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
    dtfCache.set(key, f)
  }
  const out: Record<string, string> = {}
  for (const p of f.formatToParts(date)) out[p.type] = p.value
  return out
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

// 时间必带时区：2026-10-21 13:45 PDT。
export function formatDateTime(value: Date | string | number | null | undefined, options: { timeZone?: string; seconds?: boolean } = {}): string {
  const d = toDate(value)
  if (!d) return EMPTY_VALUE
  const { timeZone = MARKETPLACE_TIME_ZONE, seconds = false } = options
  const p = parts(d, timeZone, seconds)
  const time = seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`
  return `${p.year}-${p.month}-${p.day} ${time} ${p.timeZoneName}`
}

// 业务日期（按站点时区切日的日历日），不显示时区。入参为 YYYY-MM-DD 时原样返回，避免被时区平移。
export function formatDate(value: Date | string | number | null | undefined, options: { timeZone?: string } = {}): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const d = toDate(value)
  if (!d) return EMPTY_VALUE
  const p = parts(d, options.timeZone ?? MARKETPLACE_TIME_ZONE, false)
  return `${p.year}-${p.month}-${p.day}`
}

export type Tone = 'positive' | 'negative' | 'neutral'

// 正负色语义：默认数值上升为好；成本、退款率等“越低越好”的指标传 goodWhen: 'down'。
export function toneOf(value: Numeric, goodWhen: 'up' | 'down' = 'up'): Tone {
  const n = toNumber(value)
  if (n === null || n === 0) return 'neutral'
  const good = goodWhen === 'up' ? n > 0 : n < 0
  return good ? 'positive' : 'negative'
}

export function toneClassName(tone: Tone): string {
  return `erp-tone-${tone}`
}

// 数字类单元格与文本统一使用的类名（等宽数字）。
export const NUMERIC_CLASS = 'erp-num'
