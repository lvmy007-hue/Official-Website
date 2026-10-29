import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { Button, Card, Modal, Segmented, Space, Switch, Tag, Tooltip } from 'antd'
import type { EChartsOption } from 'echarts'
import type { EChartsType } from 'echarts/core'
import { describeError } from '../../query/errors'
import { erpTokens } from '../../theme/tokens'
import { DataState, type DataStateProps } from '../data-state/DataState'
import { stateFromError } from '../data-state/from-error'
import { EventBand } from './EventBand'
import { ErpChart } from './ErpChart'
import { withEventMarks, type ChartEvent } from './chart-utils'
import { chartBoundaryGap, chartCategories, chartGrid, optionToTable, withHighlight } from './chart-link'
import type { EventSource } from './use-events'

// 表格视图带着 AG Grid，单独成块，只有点“切换为表格”才加载
const ChartTable = lazy(() => import('./ChartTable'))

// 图表容器（03 章 3.2 第 6 项；3.3 “所有图表可下载”；P6-06 事件带、联动与表格视图）：
// 标题、可折叠、维度切换、事件标注开关、降采样提示、下载图片、全屏、切换为表格；ECharts 进入可视区才加载。
// 统一事件带：传 eventSource（对象类型与编号）后，图下方多一条按类型分行的事件带（见 EventBand）。
// 联动：图上点日期或系列通过 onCategoryClick 交给页面（页面让同页表格筛选）；页面把表格选中的日期或系列传回 activeCategory、highlightSeries 高亮。

export type ChartPanelProps = {
  title: string
  ariaLabel: string
  option: EChartsOption
  height?: number
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  /** 无数据时的说明。 */
  emptyState?: Extract<DataStateProps, { kind: 'empty' }>
  dimensions?: Array<{ value: string; label: string }>
  dimension?: string
  onDimensionChange?: (value: string) => void
  /** 提供事件后才出现“事件标注”开关；事件来自操作审计与同步差异。 */
  events?: readonly ChartEvent[]
  /** 图表数据被降采样时说明：显示了多少、共有多少。 */
  sampling?: { shown: number; total: number }
  defaultCollapsed?: boolean
  extra?: React.ReactNode
  /** 点击图上的数据点时回调：该点所在的横轴类目（例如日期）和系列名；用于“点选某天看归因”和与同页表格联动。 */
  onCategoryClick?: (category: string, series?: string) => void
  /** 统一事件带的对象；不传不显示事件带。只配日期横轴的图（类目是 YYYY-MM-DD）。 */
  eventSource?: EventSource
  /** 联动：图上高亮这个类目（画一条实线），例如表格里选中的日期。 */
  activeCategory?: string | null
  /** 联动：其余系列变淡，只突出这个系列。 */
  highlightSeries?: string | null
  /** 表格视图里点某一行时回调（把该类目交给页面做联动）。 */
  onTableRowFocus?: (category: string) => void
  /** 表格视图只显示这个类目。 */
  tableFilterCategory?: string | null
}

