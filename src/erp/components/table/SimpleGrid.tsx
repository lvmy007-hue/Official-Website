import { createElement, useEffect, useMemo, useReducer, useRef, type Key, type ReactNode } from 'react'
import type { ColumnsType } from 'antd/es/table'
import { describeError } from '../../query/errors'
import { DataState, type DataStateProps } from '../data-state/DataState'
import { stateFromError } from '../data-state/from-error'
import { RIGHT_ALIGNED, renderColumn } from './columns'
import { LocalGrid } from './LocalGrid'
import type { ErpColDef } from './grid-types'

// 中小列表的新骨架（P6-28）：接口一次返回的整份数据（或游标取回的当前一批）交给 LocalGrid 本地分页，
// 沿用 SimpleTable 的调用习惯（antd 列定义、rowKey、loading、error、emptyState），页面只需补一个 gridId，
// 列、工具栏、主题、分页与其它列表骨架完全一致。不支持勾选、行展开和汇总行：需要这些的页面直接用 PagedGrid。
// 页面每次渲染都可以传新建的列数组：表格只在列的结构（标题、键、宽度、固定、对齐）变了才重建列，
// 单元格内容始终用最新一次传入的渲染函数（每次渲染后通知单元格重画），所以点击按钮时不会因列重建而丢事件，闭包里的状态也不会过期。

const ROW_HEIGHT = 44
const HEADER_HEIGHT = 48
const MAX_HEIGHT = 520

type AntdColumns<T> = ColumnsType<T>
type Leaf<T> = {
  title?: ReactNode
  key?: Key
  dataIndex?: unknown
  width?: number | string
  fixed?: boolean | 'left' | 'right'
  align?: 'left' | 'right' | 'center'
  render?: (value: unknown, row: T, index: number) => ReactNode
}
type FlatLeaf<T> = { id: string; leaf: Leaf<T>; group?: string }

const textOf = (title: unknown): string => (typeof title === 'string' || typeof title === 'number' ? String(title) : '')
const pathValue = (row: object, path: unknown): unknown => {
  const keys = Array.isArray(path) ? (path as string[]) : typeof path === 'string' || typeof path === 'number' ? [String(path)] : []
  return keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), row)
}

/** 把 antd 列（含分组）摊平成叶子列，列标识优先用 key，其次 dataIndex，最后用位置。 */
export function flattenColumns<T extends object>(columns: AntdColumns<T>, group?: string, out: FlatLeaf<T>[] = []): FlatLeaf<T>[] {
  for (const column of columns) {
    const children = (column as { children?: AntdColumns<T> }).children
    if (children) {
      flattenColumns<T>(children, textOf(column.title) || group, out)
      continue
    }
    const leaf = column as Leaf<T>
    const dataIndex = Array.isArray(leaf.dataIndex) ? leaf.dataIndex.join('.') : leaf.dataIndex
    out.push({ id: String(leaf.key ?? dataIndex ?? `col-${out.length}`), leaf, group })
  }
  return out
}

const renderLeaf = <T extends object>(leaf: Leaf<T> | undefined, row: T): ReactNode => {
  if (!leaf) return null
  const value = pathValue(row, leaf.dataIndex)
  const content = leaf.render ? leaf.render(value, row, 0) : (value as ReactNode)
  return content === undefined || content === null || content === '' ? '—' : content
}

/** 列结构签名：标题、列标识、宽度、固定、对齐、分组都相同就视为同一组列。 */
const signatureOf = <T extends object>(flat: FlatLeaf<T>[]) =>
  flat.map(({ id, leaf, group }) => [id, textOf(leaf.title), leaf.width ?? '', String(leaf.fixed ?? ''), leaf.align ?? '', group ?? ''].join('\u0001')).join('\u0002')

type Live<T> = { latest: { current: FlatLeaf<T>[] }; listeners: Set<() => void> }

