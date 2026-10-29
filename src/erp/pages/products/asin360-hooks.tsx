import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { DataState, stateFromError, useDetailFilter } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'

// ASIN 360 各页签取数的共用小件：页签只在被打开时才取数（antd 页签懒渲染），这里统一加载中与读取失败的显示。

type Params = Record<string, string | number | undefined>

/**
 * 商品编号下的接口；只有经营表现随时间范围，其余按商品取数不带全局范围参数（范围由服务端按成员的数据范围收窄）。
 * 放在锚点长页里时（P6-21），带范围的板块改用页面自己的共享筛选（日期与对比方式），不再跟随顶部全局范围栏：
 * 共享筛选选了日期就用它的 from、to 与对比参数，并清掉全局的对比参数，免得两边的对比期混在一起。
 */
export function useProductQuery<T>(id: string, tab: string, options: { scoped?: boolean; params?: Params; enabled?: boolean } = {}) {
  const base = `/products/${encodeURIComponent(id)}`
  const filter = useDetailFilter()
  const shared = options.scoped === true && filter.range !== null
  const params = shared ? { compare: undefined, compareFrom: undefined, compareTo: undefined, ...filter.params, ...options.params } : options.params
  return useApiQuery<T>({ domain: 'list', path: tab ? `${base}/${tab}` : base, params, scoped: options.scoped ?? false, enabled: options.enabled })
}

export function QueryBody<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (query.isPending || query.data === undefined) return <DataState kind="skeleton" rows={4} />
  return <>{children(query.data)}</>
}