export function ChartPanel(props: ChartPanelProps) {
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? false)
  const [showEvents, setShowEvents] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const chartRef = useRef<EChartsType | null>(null)
  // 图表只初始化一次，点击回调通过 ref 取最新的，避免用到过期的闭包
  const clickRef = useRef(props.onCategoryClick)
  clickRef.current = props.onCategoryClick
  const [loadError, setLoadError] = useState<unknown>(null)

  const [asTable, setAsTable] = useState(false)

  const marked = useMemo(() => {
    const base = props.events && showEvents ? withEventMarks(props.option, props.events) : { option: props.option, shown: 0 }
    return { ...base, option: withHighlight(base.option, { series: props.highlightSeries, category: props.activeCategory }) }
  }, [props.option, props.events, showEvents, props.highlightSeries, props.activeCategory])
  const categories = useMemo(() => chartCategories(props.option), [props.option])
  const tableData = useMemo(() => optionToTable(props.option), [props.option])
  const grid = useMemo(() => chartGrid(props.option), [props.option])
  const boundaryGap = useMemo(() => chartBoundaryGap(props.option), [props.option])

  const download = () => {
    const chart = chartRef.current
    if (!chart) return
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: erpTokens.canvas })
    const link = document.createElement('a')
    link.href = url
    link.download = `${props.title}.png`
    link.click()
  }

  const body = (() => {
    if (props.error) return <DataState {...stateFromError(describeError(props.error), { onRetry: props.onRetry })} />
    if (loadError) return <DataState kind="server-error" message="图表组件加载失败，请刷新页面重试" onRetry={() => setLoadError(null)} />
    if (props.loading) return <DataState kind="skeleton" rows={4} />
    if (props.emptyState) return <DataState {...props.emptyState} />
    if (asTable && tableData)
      return (
        <Suspense fallback={<DataState kind="skeleton" rows={4} />}>
          <ChartTable title={props.title} data={tableData} filterCategory={props.tableFilterCategory} onRowFocus={props.onTableRowFocus} />
        </Suspense>
      )
    return (
      <>
        <ErpChart
          option={marked.option}
          ariaLabel={props.ariaLabel}
          height={props.height ?? 240}
          onReady={chart => {
            chartRef.current = chart
            chart?.on('click', (params: { name?: unknown; seriesName?: unknown }) => {
              if (typeof params.name === 'string' && params.name) clickRef.current?.(params.name, typeof params.seriesName === 'string' && params.seriesName ? params.seriesName : undefined)
            })
          }}
          onError={setLoadError}
        />
        {props.eventSource && categories.length > 0 ? <EventBand source={props.eventSource} categories={categories} grid={grid} boundaryGap={boundaryGap} /> : null}
      </>
    )
  })()

  const ready = !props.error && !props.loading && !props.emptyState && !loadError

  return (
    <Card
      size="small"
      data-testid="chart-panel"
      title={props.title}
      styles={{ body: { padding: collapsed ? 0 : 12 } }}
      extra={
        <Space size={8} wrap>
          {props.sampling && props.sampling.shown < props.sampling.total ? (
            <Tag bordered={false} color="warning">
              已抽样显示 {props.sampling.shown} / {props.sampling.total} 个点（保留极值）
            </Tag>
          ) : null}
          {props.dimensions && props.dimensions.length > 1 ? (
            <Segmented size="small" options={props.dimensions} value={props.dimension} onChange={value => props.onDimensionChange?.(String(value))} aria-label="维度切换" />
          ) : null}
          {props.events ? (
            <Tooltip title={props.events.length === 0 ? '所选时间范围内没有可标注的事件' : undefined}>
              <Space size={4}>
                <Switch size="small" checked={showEvents} onChange={setShowEvents} aria-label="事件标注" disabled={props.events.length === 0} />
                <span>事件标注</span>
              </Space>
            </Tooltip>
          ) : null}
          {props.extra}
          {ready && !collapsed ? (
            <>
              {tableData ? (
                <Button size="small" onClick={() => setAsTable(value => !value)} aria-pressed={asTable}>
                  {asTable ? '切换为图表' : '切换为表格'}
                </Button>
              ) : null}
              {asTable ? null : (
                <>
                  <Button size="small" onClick={download}>
                    下载图片
                  </Button>
                  <Button size="small" onClick={() => setFullscreen(true)}>
                    全屏
                  </Button>
                </>
              )}
            </>
          ) : null}
          <Button size="small" type="text" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>
            {collapsed ? '展开' : '折叠'}
          </Button>
        </Space>
      }
    >
      {collapsed ? null : body}
      {fullscreen ? (
        <Modal open title={props.title} footer={null} width="92vw" centered onCancel={() => setFullscreen(false)} destroyOnHidden>
          <ErpChart option={marked.option} ariaLabel={`${props.ariaLabel}（全屏）`} height="70vh" />
        </Modal>
      ) : null}
    </Card>
  )
}
