import type { ReactNode } from 'react'
import { Tag } from 'antd'
import { actionColumn, numberColumn, renderColumn, type ErpColDef } from '../../../components'
import { EMPTY_VALUE } from '../../../format'
import type { BoxGridRow } from './box-grid-rows'

// 装箱编辑器表格的列：箱号/商品、相同箱数、每箱件数、合计件数、重量、尺寸、体积、状态、操作。
// 数据在浏览器里，不排序（顺序就是箱子的顺序）；展开箱子看箱内商品。

const quiet = { sortable: false } as const

export function boxEditorColumns(actions: (row: BoxGridRow) => ReactNode, editable: boolean): ErpColDef<BoxGridRow>[] {
  const columns: ErpColDef<BoxGridRow>[] = [
    {
      headerName: '箱号 / 商品',
      colId: 'name',
      pin: 'left',
      width: 240,
      sortable: false,
      valueGetter: ({ data }) => data?.name ?? '',
      cellRenderer: ({ data }: { data?: BoxGridRow }) => (data ? data.kind === 'box' ? <strong>{data.name}</strong> : <span>{data.name}</span> : null),
    },
    numberColumn<BoxGridRow>('相同箱数', 'boxCount', { digits: 0, ...quiet, width: 110 }),
    numberColumn<BoxGridRow>('每箱件数', 'unitsPerBox', { digits: 0, ...quiet, width: 110 }),
    numberColumn<BoxGridRow>('合计件数', 'units', { digits: 0, ...quiet, width: 110 }),
    numberColumn<BoxGridRow>('重量（磅）', 'weightLb', { digits: 2, ...quiet, width: 110 }),
    renderColumn<BoxGridRow>('尺寸 长×宽×高（英寸）', 'dims', row => (row.kind === 'item' ? null : <span className="erp-num">{row.dims || EMPTY_VALUE}</span>), { width: 190, ...quiet }),
    numberColumn<BoxGridRow>('单箱体积（立方英尺）', 'volumeCuFt', { digits: 3, ...quiet, width: 160 }),
    renderColumn<BoxGridRow>(
      '状态',
      'status',
      row =>
        row.status === '' ? null : (
          <Tag bordered={false} color={row.status === '完整' ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
            {row.status}
          </Tag>
        ),
      { width: 130, ...quiet },
    ),
  ]
  if (editable) columns.push(actionColumn<BoxGridRow>(row => (row.kind === 'box' ? actions(row) : null), { width: 200 }))
  return columns
}
