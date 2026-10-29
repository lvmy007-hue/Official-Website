import type { Key, ReactNode } from 'react'
import type { ColumnsType } from 'antd/es/table'
import type { DataStateProps } from '../data-state/DataState'
import { PagedGrid } from './PagedGrid'
import { useAntdGridColumns } from './SimpleGrid'
import type { PageFetcher } from './grid-types'

// 服务端分页的中小列表（P6-28）：沿用 antd 列定义，行从服务端按页码取，交给 PagedGrid；
// 页面自己的搜索与筛选改变时把它们并进 resetKey，表格回到第 1 页重取。

export type SimplePagedGridProps<T extends object> = {
  gridId: string
  columns: ColumnsType<T>
  fetchPage: PageFetcher<T>
  rowKey: (row: T) => Key
  /** 筛选条件或范围变化的签名（JSON 字符串即可），变化后回到第 1 页。 */
  resetKey: string
  emptyState: Extract<DataStateProps, { kind: 'empty' }>
  onRowOpen?: (row: T) => void
  renderBulkActions?: (rows: T[]) => ReactNode
  height?: number | string
}

export function SimplePagedGrid<T extends object>(props: SimplePagedGridProps<T>) {
  const columns = useAntdGridColumns<T>(props.columns)
  return (
    <PagedGrid<T>
      gridId={props.gridId}
      columns={columns}
      fetchPage={props.fetchPage}
      getRowId={row => String(props.rowKey(row))}
      resetKey={props.resetKey}
      emptyState={props.emptyState}
      onRowOpen={props.onRowOpen}
      renderBulkActions={props.renderBulkActions}
      height={props.height ?? 560}
    />
  )
}
