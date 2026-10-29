import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import { describeError } from '../../query/errors'
import { DataState, type DataStateProps } from '../data-state/DataState'
import { stateFromError } from '../data-state/from-error'
import { formatNumber } from '../../format'
import { createCursorDatasource, type CursorFetcher, type SortSpec } from './cursor-datasource'
import { useAsyncColumns } from './grid-async'
import { GridCore } from './grid-core'
import { BulkBar, COMPARE_MAX, COMPARE_MIN, GridToolbar } from './grid-toolbar'
import { SummaryError, buildSummaryRows, useGridSummary } from './grid-summary'
import type { ErpColDef, FetchSummary } from './grid-types'
import type { ViewFilterBinding } from './grid-view-layout'
import { useFilterSchemes } from './use-filter-schemes'
import { useGridLayout } from './use-grid-views'

// 海量表格（03 章 3.2 第 7 项；12 章 12.2；15 章第 6 节）：
// 无限滚动 + 服务端游标分页；每块 100 行、最多缓存 10 块；只允许白名单字段排序；
// 列配置（固定列、两层表头、按组折叠）、保存视图、导出、已应用条件数、对比模式（选 2 至 5 个对象）、汇总行、异步列。
// 内核与工具栏在 grid-core、grid-toolbar，和页码分页的 PagedGrid 共用。没有接口支撑的功能不传对应属性就不显示，不做假按钮。

export { COMPARE_MAX, COMPARE_MIN }

export type MassiveGridProps<T extends object> = {
  /** 表格标识：列配置按它分别记在本机。 */
  gridId: string
  columns: ErpColDef<T>[]
  fetchPage: CursorFetcher<T>
  getRowId: (row: T) => string
  /** 白名单：列标识 → 服务端排序字段。 */
  sortableFields?: Readonly<Record<string, string>>
  defaultSort?: SortSpec | null
  /** 筛选条件、范围变化时必须变化，用来让表格重新从第一块开始取数。 */
  resetKey: string
  /** 已应用的筛选条件个数（不含全局范围）。 */
  appliedFilterCount?: number
  onClearFilters?: () => void
  /** 无数据时的说明（数据域、前置条件、同步入口），由页面按业务给出。 */
  emptyState: Extract<DataStateProps, { kind: 'empty' }>
  /** 汇总：服务端口径，显示在表头下方；不传则没有汇总行，前端不自行求和。 */
  fetchSummary?: FetchSummary
  onExport?: () => Promise<void> | void
  /** 有导出能力但当前不可用时说明原因（例如缺少权限）；两者都不传则不显示导出。 */
  exportDisabledReason?: string
  /** 开启服务端视图（P6-03）：列显示、顺序、列宽、固定存成我的 / 团队 / 系统视图（无限滚动的排序随取数请求走，不进视图）；不开就沿用本机列配置。 */
  serverViews?: boolean
  /** 视图里的筛选与维度由页面提供与还原；不传则视图只管列。 */
  viewFilters?: ViewFilterBinding
  /** 对比模式：选 2 至 5 个对象后触发。 */
  onCompare?: (rows: T[]) => void
  /** 勾选后出现的批量动作栏内容（须由页面经动作守卫生成）。 */
  renderBulkActions?: (rows: T[]) => ReactNode
  onRowOpen?: (row: T) => void
  toolbarExtra?: ReactNode
  height?: number | string
}

