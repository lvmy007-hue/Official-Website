// 审计快照：写入审计前对“修改前后”的内容做脱敏与限长，并计算字段级差异。
// 令牌、密码、密钥、买家个人信息等永不进入审计内容。

const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|cookie|credential|apikey|api_key|accesskey|privatekey|signature|hash|buyer|phone|email|address|postal|taxpayer)/i
const MASK = '[已隐藏]'
const MAX_DEPTH = 6
const MAX_ARRAY = 50
const MAX_STRING = 500
const MAX_CHANGES = 200

export function redactForAudit(value: unknown, depth = 0, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return value === null || value === undefined ? value : MASK
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'object') {
    // Prisma 的 Decimal 等带 toJSON 的对象按字符串保存，避免丢精度
    const withJson = value as { toJSON?: () => unknown }
    if (!Array.isArray(value) && typeof withJson.toJSON === 'function') return redactForAudit(withJson.toJSON(), depth, key)
    if (depth >= MAX_DEPTH) return '[层级过深已省略]'
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY).map(item => redactForAudit(item, depth + 1))
      return value.length > MAX_ARRAY ? [...items, `[另有 ${value.length - MAX_ARRAY} 项已省略]`] : items
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactForAudit(v, depth + 1, k)]))
  }
  return String(value)
}

export interface FieldChange {
  field: string
  before: unknown
  after: unknown
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0 && prefix) out.set(prefix, {})
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out)
    return
  }
  out.set(prefix, value)
}

/** 字段级差异（点号路径）。数组整体按值比较；结果最多 200 项。 */
export function diffSnapshots(before: unknown, after: unknown): FieldChange[] {
  const left = new Map<string, unknown>()
  const right = new Map<string, unknown>()
  if (before !== undefined && before !== null) flatten(before, '', left)
  if (after !== undefined && after !== null) flatten(after, '', right)
  const changes: FieldChange[] = []
  for (const field of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(field)
    const b = right.get(field)
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field, before: a ?? null, after: b ?? null })
    if (changes.length >= MAX_CHANGES) break
  }
  return changes
}
