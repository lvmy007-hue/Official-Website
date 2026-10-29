import { createHash } from 'node:crypto'
import { NonRetryableError } from '@nova/workflow'
import type { Row } from '../../streaming/rows'

// 库存类报告的列读取工具（P2a-05）。亚马逊各报告的表头写法不统一（“Merchant SKU”“merchant-sku”“reserved_qty”），
// 这里统一成小写加短横线再按别名取值；空白、“--”“N/A”一律视为“没有给”（返回 undefined），不当作 0。

export type Cells = Record<string, string>

const headerCache = new Map<string, string>()
const normalizeHeader = (key: string) => {
  const cached = headerCache.get(key)
  if (cached !== undefined) return cached
  const name = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (headerCache.size < 2000) headerCache.set(key, name)
  return name
}

export function cells(row: Row): Cells {
  const out: Cells = {}
  for (const [key, value] of Object.entries(row)) {
    const name = normalizeHeader(key)
    if (name) out[name] = String(value ?? '').trim()
  }
  return out
}

const EMPTY = new Set(['', '--', 'n/a', 'na', 'null', 'none', '-'])

export function text(c: Cells, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = c[name]
    if (value !== undefined && !EMPTY.has(value.toLowerCase())) return value
  }
  return undefined
}

export function num(c: Cells, names: readonly string[]): number | undefined {
  const raw = text(c, names)
  if (raw === undefined) return undefined
  const cleaned = raw.replace(/[$,%\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined
  return Number(cleaned)
}

export function int(c: Cells, names: readonly string[]): number | undefined {
  const value = num(c, names)
  return value === undefined ? undefined : Math.round(value)
}

const utcDay = (year: string, month: string, day: string) => {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) ? date : undefined
}

/** 报告里的日期（2026-09-30、2026-09-30T10:00:00Z、09/30/2026、2026-09、20260930）→ UTC 零点的日期；解析不了返回 undefined。 */
export function parseDay(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value)
  if (iso) return utcDay(iso[1], iso[2], iso[3] ?? '01')
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value)
  if (us) return utcDay(us[3], us[1], us[2])
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (compact) return utcDay(compact[1], compact[2], compact[3])
  return undefined
}

export const day = (c: Cells, names: readonly string[]) => parseDay(text(c, names))

export function parseTime(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export const monthStartOf = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))

/** 只取美国站：有国家列且不是 US 的行不属于本系统范围。 */
export function isOtherCountry(c: Cells): boolean {
  const country = text(c, ['country', 'country-code', 'marketplace'])
  return country !== undefined && !['US', 'USA', 'AMAZON.COM', 'ATVPDKIKX0DER'].includes(country.toUpperCase())
}

/**
 * 表头检查（失败码 PARSE_HEADER）：每一组别名里至少要有一个出现在表头里。只在文件第一行数据上检查——
 * 关键列整体缺失说明报告格式变了，不该把整份报告当成“没有数据”静默导入；新增列、未知列不算错误。
 */
export function requireColumns(c: Cells, groups: ReadonlyArray<readonly string[]>, reportType: string): void {
  for (const group of groups) {
    if (!group.some(name => name in c)) throw new NonRetryableError('PARSE_HEADER', `${reportType} 缺少关键列 ${group.join(' / ')}，报告格式可能已变化`)
  }
}

export const hashOf = (...parts: Array<string | number | undefined>) =>
  createHash('sha256')
    .update(parts.map(part => String(part ?? '')).join('\u001f'))
    .digest('hex')

/** 提取一组“字段名 → 别名列表”的整数列；没有给的列不出现在结果里（写库时不覆盖旧值）。 */
export function intColumns(c: Cells, spec: Readonly<Record<string, readonly string[]>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [field, names] of Object.entries(spec)) {
    const value = int(c, names)
    if (value !== undefined) out[field] = value
  }
  return out
}

export function numColumns(c: Cells, spec: Readonly<Record<string, readonly string[]>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [field, names] of Object.entries(spec)) {
    const value = num(c, names)
    if (value !== undefined) out[field] = value
  }
  return out
}

export function textColumns(c: Cells, spec: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [field, names] of Object.entries(spec)) {
    const value = text(c, names)
    if (value !== undefined) out[field] = value
  }
  return out
}
