import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { DataState, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'

// 库存详情各页签取数的共用小件：页签只在被打开时才取数（antd 页签懒渲染），这里统一加载中与读取失败的显示。

type Params = Record<string, string | number | undefined>

export function useDetailQuery<T>(id: string, tab: string, params?: Params, enabled = true) {
  // 详情接口按库存记录编号取数，范围由服务端按成员的数据范围收窄，不再带全局范围参数
  return useApiQuery<T>({ domain: 'list', path: `/inventory/${encodeURIComponent(id)}/${tab}`, params, scoped: false, enabled })
}

export function QueryBody<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (query.isPending || query.data === undefined) return <DataState kind="skeleton" rows={4} />
  return <>{children(query.data)}</>
}
