import type { JsonObject } from '../types'

export function countOf(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object') {
    const record = value as JsonObject
    const nested = Number(record.quantity ?? record.total ?? 0)
    return Number.isFinite(nested) ? nested : 0
  }
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}
export function historyWindows(since: Date | null, windowDays: number) {
  const end = new Date(Date.now() - 2 * 60 * 1000)
  const earliest = end.getTime() - 730 * 86400000
  const start = since ? new Date(Math.max(since.getTime() - 2 * 86400000, earliest)) : new Date(earliest)
  const windows: Array<{ after: string; before: string }> = []
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += windowDays * 86400000) {
    const before = Math.min(end.getTime(), cursor + windowDays * 86400000)
    windows.push({ after: new Date(cursor).toISOString(), before: new Date(before).toISOString() })
  }
  return windows
}
export function decimal(value: unknown) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}
export function valueFrom(row: JsonObject, names: string[]) {
  for (const name of names) if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return row[name]
  return undefined
}
// 严格解析日期：缺失或无法解析返回 null。分区表的唯一键包含日期，不能用当前时间兜底，
// 否则同一条记录每次同步都会变成新记录。
export function validDate(value: unknown): Date | null {
  if (value == null || value === '') return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}
/** 指定时区的“今天”（日期列用：UTC 零点的日期）。库存快照的日期按企业数据口径时区计算。 */
export function localDay(timeZone: string, now: Date = new Date()): Date {
  const text = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return new Date(`${text}T00:00:00Z`)
}
export function dateFrom(value: unknown) {
  const date = new Date(String(value ?? ''))
  return Number.isNaN(date.getTime()) ? new Date() : date
}
