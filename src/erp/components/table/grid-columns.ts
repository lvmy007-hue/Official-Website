import { createElement, type ComponentType } from 'react'
import type { ColDef, ColGroupDef, ICellRendererParams, ValueFormatterParams, ValueGetterParams } from 'ag-grid-community'
import { AsyncCell } from './grid-async'
import { MetricHeader } from './metric-help'
import { SUMMARY_LABEL_KEY, SummaryLabelCell, SummaryValueCell } from './grid-summary'
import { TreeCell } from './grid-tree'
import { columnId, type ErpColDef } from './grid-types'

// 列定义的转换（P6-02）：把页面写的 ErpColDef（固定列、分组、异步列、汇总行与树形的需要）变成 AG Grid 认识的 ColDef / ColGroupDef。
// 这里是纯函数，除了挑选单元格渲染器之外不碰界面状态，便于单测。

export type PrepareOptions<T> = {
  columns: readonly ErpColDef<T>[]
  hidden: readonly string[]
  /** 白名单：列标识 → 服务端排序字段。不在表里的列不可排序。 */
  sortableFields?: Readonly<Record<string, string>>
  /** 排序由服务端做（页码分页）：表格本地不再重排当前页。 */
  serverSort?: boolean
  /** 有汇总行：汇总行里每列取自己的列标识下的值，自定义渲染器改为显示格式化后的文字。 */
  summary?: boolean
  /** 有行内展开：第一列带缩进与展开按钮。 */
  tree?: boolean
  /** 当前排序（服务端字段）：传了就把列头排序箭头设成它（null 表示都不排序）；不传不干预。 */
  sort?: { field: string; direction: 'asc' | 'desc' } | null
}

type AnyRenderer = ComponentType<ICellRendererParams> | string | undefined
const asComponent = (renderer: AnyRenderer): ComponentType<ICellRendererParams> | null => (typeof renderer === 'function' ? renderer : null)

function leafDef<T>(col: ErpColDef<T>, firstVisible: boolean, options: PrepareOptions<T>): ColDef<T> {
  const { pin, group: _group, async: asyncSpec, metric, ...rest } = col
  const id = columnId(col)
  const def: ColDef<T> = { cellDataType: false, ...rest }
  if (id) def.colId = id
  // 列头问号：内容全部取自指标字典，页面只给键（metric-help）
  if (metric) {
    def.headerComponent = MetricHeader
    def.headerComponentParams = { metric }
  }
  def.hide = options.hidden.includes(id)
  def.sortable = !asyncSpec && !!options.sortableFields && Object.prototype.hasOwnProperty.call(options.sortableFields, id)
  def.resizable = true
  if (pin ?? rest.pinned) {
    def.pinned = pin ?? rest.pinned
    def.lockPinned = true
  }
  if (def.sortable && options.serverSort) def.comparator = () => 0
  if (def.sortable && options.sort !== undefined) def.sort = options.sort && options.sortableFields?.[id] === options.sort.field ? options.sort.direction : null

  const field = typeof col.field === 'string' ? col.field : id
  if (options.summary) {
    const own = typeof rest.valueGetter === 'function' ? rest.valueGetter : null
    def.valueGetter = (params: ValueGetterParams<T>) => {
      const data = params.data as Record<string, unknown> | undefined
      if (params.node?.rowPinned) return firstVisible ? data?.[SUMMARY_LABEL_KEY] : data?.[id]
      return own ? own(params) : data?.[field]
    }
  }

  if (asyncSpec) {
    const inner = asComponent(rest.cellRenderer as AnyRenderer)
    def.cellRenderer = AsyncCell
    def.cellRendererParams = {
      asyncKey: asyncSpec.key,
      asyncSpec,
      field,
      format: (value: unknown, params: ICellRendererParams) =>
        typeof rest.valueFormatter === 'function' ? rest.valueFormatter({ ...params, value } as unknown as ValueFormatterParams<T>) : String(value),
      inner: inner ? (params: ICellRendererParams) => createElement(inner, params) : undefined,
    }
  }
  return options.summary || options.tree ? withSelector(def, firstVisible, options) : def
}

// 汇总行与树形都需要在“特定行”换渲染器，所以统一用选择器：汇总行 → 标签/文字；第一列的数据行 → 带缩进的树形格；其余原样。
function withSelector<T>(def: ColDef<T>, firstVisible: boolean, options: PrepareOptions<T>): ColDef<T> {
  const original = def.cellRenderer as AnyRenderer
  const originalParams = def.cellRendererParams as unknown
  const wantsTree = !!options.tree && firstVisible
  if (!(options.summary && (firstVisible || original)) && !wantsTree) return def
  const { cellRenderer: _renderer, cellRendererParams: _params, ...rest } = def
  const inner = asComponent(original)
  return {
    ...rest,
    cellRendererSelector: params => {
      if (params.node.rowPinned) return { component: firstVisible ? SummaryLabelCell : SummaryValueCell }
      if (wantsTree) return { component: TreeCell, params: { inner: inner ? (p: ICellRendererParams) => createElement(inner, { ...p, ...(originalParams as object) }) : undefined } }
      return original ? { component: original, params: originalParams } : undefined
    },
  }
}

const firstVisibleIndex = <T>(columns: readonly ErpColDef<T>[], hidden: readonly string[]) => columns.findIndex(col => !hidden.includes(columnId(col)))

/** 页面列 → AG Grid 列：相邻且同名的 group 并成一组两层表头；ErpColDef 自己的三个键在这里剥掉。 */
export function prepareColumnDefs<T>(options: PrepareOptions<T>): Array<ColDef<T> | ColGroupDef<T>> {
  const first = firstVisibleIndex(options.columns, options.hidden)
  const out: Array<ColDef<T> | ColGroupDef<T>> = []
  let run: { name: string; group: ColGroupDef<T> } | null = null
  let groupSeq = 0
  options.columns.forEach((col, index) => {
    const leaf = leafDef(col, index === first, options)
    if (!col.group) {
      run = null
      out.push(leaf)
      return
    }
    if (!run || run.name !== col.group) {
      groupSeq += 1
      const group: ColGroupDef<T> = { headerName: col.group, groupId: `erp-group-${groupSeq}`, headerClass: 'erp-group-header', children: [] }
      run = { name: col.group, group }
      out.push(group)
    }
    run.group.children.push(leaf)
  })
  return out
}

export type PanelItem = { id: string; label: string }
export type ColumnPanelModel = { ungrouped: PanelItem[]; groups: Array<{ name: string; items: PanelItem[] }> }

/** 列配置面板的结构：没有分组的列平铺在上面，同名分组不管是否相邻都并在一起，按首次出现的顺序排。 */
export function columnPanelModel<T>(columns: readonly ErpColDef<T>[]): ColumnPanelModel {
  const model: ColumnPanelModel = { ungrouped: [], groups: [] }
  const byName = new Map<string, PanelItem[]>()
  for (const col of columns) {
    const id = columnId(col)
    if (!id) continue
    const item = { id, label: col.headerName ?? id }
    if (!col.group) {
      model.ungrouped.push(item)
      continue
    }
    let items = byName.get(col.group)
    if (!items) {
      items = []
      byName.set(col.group, items)
      model.groups.push({ name: col.group, items })
    }
    items.push(item)
  }
  return model
}
