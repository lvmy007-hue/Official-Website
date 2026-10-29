import { useEffect, useMemo, useRef } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef, ColGroupDef, ColumnMovedEvent, ColumnResizedEvent, GridApi, GridReadyEvent, IDatasource, RowClickedEvent, SelectionChangedEvent, SortChangedEvent } from 'ag-grid-community'
import { erpGridLocaleText, erpGridThemeFor, registerErpGridModules } from '../../theme/ag-grid-theme'
import { useDensity } from '../../theme/density'
import { BLOCK_SIZE, MAX_CACHED_BLOCKS, pickSort, type SortSpec } from './cursor-datasource'
import type { AsyncColumns } from './grid-async'
import { prepareColumnDefs } from './grid-columns'
import type { TreeController } from './grid-tree'
import type { ErpColDef } from './grid-types'
import { layoutEventOf, type LayoutEvent } from './grid-view-layout'
import { MetricHelpProvider } from './metric-help'
import './grid.css'

// 表格内核（P6-02 从 MassiveGrid 拆出）：无限滚动与页码分页共用同一套列、汇总行、异步列、选择与主题；
// 两种模式只在“行从哪来”上不同：infinite 走游标数据源，client 吃一页已有的行。

export type GridCoreProps<T extends object> = {
  columns: readonly ErpColDef<T>[]
  hidden: string[]
  sortableFields?: Readonly<Record<string, string>>
  getRowId: (row: T) => string
  /** 无限滚动：给数据源；页码分页：给当前页的行。 */
  datasource?: IDatasource
  rowData?: readonly T[]
  /** 钉在表头下方的汇总行（没有汇总时传空数组）。 */
  summaryRows: Record<string, unknown>[]
  summaryCurrency: string | null
  tree: TreeController | null
  asyncColumns: AsyncColumns | null
  selectable: boolean
  onSelectionChanged: (rows: T[]) => void
  onRowOpen?: (row: T) => void
  /** 页码分页：排序变化回调（服务端排序）；无限滚动不用，排序随取数请求带走。 */
  onSortChanged?: (sort: SortSpec | null) => void
  /** 当前排序（服务端字段）：传了就让列头的排序箭头跟着它走（套用视图时排序会被改掉）；不传沿用 AG Grid 自己的状态。 */
  sort?: SortSpec | null
  height?: number | string
  hideBody?: boolean
  busy?: boolean
  /** 用户拖动列、拉宽后通知（服务端视图用来记下“有未保存的修改”）；不传就不监听。 */
  onLayout?: (event: LayoutEvent) => void
}

export function GridCore<T extends object>(props: GridCoreProps<T>) {
  const { columns, hidden, sortableFields, summaryRows, tree, asyncColumns } = props
  registerErpGridModules()
  const density = useDensity()
  const apiRef = useRef<GridApi<T> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clientMode = props.rowData !== undefined
  const hasSummary = summaryRows.length > 0

  const columnDefs = useMemo<Array<ColDef<T> | ColGroupDef<T>>>(
    () => prepareColumnDefs<T>({ columns, hidden, sortableFields, serverSort: clientMode, summary: hasSummary, tree: tree !== null, sort: props.sort }),
    [columns, hidden, sortableFields, clientMode, hasSummary, tree, props.sort],
  )
  const context = useMemo(() => ({ summaryCurrency: props.summaryCurrency, tree, asyncStore: asyncColumns?.store }), [props.summaryCurrency, tree, asyncColumns?.store])

  // 对当前渲染出来的行发异步列请求：数据块到达、滚动停下、列显示变化时各触发一次（合并到同一个宏任务里）。
  const asyncScan = useRef(asyncColumns?.scan)
  asyncScan.current = asyncColumns?.scan
  const scanSoon = useMemo(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => asyncScan.current?.(apiRef.current), 0)
    },
    [],
  )
  useEffect(() => {
    scanSoon()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [scanSoon, asyncColumns?.specs, asyncColumns?.store])

  // 展开/收起只改行里的 __treeState，列的取值不变，表格不会重画缩进列的单元格，所以行数据更新后强制刷新一次。
  const treeActive = tree !== null

  const onSortChanged = (event: SortChangedEvent<T>) => {
    if (!props.onSortChanged) return
    const model = event.api.getColumnState().flatMap(state => (state.sort ? [{ colId: state.colId, sort: state.sort }] : []))
    props.onSortChanged(pickSort(model, sortableFields, null))
  }

  const metricIds = useMemo(() => [...new Set(columns.map(col => col.metric).filter((id): id is string => Boolean(id)))], [columns])
  const onColumnLayout = (event: ColumnMovedEvent<T> | ColumnResizedEvent<T>) => {
    const change = props.onLayout ? layoutEventOf(event) : null
    if (change) props.onLayout?.(change)
  }

  return (
    <MetricHelpProvider ids={metricIds}>
      <div className="erp-grid-body" style={{ height: props.height ?? 520, display: props.hideBody ? 'none' : 'block' }} aria-busy={props.busy}>
        <AgGridReact<T>
          theme={erpGridThemeFor(density)}
          rowModelType={clientMode ? 'clientSide' : 'infinite'}
          {...(clientMode ? { rowData: props.rowData as T[] } : { datasource: props.datasource, cacheBlockSize: BLOCK_SIZE, maxBlocksInCache: MAX_CACHED_BLOCKS, infiniteInitialRowCount: BLOCK_SIZE })}
          // 本地小表（一页最多 50 行）整页渲染，不做行虚拟化：行数少没有性能代价，屏幕阅读器与测试也能看到全部行
          {...(clientMode && (props.rowData?.length ?? 0) <= 50 ? { rowBuffer: 50 } : {})}
          pinnedTopRowData={summaryRows}
          columnDefs={columnDefs}
          context={context}
          getRowId={params => props.getRowId(params.data)}
          localeText={erpGridLocaleText}
          rowSelection={props.selectable ? { mode: 'multiRow', checkboxes: true, headerCheckbox: false, enableClickSelection: false } : undefined}
          suppressMultiSort
          onGridReady={(event: GridReadyEvent<T>) => {
            apiRef.current = event.api
            scanSoon()
          }}
          onSelectionChanged={(event: SelectionChangedEvent<T>) => props.onSelectionChanged(event.api.getSelectedRows())}
          onRowClicked={(event: RowClickedEvent<T>) => {
            if (!event.data || event.node.rowPinned || !props.onRowOpen) return
            // 单元格里自带动作的按钮（带 data-no-row-open）不触发“打开行详情”
            const target = event.event?.target
            if (target instanceof Element && target.closest('[data-no-row-open], button, a, input, .ant-btn')) return
            props.onRowOpen(event.data)
          }}
          onSortChanged={onSortChanged}
          onModelUpdated={event => {
            if (treeActive) event.api.refreshCells({ force: true })
            scanSoon()
          }}
          onBodyScrollEnd={scanSoon}
          onColumnMoved={onColumnLayout}
          onColumnResized={onColumnLayout}
        />
      </div>
    </MetricHelpProvider>
  )
}
