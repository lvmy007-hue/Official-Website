import { useCallback, useMemo } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { managedKeys, nextFilterSearch, replacePatch, sanitizeFilterValues, type FilterField, type FilterPatch, type FilterValues, type SearchMode } from './filter-model'

// 筛选条件放在地址栏里（P6-04）：刷新、复制链接、浏览器前进后退都能还原；改筛选用 replace，不把每次点击都压进历史。
// 地址栏里不认识的取值（下拉里没有的选项、不合规的批量词）读取时丢掉，并告诉页面丢了几个。

export type UrlFilters = {
  values: FilterValues
  /** 地址栏里被忽略的条件个数。 */
  ignored: number
  set: (patch: FilterPatch) => void
  /** 整体换成一组筛选（套用筛选方案、清空）；返回被忽略的条件个数。 */
  replaceAll: (next: Record<string, unknown>) => number
  reset: () => void
  /** 筛选变化就变，给表格当 resetKey 的一部分。 */
  signature: string
}

export function useUrlFilters(fields: readonly FilterField[], modes: readonly SearchMode[] = []): UrlFilters {
  const router = useRouter()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const keys = useMemo(() => managedKeys(fields, modes), [fields, modes])
  const parsed = useMemo(() => sanitizeFilterValues(fields, modes, search), [fields, modes, search])

  const navigateWith = useCallback(
    (patch: FilterPatch) => {
      void router.navigate({ search: ((prev: Record<string, unknown>) => nextFilterSearch(prev, patch)) as never, replace: true })
    },
    [router],
  )
  const set = useCallback((patch: FilterPatch) => navigateWith(patch), [navigateWith])
  const replaceAll = useCallback(
    (next: Record<string, unknown>) => {
      const cleaned = sanitizeFilterValues(fields, modes, next, { countUnknown: true })
      navigateWith(replacePatch(keys, cleaned.values))
      return cleaned.ignored
    },
    [fields, modes, keys, navigateWith],
  )
  const reset = useCallback(() => navigateWith(replacePatch(keys, {})), [keys, navigateWith])
  const signature = useMemo(() => JSON.stringify(Object.entries(parsed.values).sort(([a], [b]) => (a < b ? -1 : 1))), [parsed.values])
  return { values: parsed.values, ignored: parsed.ignored, set, replaceAll, reset, signature }
}
