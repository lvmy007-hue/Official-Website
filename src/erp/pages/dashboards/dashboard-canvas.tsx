import { lazy, Suspense, useEffect, useState } from 'react'
import { Button } from 'antd'
import { DASHBOARD_COLS, WIDGET_TYPE_LABEL, isWidgetType, moveItem, resizeItem, type DashboardLayout } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { LocalGrid, textColumn } from '../../components'

// 仪表盘画布（P6-33）。12 列网格，指针拖拽和缩放，不使用第三方拖拽库。图表单独懒加载。

const ChartView = lazy(() => import('./dashboard-chart'))

export interface WidgetView {
  id: string
  type: string
  query: { source?: string; metrics?: string[] }
  options: { text?: string; metric?: string }
  version: number
}

interface Row {
  id: string
  label: string
  values: Record<string, number | null>
}

interface Ready {
  state: 'OK' | 'EMPTY' | 'RESTRICTED' | 'TEXT'
  message?: string
  text?: string
  result?: { columns: Array<{ key: string; label: string }>; rows: Row[] }
}

const ROW = 48

export function DashboardCanvas(props: {
  dashboardId: string
  name: string
  layout: DashboardLayout
  widgets: WidgetView[]
  version: number
  refreshMinutes: number | null
  canWrite: boolean
  search: string
  tick: number
  onSaved: (version: number, layout: DashboardLayout) => void
  onChanged: () => void
}) {
  const [layout, setLayout] = useState(props.layout)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    setLayout(props.layout)
    setDirty(false)
  }, [props.layout])

  const drag = (widgetId: string, mode: 'move' | 'resize', event: React.PointerEvent<HTMLElement>) => {
    if (!props.canWrite) return
    const grid = event.currentTarget.closest('[data-testid="dashboard-canvas"]') as HTMLElement | null
    const width = grid?.getBoundingClientRect().width ?? 0
    const cell = Math.max(40, width / DASHBOARD_COLS)
    const startX = event.clientX
    const startY = event.clientY
    const origin = layout.items.find(item => item.widgetId === widgetId)
    if (!origin) return
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - startX) / cell)
      const dy = Math.round((ev.clientY - startY) / ROW)
      setLayout(current => (mode === 'move' ? moveItem(current, widgetId, origin.x + dx, origin.y + dy) : resizeItem(current, widgetId, origin.w + dx, origin.h + dy)))
      setDirty(true)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const save = async () => {
    const data = await apiFetch<{ version: number }>(`/dashboards/${props.dashboardId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: props.name, layout, version: props.version }),
    })
    setDirty(false)
    props.onSaved(data.version, layout)
  }

  const removeWidget = async (widgetId: string) => {
    setMessage(null)
    try {
      await apiFetch(`/dashboards/${props.dashboardId}/widgets/${widgetId}`, { method: 'DELETE' })
      props.onChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败')
    }
  }

  return (
    <div>
      <div data-testid="dashboard-canvas" style={{ display: 'grid', gridTemplateColumns: `repeat(${DASHBOARD_COLS}, 1fr)`, gap: 8 }}>
        {layout.items.map(item => {
          const widget = props.widgets.find(row => row.id === item.widgetId)
          if (!widget) return null
          return (
            <section
              key={item.widgetId}
              data-testid={`widget-${item.widgetId}`}
              style={{ gridColumn: `${item.x + 1} / span ${item.w}`, gridRow: `${item.y + 1} / span ${item.h}`, border: '1px solid var(--ant-color-border)', padding: 8, minHeight: ROW }}
            >
              <header style={{ display: 'flex', justifyContent: 'space-between' }}>
                <button type="button" data-testid={`drag-${item.widgetId}`} aria-label="拖动组件" onPointerDown={event => drag(item.widgetId, 'move', event)}>
                  {isWidgetType(widget.type) ? WIDGET_TYPE_LABEL[widget.type] : widget.type}
                </button>
                {props.canWrite ? (
                  <button type="button" aria-label="删除组件" data-testid={`remove-${item.widgetId}`} onClick={() => void removeWidget(item.widgetId)}>
                    删除
                  </button>
                ) : null}
                {props.canWrite ? (
                  <button type="button" aria-label="调整大小" data-testid={`resize-${item.widgetId}`} onPointerDown={event => drag(item.widgetId, 'resize', event)}>
                    缩放
                  </button>
                ) : null}
              </header>
              <WidgetBody widget={widget} dashboardId={props.dashboardId} search={props.search} tick={props.tick} />
            </section>
          )
        })}
      </div>
      {props.canWrite ? (
        <Button style={{ marginTop: 8 }} disabled={!dirty} onClick={() => void save().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '保存失败'))}>
          保存布局
        </Button>
      ) : null}
      {props.refreshMinutes ? <p>整盘每 {props.refreshMinutes} 分钟自动刷新，最快 5 分钟。每个组件也可以单独刷新。</p> : null}
      {message ? <p>{message}</p> : null}
    </div>
  )
}

function WidgetBody(props: { widget: WidgetView; dashboardId: string; search: string; tick: number }) {
  const [data, setData] = useState<Ready | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    void apiFetch<Ready>(`/dashboards/${props.dashboardId}/widgets/${props.widget.id}${props.search}`)
      .then(row => {
        if (!cancelled) setData(row)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '读取失败')
      })
    return () => {
      cancelled = true
    }
  }, [props.dashboardId, props.widget.id, props.search, props.tick, nonce])
  return (
    <div data-testid={`body-${props.widget.id}`}>
      <button type="button" onClick={() => setNonce(value => value + 1)}>
        刷新
      </button>
      {error ? <p>{error}</p> : null}
      {!data && !error ? <p>读取中</p> : null}
      {data?.state === 'RESTRICTED' ? <p>无权查看</p> : null}
      {data?.state === 'EMPTY' ? <p>尚无记录</p> : null}
      {data?.state === 'TEXT' ? <p>{data.text}</p> : null}
      {data?.state === 'OK' ? <ReadyView widget={props.widget} rows={data.result?.rows ?? []} columns={data.result?.columns ?? []} /> : null}
    </div>
  )
}

function ReadyView(props: { widget: WidgetView; rows: Row[]; columns: Array<{ key: string; label: string }> }) {
  const type = props.widget.type
  const metric = props.widget.options.metric ?? props.widget.query.metrics?.[0] ?? ''
  if (type === 'METRIC_CARD') {
    const value = props.rows[0]?.values[metric]
    return <strong data-testid={`metric-${props.widget.id}`}>{value === null || value === undefined ? '尚无记录' : String(value)}</strong>
  }
  if (type === 'TABLE') {
    const metricColumns = props.columns.map(column =>
      textColumn<Row>(column.label, 'id', {
        colId: column.key,
        valueGetter: params => params.data?.values[column.key] ?? '—',
      }),
    )
    return (
      <LocalGrid<Row>
        gridId={`dashboards.widget.${props.widget.id}`}
        rows={props.rows}
        columns={[textColumn<Row>('名称', 'label', { flex: 1 }), ...metricColumns]}
        getRowId={row => row.id}
        emptyState={{ kind: 'empty', domain: '组件', prerequisite: '这次查询没有行' }}
        height={220}
      />
    )
  }
  if (!isWidgetType(type) || type === 'TEXT') return null
  return (
    <Suspense fallback={<p>读取中</p>}>
      <ChartView type={type} rows={props.rows} metric={metric} label={props.columns.find(column => column.key === metric)?.label ?? metric} />
    </Suspense>
  )
}
