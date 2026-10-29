// 数据中心结果行的取值小工具（各数据集共用）：结果文档是逐行 JSON，字段缺失与类型不符一律当“没有”，不抛错、不补 0。

export type Money = { amount: number; currency: string | null }

export const get = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value)

/** `{ amount, currencyCode }` → 金额与币种；金额不是有限数字时为 null（官方没给）。 */
export const money = (value: unknown): Money | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as { amount?: unknown; currencyCode?: unknown }
  const amount = typeof v.amount === 'number' ? v.amount : typeof v.amount === 'string' && v.amount.trim() !== '' ? Number(v.amount) : NaN
  return Number.isFinite(amount) ? { amount, currency: typeof v.currencyCode === 'string' ? v.currencyCode : null } : null
}

/** 数量类字段（官方的 Long 可能以数字或数字字符串给出）。 */
export const count = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

export const round = (value: number) => Math.round(value * 1e6) / 1e6

/** GraphQL 字符串与 JSON 字符串转义规则一致，外部输入只能以字符串字面量进入查询。 */
export const quote = (value: string) => JSON.stringify(value)

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 取一行里某个根字段下的记录：兼容“带 data 外壳”与“直接是记录”两种写法，数组取第一个。 */
export function unwrapRecord(row: unknown, root: string, field: string): unknown {
  const body = get(row, 'data', root, field) ?? row
  return Array.isArray(body) ? body[0] : body
}

/** 官方日期字段（YYYY-MM-DD，也可能带时间）→ 日期文本；格式不对为 null。 */
export function dateOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.slice(0, 10)
  return DATE_PATTERN.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : null
}
