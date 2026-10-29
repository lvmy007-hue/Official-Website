import { useCallback, useState } from 'react'
import { DataState, PagedGrid, stateFromError, type DataStateProps, type ErpColDef, type PageFetcher } from '../../components'
import { describeError } from '../../query/errors'

// 退货分析里的小表（P6-13）：接口已经把整张表（几行到几十行）一次返回，这里用 PagedGrid 骨架分页显示，不另取数。
// 正在读取时显示骨架，读取失败显示正式的错误状态与重试；数据换了（换时间口径、换范围）自动回到第 1 页。

export type LocalGridProps<T extends object> = {
  gridId: string
  columns: ErpColDef<T>[]
  rows: readonly T[] | undefined
  getRowId: (row: T) => string
  emptyState: Extract<DataStateProps, { kind: 'empty' }>
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  height?: number
}

export function LocalGrid<T extends object>({ gridId, columns, rows, getRowId, emptyState, loading, error, onRetry, height = 300 }: LocalGridProps<T>) {
  // 行数组换了（新一次取数）就换重置键，让表格回到第 1 页
  const [seen, setSeen] = useState(rows)
  const [version, setVersion] = useState(0)
  if (seen !== rows) {
    setSeen(rows)
    setVersion(current => current + 1)
  }
  const fetchPage = useCallback<PageFetcher<T>>(
    async ({ page, pageSize }) => {
      const data = rows ?? []
      return { items: data.slice((page - 1) * pageSize, page * pageSize), total: data.length }
    },
    [rows],
  )

  if (error) return <DataState {...stateFromError(describeError(error), { onRetry })} />
  if (rows === undefined || loading) return <DataState kind="skeleton" rows={3} />
  return (
    <PagedGrid<T>
      gridId={gridId}
      columns={columns}
      fetchPage={fetchPage}
      getRowId={getRowId}
      resetKey={String(version)}
      emptyState={emptyState}
      initialPageSize={20}
      height={Math.min(height, 96 + Math.max(3, Math.min(rows.length, 20)) * 36)}
    />
  )
}
