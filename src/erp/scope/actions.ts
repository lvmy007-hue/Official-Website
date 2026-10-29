import { SCOPE_PARAM_KEYS } from '@nova/api-contracts'
import { previousRange, rangePresets, yearOverYearRange, type DateRange } from './dates'
import { validateScope } from './params'

// 范围栏的操作（纯函数，便于测试）：把用户的一次选择变成新的地址栏参数。

export type ScopePatch = Partial<{
  legalEntityIds: string[]
  storeIds: string[]
  range: DateRange | null
  compare: 'none' | 'previous' | 'yoy' | 'custom'
  compareRange: DateRange | null
  displayCurrency: 'USD' | 'ORIGINAL'
}>

type Search = Record<string, unknown>

/** 切换范围后页面自己的分页位置失效，需要回到第一页。 */
const PAGINATION_KEYS = ['page', 'cursor']

export function nextSearch(prev: Search, patch: ScopePatch, today: string): Search {
  const next: Search = { ...prev }
  for (const key of PAGINATION_KEYS) delete next[key]

  if ('legalEntityIds' in patch) next.legalEntityIds = patch.legalEntityIds?.length ? patch.legalEntityIds : undefined
  if ('storeIds' in patch) next.storeIds = patch.storeIds?.length ? patch.storeIds : undefined
  if ('displayCurrency' in patch) next.displayCurrency = patch.displayCurrency
  if ('range' in patch) {
    next.from = patch.range?.from
    next.to = patch.range?.to
    // 清除时间范围时对比期也一并清除：没有范围就没有对比
    if (!patch.range) {
      next.compare = undefined
      next.compareFrom = undefined
      next.compareTo = undefined
    }
  }
  if ('compare' in patch) {
    next.compare = patch.compare === 'none' ? undefined : patch.compare
    if (patch.compare !== 'custom') {
      next.compareFrom = undefined
      next.compareTo = undefined
    }
    // 选择对比期前必须先有时间范围：没有时默认近 30 天
    if (patch.compare && patch.compare !== 'none' && !next.from) {
      const preset = rangePresets(today).find(item => item.key === 'last30')!.range
      next.from = preset.from
      next.to = preset.to
    }
  }
  if ('compareRange' in patch) {
    next.compareFrom = patch.compareRange?.from
    next.compareTo = patch.compareRange?.to
  }
  return next
}

/** 当前范围实际使用的对比区间（上一期、去年同期由规则推出，自定义取用户选择）。 */
export function effectiveCompareRange(search: Search): DateRange | null {
  const from = search.from as string | undefined
  const to = search.to as string | undefined
  if (!from || !to) return null
  const mode = search.compare as string | undefined
  if (mode === 'previous') return previousRange({ from, to })
  if (mode === 'yoy') return yearOverYearRange({ from, to })
  if (mode === 'custom' && search.compareFrom && search.compareTo) return { from: search.compareFrom as string, to: search.compareTo as string }
  return null
}

/** 把范围写成一句话，数据新鲜度条与导出任务共用。 */
export function describeRange(search: Search, defaultLabel = '近 30 天'): string {
  const from = search.from as string | undefined
  const to = search.to as string | undefined
  if (!from || !to) return defaultLabel
  return from === to ? from : `${from} 至 ${to}`
}

export function isScopeValid(search: Search): boolean {
  return validateScope(search).ok
}

/** 只保留范围参数。 */
export function scopeOnly(search: Search): Search {
  const keys = new Set<string>(SCOPE_PARAM_KEYS)
  return Object.fromEntries(Object.entries(search).filter(([key]) => keys.has(key)))
}
