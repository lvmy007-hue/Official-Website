import { useCallback, useMemo } from 'react'
import { EMPTY_VALUE, formatNumber } from '../../format'
import { PagedGrid } from '../table/PagedGrid'
import { numberColumn, textColumn } from '../table/columns'
import type { ErpColDef, PageFetcher } from '../table/grid-types'
import type { ChartTableData } from './chart-link'

// 图表的“表格视图”（P6-06）：同一份数据换成 PagedGrid 展示（类目一列加每个系列一列），行点击与图联动。
// 图是按类目 × 系列画的，所以这里不做服务端取数：fetchPage 在本地按页切片；和图共用同一份 option，不会出现图与表两个口径。

type Row = { id: string; category: string } & Record<string, string | number | null>

const show = (value: unknown) => (typeof value === 'number' ? formatNumber(value, { digits: Number.isInteger(value) ? 0 : 2 }) : EMPTY_VALUE)

export type ChartTableProps = {
  title: string
  data: ChartTableData
  /** 只显示这个类目（图上点选的日期）。 */
  filterCategory?: string | null
  /** 点某一行：把该类目交给图高亮。 */
  onRowFocus?: (category: string) => void
}

export default function ChartTable({ title, data, filterCategory, onRowFocus }: ChartTableProps) {
  const rows = useMemo<Row[]>(
    () =>
      data.categories
        .map((category, index) => {
          const row: Row = { id: category, category }
          data.series.forEach((series, i) => {
            row[`s${i}`] = series.values[index] ?? null
          })
          return row
        })
        .filter(row => !filterCategory || row.category === filterCategory),
    [data, filterCategory],
  )
  const columns = useMemo<ErpColDef<Row>[]>(
    () => [{ ...textColumn<Row>('类目', 'category'), pin: 'left' }, ...data.series.map((series, i) => numberColumn<Row>(series.name, `s${i}`, { valueFormatter: params => show(params.value) }))],
    [data],
  )
  // 数据变了（换范围、刷新）表格要重新取：用首尾类目、系列名与全部数值的合计当签名
  const signature = useMemo(() => {
    const sums = data.series.map(series => series.values.reduce<number>((total, value) => total + (value ?? 0), 0))
    return JSON.stringify([data.categories[0], data.categories[data.categories.length - 1], data.categories.length, data.series.map(series => series.name), sums, filterCategory ?? null])
  }, [data, filterCategory])
  const fetchPage = useCallback<PageFetcher<Row>>(async ({ page, pageSize }) => ({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }), [rows])
  return (
    <PagedGrid<Row>
      gridId={`chart-table.${title}`}
      columns={columns}
      fetchPage={fetchPage}
      getRowId={row => row.id}
      resetKey={signature}
      emptyState={{ kind: 'empty', domain: `${title}的数据`, prerequisite: '所选范围内没有数据点' }}
      onRowOpen={row => onRowFocus?.(row.category)}
      initialPageSize={20}
      height={360}
    />
  )
}
