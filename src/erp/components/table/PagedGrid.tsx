import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pagination, Typography } from 'antd'
import { describeError } from '../../query/errors'
import { DataState, type DataStateProps } from '../data-state/DataState'
import { stateFromError } from '../data-state/from-error'
import { formatNumber } from '../../format'
import type { SortSpec } from './cursor-datasource'
import { useAsyncColumns } from './grid-async'
import { GridCore } from './grid-core'
import { SummaryError, buildSummaryRows, useGridSummary } from './grid-summary'
import { BulkBar, GridToolbar } from './grid-toolbar'
import { TREE_CHILD_LIMIT, useTreeRows, type TreeOptions } from './grid-tree'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_NUMBER, PAGE_SIZE_OPTIONS, type ErpColDef, type FetchSummary, type PageFetcher } from './grid-types'
import type { ViewFilterBinding } from './grid-view-layout'
import { useFilterSchemes } from './use-filter-schemes'
import { useGridLayout } from './use-grid-views'

// 页码分页表格（P6-02，15 章第 6 节）：与无限滚动的 MassiveGrid 共用列、工具栏、汇总行、异步列和主题，
// 区别是行从服务端按 page/pageSize/total 取，支持跳页和每页 20/50/100/200 条，适合需要“看到第几页”的宽表。
// - 排序交给服务端（只允许白名单字段、一次一列）；改排序、改每页条数、改筛选（resetKey）都回到第 1 页；
// - 翻页时旧数据保留到新数据返回，只在表格上方显示一条细进度线；
// - 页码超出范围（数据变少了）自动跳到最后一页；服务端返回的格式不对按失败处理，不拿坏数据画表；
// - 行内展开（tree）只作用于当前页已有的行，见 grid-tree。

export type PagedGridProps<T extends object> = {
  gridId: string
  columns: ErpColDef<T>[]
  fetchPage: PageFetcher<T>
  getRowId: (row: T) => string
  sortableFields?: Readonly<Record<string, string>>
  defaultSort?: SortSpec | null
  resetKey: string
  appliedFilterCount?: number
  onClearFilters?: () => void
  emptyState: Extract<DataStateProps, { kind: 'empty' }>
  fetchSummary?: FetchSummary
  onExport?: () => Promise<void> | void
  exportDisabledReason?: string
  /** 开启服务端视图（P6-03）：列显示、顺序、列宽、固定、排序、筛选存成我的 / 团队 / 系统视图；不开就沿用本机列配置。 */
  serverViews?: boolean
  /** 视图里的筛选与维度由页面提供与还原（见 ViewFilterBinding）；不传则视图只管列与排序。 */
  viewFilters?: ViewFilterBinding
  onCompare?: (rows: T[]) => void
  renderBulkActions?: (rows: T[]) => ReactNode
  /** 页面自己的操作按钮要用勾选结果时用它（出现勾选列，勾选变化时通知）；不需要底部批量栏。 */
  onSelectionChange?: (rows: T[]) => void
  onRowOpen?: (row: T) => void
  toolbarExtra?: ReactNode
  height?: number | string
  initialPageSize?: (typeof PAGE_SIZE_OPTIONS)[number]
  /** 行内展开（父子行）。 */
  tree?: TreeOptions<T>
}

type Loaded<T> = { items: T[]; total: number }
type Outcome<T> = { key: string; error: unknown; data: Loaded<T> | null }

const lastPageOf = (total: number, pageSize: number) => Math.max(1, Math.ceil(total / pageSize))
const sameSort = (a: SortSpec | null, b: SortSpec | null) => a?.field === b?.field && a?.direction === b?.direction