function LiveCell<T extends object>({ live, id, row }: { live: Live<T>; id: string; row: T }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    live.listeners.add(redraw)
    return () => void live.listeners.delete(redraw)
  }, [live])
  return <>{renderLeaf(live.latest.current.find(item => item.id === id)?.leaf, row)}</>
}

function buildColumns<T extends object>(flat: FlatLeaf<T>[], live: Live<T>): ErpColDef<T>[] {
  return flat.map(({ id, leaf, group }) => {
    const width = typeof leaf.width === 'number' ? leaf.width : undefined
    const pin = leaf.fixed === true || leaf.fixed === 'left' ? 'left' : leaf.fixed === 'right' ? 'right' : undefined
    const extra: ErpColDef<T> = {
      sortable: false,
      wrapText: true,
      autoHeight: true,
      ...(width ? { width } : {}),
      ...(pin ? { pin } : {}),
      ...(group ? { group } : {}),
      ...(leaf.align === 'right' ? RIGHT_ALIGNED : {}),
    }
    return renderColumn<T>(textOf(leaf.title) || id, id, row => createElement(LiveCell<T>, { live, id, row }), extra)
  })
}

/** antd 列定义转成表格骨架的列（一次性转换，渲染函数取定义时的闭包）；页面写表格请用 SimpleGrid。 */
export function toGridColumns<T extends object>(columns: AntdColumns<T>): ErpColDef<T>[] {
  const flat = flattenColumns<T>(columns)
  return buildColumns<T>(flat, { latest: { current: flat }, listeners: new Set() })
}

export type SimpleGridProps<T extends object> = {
  gridId: string
  columns: AntdColumns<T>
  /** undefined 表示还没读到；读到的空数组显示 emptyState。 */
  rows: readonly T[] | undefined
  rowKey: (row: T) => Key
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  emptyState: Extract<DataStateProps, { kind: 'empty' }>
  onRowOpen?: (row: T) => void
  /** 行以外影响表格的条件变化时也要重取。 */
  resetKey?: string
  height?: number
  /** 传了就出现勾选列与底部批量栏（取代 antd 的 rowSelection）。 */
  renderBulkActions?: (rows: T[]) => ReactNode
  /** 勾选变化通知（页面自己的按钮要用勾选结果时）；传了就出现勾选列。 */
  onSelectionChange?: (rows: T[]) => void
}

/** antd 列定义转表格骨架列（列结构不变就复用，单元格始终用最新渲染函数）；服务端分页的页面配 PagedGrid 用。 */
export function useAntdGridColumns<T extends object>(columns: AntdColumns<T>): ErpColDef<T>[] {
  const flat = flattenColumns<T>(columns)
  const live = useRef<Live<T>>({ latest: { current: flat }, listeners: new Set() }).current
  live.latest.current = flat
  useEffect(() => {
    live.listeners.forEach(redraw => redraw())
  })
  const signature = signatureOf(flat)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildColumns<T>(flat, live), [signature, live])
}

export function SimpleGrid<T extends object>(props: SimpleGridProps<T>) {
  const { rows, loading, error } = props
  const gridColumns = useAntdGridColumns<T>(props.columns)
  if (error) return <DataState {...stateFromError(describeError(error), { onRetry: props.onRetry })} />
  if (rows === undefined) return loading ? <DataState kind="skeleton" rows={5} /> : null
  return (
    <LocalGrid<T>
      gridId={props.gridId}
      columns={gridColumns}
      rows={rows}
      getRowId={row => String(props.rowKey(row))}
      onRowOpen={props.onRowOpen}
      renderBulkActions={props.renderBulkActions}
      onSelectionChange={props.onSelectionChange}
      resetKey={props.resetKey}
      emptyState={props.emptyState}
      height={props.height ?? Math.min(MAX_HEIGHT, HEADER_HEIGHT + ROW_HEIGHT * Math.max(rows.length, 1) + 12)}
    />
  )
}
