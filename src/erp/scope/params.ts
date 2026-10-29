import { parseScopeSearch, SCOPE_PARAM_KEYS, US_MARKETPLACE_ID, type ScopeQuery } from '@nova/api-contracts'

// 全局范围参数（P1-04）：法律主体、店铺、站点（固定美国站）、时间范围、对比期、币种口径。
// 地址栏是唯一的真实来源；所有请求从这里取统一的范围参数。

export type ScopeSearch = Partial<ScopeQuery> & Record<string, unknown>

/** 范围参数的默认值：不写进地址栏。 */
export const SCOPE_DEFAULTS = { marketplaceId: US_MARKETPLACE_ID, compare: 'none', displayCurrency: 'USD' } as const

const SCOPE_KEYS = new Set<string>(SCOPE_PARAM_KEYS)
export const isScopeKey = (key: string) => SCOPE_KEYS.has(key)

/** 只保留范围参数（导航切换页面时带着走，页面自己的筛选、分页不带）。 */
export function pickScope<T extends Record<string, unknown>>(search: T): Partial<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(search).filter(([key, value]) => isScopeKey(key) && value !== undefined))
}

/** 校验地址栏参数里的范围部分；不合法时返回中文原因。 */
export function validateScope(raw: Record<string, unknown>): { ok: true; scope: ScopeSearch } | { ok: false; message: string } {
  const result = parseScopeSearch(raw) // 不用 zod 的同规则校验（首屏体积），与 ScopeSearchSchema 的一致性有测试对照
  if (result.success) return { ok: true, scope: result.data as ScopeSearch }
  const issue = result.error.issues[0]
  return { ok: false, message: issue?.message ?? '地址栏里的筛选参数不正确' }
}

type Primitive = string | number | boolean

const asText = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value)) return value.length ? value.join(',') : undefined
  return String(value as Primitive)
}

/** 请求服务端时使用的范围参数（全部写成字符串，数组用逗号连接）。 */
export function scopeToApiParams(scope: ScopeSearch): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SCOPE_PARAM_KEYS) {
    const text = asText(scope[key])
    if (text !== undefined) out[key] = text
  }
  out.marketplaceId ??= US_MARKETPLACE_ID
  return out
}

/** 范围是否限定到了具体对象（用于范围栏高亮）。 */
export function isScopeNarrowed(scope: ScopeSearch): boolean {
  return Boolean((scope.legalEntityIds as string[] | undefined)?.length || (scope.storeIds as string[] | undefined)?.length || scope.from)
}