export function PagedGrid<T extends object>(props: PagedGridProps<T>) {
  const { gridId, getRowId, sortableFields, defaultSort = null, resetKey, appliedFilterCount = 0, emptyState } = props
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(props.initialPageSize ?? DEFAULT_PAGE_SIZE)
  const [sort, setSort] = useState<SortSpec | null>(defaultSort)
  const serverViews = props.serverViews === true
  const sortFields = useMemo(() => (sortableFields ? Object.values(sortableFields) : null), [sortableFields])
  // 视图里的排序为空表示“页面默认排序”，所以和默认排序相同的当前排序按空保存
  const layout = useGridLayout(props.columns, { gridId, serverViews, sortFields, sort: serverViews ? (sameSort(sort, defaultSort) ? null : sort) : undefined, binding: props.viewFilters })
  const { columns, hidden, ready } = layout
  const schemes = useFilterSchemes({ gridId, enabled: serverViews, binding: props.viewFilters })
  // 套用了另一个视图（含读取完成）：排序同步成视图里的排序，回到第 1 页
  const [seenView, setSeenView] = useState(layout.viewKey)
  if (seenView !== layout.viewKey) {
    setSeenView(layout.viewKey)
    setSort(layout.viewSort ?? defaultSort)
    setPage(1)
  }
  const [retryNonce, setRetryNonce] = useState(0)
  const [seenReset, setSeenReset] = useState(resetKey)
  const [latest, setLatest] = useState<Loaded<T> | null>(null)
  const [outcome, setOutcome] = useState<Outcome<T> | null>(null)
  const [selected, setSelected] = useState<T[]>([])
  const fetchRef = useRef(props.fetchPage)
  fetchRef.current = props.fetchPage

  // 筛选或范围变化：回到第 1 页（在渲染期间改状态，React 会在提交前立刻重渲染，不会用旧页码发请求）。
  if (seenReset !== resetKey) {
    setSeenReset(resetKey)
    setPage(1)
    setSelected([])
  }

  const sortKey = sort ? `${sort.field}:${sort.direction}` : ''
  const key = `${resetKey}|${page}|${pageSize}|${sortKey}|${retryNonce}`

  useEffect(() => {
    // 开了服务端视图的表格，等视图读完（默认视图可能带排序）再取第一页，免得白取一次
    if (!ready) return
    const controller = new AbortController()
    Promise.resolve()
      .then(() => fetchRef.current({ page, pageSize, sort, signal: controller.signal }))
      .then(result => {
        if (controller.signal.aborted) return
        const valid = result && Array.isArray(result.items) && Number.isFinite(result.total) && result.total >= 0
        if (!valid) throw new Error('服务端返回的分页数据格式不对')
        const last = lastPageOf(result.total, pageSize)
        if (result.items.length === 0 && result.total > 0 && page > last) {
          setPage(last)
          return
        }
        const data = { items: result.items, total: result.total }
        setLatest(data)
        setOutcome({ key, error: null, data })
      })
      .catch(error => {
        if (!controller.signal.aborted) setOutcome({ key, error, data: null })
      })
    return () => controller.abort()
    // key 已包含 resetKey、页码、每页条数、排序与重试次数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  const settled = outcome?.key === key ? outcome : null
  const failed = settled !== null && settled.data === null
  const loading = settled === null
  const items = useMemo(() => latest?.items ?? [], [latest])
  const total = latest?.total ?? 0
  const isEmpty = settled?.data !== null && settled?.data !== undefined && settled.data.total === 0

  const scopeKey = `${resetKey}|${page}|${pageSize}|${sortKey}`
  const treeRows = useTreeRows<T>(items, getRowId, props.tree, scopeKey)
  const summary = useGridSummary(props.fetchSummary, resetKey)
  const summaryRows = useMemo(() => buildSummaryRows(columns, summary.state), [columns, summary.state])
  const asyncColumns = useAsyncColumns(columns, hidden, `${resetKey}#${retryNonce}`)

  // 只有排序真的变了才回到第 1 页：列定义刷新等场景下表格可能重复通知同一个排序，不能因此把人从第 3 页拉回第 1 页。
  const onSortChanged = (next: SortSpec | null) => {
    const target = next ?? defaultSort
    if (sameSort(target, sort)) return
    setSort(target)
    setPage(1)
  }

  const notices = (
    <>
      {summary.state.status === 'error' && !failed ? <SummaryError onRetry={summary.retry} forbidden={summary.state.forbidden} /> : null}
      {treeRows.truncatedParents > 0 ? (
        <Typography.Text type="warning">
          部分父行的子行超过 {TREE_CHILD_LIMIT} 个，只显示了前 {TREE_CHILD_LIMIT} 个
        </Typography.Text>
      ) : null}
      {props.toolbarExtra}
    </>
  )

  return (
    <div data-testid="paged-grid" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <GridToolbar
        columns={columns}
        hidden={hidden}
        onVisibilityChange={layout.setVisible}
        pin={layout.views ? { pinned: layout.pinned, onChange: layout.setPin } : undefined}
        views={layout.views}
        schemes={schemes}
        appliedFilterCount={appliedFilterCount}
        onClearFilters={props.onClearFilters}
        countLabel={latest ? `共 ${formatNumber(total)} 行` : null}
        extra={notices}
        selected={selected}
        onCompare={props.onCompare}
        onExport={props.onExport}
        exportDisabledReason={props.exportDisabledReason}
      />

      {failed ? <DataState {...stateFromError(describeError(settled?.error), { onRetry: () => setRetryNonce(value => value + 1) })} /> : null}
      {!failed && isEmpty ? <DataState {...emptyState} /> : null}
      {!failed && !latest && loading ? <DataState kind="skeleton" rows={5} /> : null}
      {!failed && !isEmpty && latest && loading ? <div className="erp-grid-progress" role="progressbar" aria-label="正在刷新" /> : null}

      {latest && !failed && !isEmpty ? (
        <>
          <GridCore<T>
            columns={columns}
            hidden={hidden}
            sortableFields={sortableFields}
            getRowId={getRowId}
            rowData={treeRows.rows}
            summaryRows={summaryRows}
            summaryCurrency={summary.state.status === 'ready' ? summary.state.currency : null}
            tree={treeRows.controller}
            asyncColumns={asyncColumns}
            selectable={!!(props.onCompare || props.renderBulkActions || props.onSelectionChange)}
            onSelectionChanged={rows => {
              setSelected(rows)
              props.onSelectionChange?.(rows)
            }}
            onRowOpen={props.onRowOpen}
            onSortChanged={onSortChanged}
            sort={serverViews ? sort : undefined}
            onLayout={layout.onLayout}
            height={props.height}
            busy={loading}
          />
          {props.renderBulkActions ? <BulkBar count={selected.length}>{props.renderBulkActions(selected)}</BulkBar> : null}
          <Pagination
            align="end"
            size="small"
            current={page}
            pageSize={pageSize}
            total={total}
            showSizeChanger
            showQuickJumper
            pageSizeOptions={PAGE_SIZE_OPTIONS.map(String)}
            showTotal={count => `共 ${formatNumber(count)} 条`}
            onChange={(nextPage, nextSize) => {
              if (nextSize !== pageSize) {
                setPageSize(nextSize)
                setPage(1)
              } else setPage(Math.min(nextPage, MAX_PAGE_NUMBER))
            }}
          />
        </>
      ) : null}
    </div>
  )
}
