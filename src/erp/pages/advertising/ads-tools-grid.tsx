import { useCallback, useMemo, type ReactNode } from 'react'
import { MassiveGrid, type CursorFetcher, type ErpColDef } from '../../components'
import { apiFetch } from '../../../api'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'

// 广告工具面板（冲突、重复关键词）共用的游标表格（P6-24）：数据按服务端游标分块取，范围变化时回到第一块；表格用统一的 MassiveGrid。

type ToolList<T> = { items: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null; approxTotal?: number | null } }

export function ToolGrid<T extends object, R extends ToolList<T>>({
  gridId,
  path,
  params,
  columns,
  getRowId,
  emptyDomain,
  emptyNote,
  onFirstPage,
  height = 360,
}: {
  gridId: string
  path: string
  params?: Record<string, string | undefined>
  columns: ErpColDef<T>[]
  getRowId: (row: T) => string
  emptyDomain: string
  emptyNote: string
  onFirstPage?: (response: R) => void
  height?: number
}): ReactNode {
  const { apiParams } = useScope()
  const requestParams = useMemo(() => ({ ...apiParams, ...params }), [apiParams, params])
  const fetchPage = useCallback<CursorFetcher<T>>(
    async ({ cursor, limit, signal }) => {
      const response = await apiFetch<R>(buildPath(path, { ...requestParams, pageSize: limit, cursor: cursor ?? undefined }), { signal })
      if (cursor === null) onFirstPage?.(response)
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    // onFirstPage 每次渲染都是新函数，只按请求参数重建数据源
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, requestParams],
  )
  return (
    <MassiveGrid<T>
      gridId={gridId}
      columns={columns}
      fetchPage={fetchPage}
      getRowId={getRowId}
      resetKey={JSON.stringify([path, requestParams])}
      emptyState={{ kind: 'empty', domain: emptyDomain, prerequisite: emptyNote }}
      height={height}
    />
  )
}
