import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { emptyViewConfig, sortViews, type GridViewItem, type GridViewListResponse, type GridViewScope } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { apiQueryKey, buildPath, useApiQuery } from '../../query/api-query'
import { useOptionalSession } from '../../session/session'
import type { ViewFilterBinding } from './grid-view-layout'

// 筛选方案（P6-04）：把当前的筛选条件存成方案，与 P6-03 的视图共用 /grid-views，只是 kind = 'FILTER'，方案里只有筛选与维度，没有列版式。
// 入口放在表格工具栏的视图旁边（15 章第 7 节：方案入口在视图选择里，不在筛选栏里重复）。
// 取舍：方案没有“默认”——默认进入哪组筛选由“视图”的默认决定，避免两个默认互相覆盖；套用时认不出的条件忽略并提示条数。

const LIST_PATH = '/grid-views'
const KIND = 'FILTER'

export type FilterSchemesApi = {
  status: 'loading' | 'ready' | 'error'
  items: GridViewItem[]
  canShare: boolean
  limits: { user: number; team: number }
  /** 当前页面有没有生效的筛选条件（没有就没有东西可存）。 */
  hasFilters: boolean
  /** 套用方案：返回被忽略的条件个数。 */
  apply: (item: GridViewItem) => number
  saveAs: (input: { name: string; scope: GridViewScope }) => Promise<GridViewItem>
  remove: (item: GridViewItem) => Promise<void>
  retry: () => void
}

export function useFilterSchemes(options: { gridId: string; enabled: boolean; binding?: ViewFilterBinding }): FilterSchemesApi | null {
  const { gridId, binding } = options
  const session = useOptionalSession()
  const enabled = options.enabled && binding !== undefined && (session === null || session.me.accessMode === 'NORMAL')
  const client = useQueryClient()
  const listKey = apiQueryKey('config', buildPath(LIST_PATH, { gridId, kind: KIND }))
  const query = useApiQuery<GridViewListResponse>({ domain: 'config', path: LIST_PATH, params: { gridId, kind: KIND }, scoped: false, enabled })
  const items = useMemo(() => (query.data?.items ?? []).filter(item => item.kind === KIND), [query.data])
  const write = useCallback(
    (update: (list: GridViewItem[]) => GridViewItem[]) => client.setQueryData<GridViewListResponse>(listKey, old => (old ? { ...old, items: sortViews(update(old.items)) } : old)),
    // listKey 是按企业与地址算出的数组，内容变化才算变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, gridId],
  )
  const bindingValue = binding?.value
  const hasFilters = bindingValue !== undefined && Object.keys(bindingValue).length > 0

  if (!enabled || !binding) return null
  const status: FilterSchemesApi['status'] = query.isError ? 'error' : query.data ? 'ready' : 'loading'
  return {
    status,
    items,
    canShare: query.data?.canShare ?? false,
    limits: query.data?.limits ?? { user: 20, team: 30 },
    hasFilters,
    apply: item => binding.apply(item.config.filters, item.config.dimension),
    saveAs: async input => {
      const config = { ...emptyViewConfig(), filters: { ...binding.value }, dimension: binding.dimension ?? null }
      const created = await apiFetch<GridViewItem>(LIST_PATH, { method: 'POST', body: JSON.stringify({ gridId, kind: KIND, name: input.name, scope: input.scope, isDefault: false, config }) })
      write(list => [...list, created])
      return created
    },
    remove: async item => {
      await apiFetch(`${LIST_PATH}/${item.id}`, { method: 'DELETE' })
      write(list => list.filter(entry => entry.id !== item.id))
    },
    retry: () => void query.refetch(),
  }
}