export function MassiveGrid<T extends object>(props: MassiveGridProps<T>) {
  const { gridId, fetchPage, getRowId, sortableFields, defaultSort, resetKey, appliedFilterCount = 0, emptyState } = props
  const layout = useGridLayout(props.columns, { gridId, serverViews: props.serverViews === true, sortFields: null, binding: props.viewFilters })
  const { columns, hidden } = layout
  const schemes = useFilterSchemes({ gridId, enabled: props.serverViews === true, binding: props.viewFilters })
  const [retryNonce, setRetryNonce] = useState(0)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  // 状态与选择都绑定到数据源实例：换了数据源（筛选变化、重试）就自动回到“加载中”、清空选择，不用在渲染里改状态。
  type Snapshot = { owner: object; status: 'ready' | 'empty' | 'error'; error?: unknown; total?: number | null; selected?: T[] }
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  // 筛选或范围变化（resetKey）、点击重试时，建一个全新的数据源：旧游标作废、缓存清空。
  const datasource = useMemo(() => {
    void resetKey
    void retryNonce
    const owner = {}
    const ds = createCursorDatasource<T>({
      fetchPage: async args => {
        const result = await fetchRef.current(args)
        if (args.cursor === null) setSnapshot(prev => ({ ...(prev?.owner === owner ? prev : {}), owner, status: result.items.length === 0 ? 'empty' : 'ready' }))
        return result
      },
      sortableFields,
      defaultSort,
      onTotal: total => setSnapshot(prev => (prev?.owner === owner ? { ...prev, total } : { owner, status: 'ready', total })),
      onError: err => setSnapshot({ owner, status: 'error', error: err }),
    })
    return Object.assign(ds, { owner })
    // sortableFields、defaultSort 视为页面常量
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, retryNonce])
  const current = snapshot && snapshot.owner === datasource.owner ? snapshot : null
  const status: 'loading' | 'ready' | 'empty' | 'error' = current?.status ?? 'loading'
  const approxTotal = current?.total ?? null
  const selected = current?.selected ?? []
  const setSelected = (rows: T[]) => setSnapshot(prev => (prev?.owner === datasource.owner ? { ...prev, selected: rows } : { owner: datasource.owner, status: 'ready', selected: rows }))

  // 严格模式下副作用会“挂载→清理→再挂载”，所以清理里作废、挂载时恢复。
  useEffect(() => {
    datasource.revive()
    return () => datasource.destroy()
  }, [datasource])

  const summary = useGridSummary(props.fetchSummary, `${resetKey}#${retryNonce}`)
  const summaryRows = useMemo(() => buildSummaryRows(columns, summary.state), [columns, summary.state])
  const asyncColumns = useAsyncColumns(columns, hidden, `${resetKey}#${retryNonce}`)

  return (
    <div data-testid="massive-grid" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <GridToolbar
        columns={columns}
        hidden={hidden}
        onVisibilityChange={layout.setVisible}
        pin={layout.views ? { pinned: layout.pinned, onChange: layout.setPin } : undefined}
        views={layout.views}
        schemes={schemes}
        appliedFilterCount={appliedFilterCount}
        onClearFilters={props.onClearFilters}
        countLabel={approxTotal !== null ? `约 ${formatNumber(approxTotal)} 行` : null}
        extra={props.toolbarExtra}
        summaryNotice={summary.state.status === 'error' && status === 'ready' ? <SummaryError onRetry={summary.retry} forbidden={summary.state.forbidden} /> : null}
        selected={selected}
        onCompare={props.onCompare}
        onExport={props.onExport}
        exportDisabledReason={props.exportDisabledReason}
      />

      {status === 'error' ? <DataState {...stateFromError(describeError(current?.error), { onRetry: () => setRetryNonce(value => value + 1) })} /> : null}
      {status === 'empty' ? <DataState {...emptyState} /> : null}

      <GridCore<T>
        columns={columns}
        hidden={hidden}
        sortableFields={sortableFields}
        getRowId={getRowId}
        datasource={datasource}
        summaryRows={summaryRows}
        summaryCurrency={summary.state.status === 'ready' ? summary.state.currency : null}
        tree={null}
        asyncColumns={asyncColumns}
        selectable={!!(props.onCompare || props.renderBulkActions)}
        onSelectionChanged={setSelected}
        onRowOpen={props.onRowOpen}
        onLayout={layout.onLayout}
        height={props.height}
        hideBody={status === 'error' || status === 'empty'}
        busy={status === 'loading'}
      />

      {props.renderBulkActions ? <BulkBar count={selected.length}>{props.renderBulkActions(selected)}</BulkBar> : null}
    </div>
  )
}
