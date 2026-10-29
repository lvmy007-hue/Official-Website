// 全局范围参数的常量与地址栏校验（不依赖 zod）。
//
// 前端首屏要在地址栏校验范围参数，但 zod 4 的运行时约 14 KB（gzip），放进首屏会超出 350 KB 预算，
// 所以这里手写一份与 `query.ts` 里 `ScopeSearchSchema` 规则完全一致的校验；两者的一致性由 `scope-search.test.ts` 逐条对照。
// 改范围参数的规则时必须两处一起改，测试会抓到不一致。接口服务仍使用 `query.ts` 里的 zod 定义。
// 这个文件不要引入 zod，也不要引入会引入 zod 的文件，否则前端首屏会重新带上 zod。

/** 站点固定为亚马逊美国站。 */
export const US_MARKETPLACE_ID = 'ATVPDKIKX0DER'
/** 单次查询允许的最长时间范围（天），防止全表扫描。 */
export const SCOPE_MAX_DAYS = 1100
export const COMPARE_MODES = ['none', 'previous', 'yoy', 'custom'] as const
export const DISPLAY_CURRENCIES = ['ORIGINAL', 'USD'] as const
/** 范围参数在地址栏里的全部键名（顺序即校验顺序）。 */
export const SCOPE_PARAM_KEYS = ['legalEntityIds', 'storeIds', 'marketplaceId', 'from', 'to', 'compare', 'compareFrom', 'compareTo', 'displayCurrency'] as const
export type ScopeParamKey = (typeof SCOPE_PARAM_KEYS)[number]

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MARKETPLACE_MESSAGE = '站点只支持亚马逊美国站'

export type SearchIssue = { message: string; path: string[] }
export type ScopeSearchResult = { success: true; data: Record<string, unknown> } | { success: false; error: { issues: SearchIssue[] } }
/** 路由登记表里“页面自己的地址栏规则”的最小形状：zod 的 schema 也满足它。 */
export type SearchParser = { safeParse(raw: unknown): { success: true; data?: unknown } | { success: false; error: { issues: ReadonlyArray<{ message: string }> } } }

const INVALID_INPUT = 'Invalid input'

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  return typeof value
}

const wrongType = (expected: string, value: unknown) => `Invalid input: expected ${expected}, received ${typeName(value)}`
const oneOf = (values: readonly string[]) => `Invalid option: expected one of ${values.map(value => JSON.stringify(value)).join('|')}`

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
}

type Field<T> = { ok: true; value: T } | { ok: false; message: string }
const pass = <T>(value: T): Field<T> => ({ ok: true, value })
const fail = (message: string): Field<never> => ({ ok: false, message })

/** 编号列表：逗号分隔的字符串或字符串数组（前端路由会把已校验的数组再交给下一层路由）。 */
function idList(raw: unknown): Field<string[]> {
  let items: string[]
  if (typeof raw === 'string' && raw.length <= 2000) {
    items = raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  } else if (Array.isArray(raw) && raw.length <= 100 && raw.every(item => typeof item === 'string' && item.length <= 64)) {
    items = raw as string[]
  } else {
    return fail(INVALID_INPUT)
  }
  if (items.some(item => !ID_PATTERN.test(item))) return fail('编号格式不正确')
  if (items.length > 100) return fail('一次最多选择 100 个')
  return pass(items)
}

function businessDate(raw: unknown): Field<string> {
  if (typeof raw !== 'string') return fail(wrongType('string', raw))
  if (!DATE_PATTERN.test(raw)) return fail('日期格式应为 YYYY-MM-DD')
  const time = Date.parse(`${raw}T00:00:00Z`)
  if (Number.isNaN(time) || !new Date(time).toISOString().startsWith(raw)) return fail('日期不存在')
  return pass(raw)
}

function enumValue<const T extends string>(raw: unknown, values: readonly T[], fallback: T): Field<T> {
  if (raw === undefined) return pass(fallback)
  return typeof raw === 'string' && (values as readonly string[]).includes(raw) ? pass(raw as T) : fail(oneOf(values))
}

function refineScope(value: Record<string, unknown>): SearchIssue[] {
  const issues: SearchIssue[] = []
  const add = (path: string, message: string) => issues.push({ message, path: [path] })
  const from = value.from as string | undefined
  const to = value.to as string | undefined
  const compare = value.compare as string
  const compareFrom = value.compareFrom as string | undefined
  const compareTo = value.compareTo as string | undefined
  if ((from && !to) || (!from && to)) {
    add('from', '开始日期与结束日期需要同时提供')
    return issues
  }
  if (from && to) {
    const span = daysBetween(from, to)
    if (span < 0) add('to', '结束日期不能早于开始日期')
    else if (span + 1 > SCOPE_MAX_DAYS) add('to', `时间范围不能超过 ${SCOPE_MAX_DAYS} 天`)
  }
  if (compare === 'custom') {
    if (!compareFrom || !compareTo) add('compareFrom', '自定义对比期需要同时提供开始与结束日期')
    else if (daysBetween(compareFrom, compareTo) < 0) add('compareTo', '对比期结束日期不能早于开始日期')
  } else if (compareFrom || compareTo) {
    add('compare', '只有自定义对比才需要对比期日期')
  }
  if (compare !== 'none' && !from) add('compare', '选择对比期前需要先选择时间范围')
  return issues
}

/**
 * 地址栏范围参数校验：规则与 `query.ts` 的 `ScopeSearchSchema` 相同（范围参数按规则校验并补默认值，其余参数原样带过）。
 * 失败时 `issues[0].message` 是给用户看的中文原因。
 */
export function parseScopeSearch(raw: unknown): ScopeSearchResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { success: false, error: { issues: [{ message: wrongType('object', raw), path: [] }] } }
  const input = raw as Record<string, unknown>
  const data: Record<string, unknown> = {}
  for (const key of Object.keys(input)) if (!(SCOPE_PARAM_KEYS as readonly string[]).includes(key)) data[key] = input[key]

  const issues: SearchIssue[] = []
  const take = (key: ScopeParamKey, field: Field<unknown> | undefined) => {
    if (field === undefined) return
    if (field.ok) data[key] = field.value
    else issues.push({ message: field.message, path: [key] })
  }
  const optional = <T>(key: ScopeParamKey, parse: (value: unknown) => Field<T>) => (input[key] === undefined ? undefined : parse(input[key]))

  take('legalEntityIds', optional('legalEntityIds', idList))
  take('storeIds', optional('storeIds', idList))
  take('marketplaceId', input.marketplaceId === undefined ? pass(US_MARKETPLACE_ID) : input.marketplaceId === US_MARKETPLACE_ID ? pass(US_MARKETPLACE_ID) : fail(MARKETPLACE_MESSAGE))
  take('from', optional('from', businessDate))
  take('to', optional('to', businessDate))
  take('compare', enumValue(input.compare, COMPARE_MODES, 'none'))
  take('compareFrom', optional('compareFrom', businessDate))
  take('compareTo', optional('compareTo', businessDate))
  take('displayCurrency', enumValue(input.displayCurrency, DISPLAY_CURRENCIES, 'USD'))
  if (issues.length === 0) issues.push(...refineScope(data))
  return issues.length > 0 ? { success: false, error: { issues } } : { success: true, data }
}

/** 登记到路由表的范围参数规则（`live-pages.ts` 的 `search` 字段）。 */
export const ScopeSearchParser: SearchParser = { safeParse: parseScopeSearch }
