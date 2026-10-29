import { lazy, Suspense, useEffect, useState } from 'react'
import { useParams, useRouterState } from '@tanstack/react-router'
import { Alert, Button, Card, Form, Input, Select } from 'antd'
import { CUSTOM_REPORT_SOURCES, DASHBOARD_WRITE, WIDGET_TYPE_LABEL, WIDGET_TYPES, isWidgetType, type DashboardLayout, type WidgetType } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { apiFetch } from '../../../api'
import { DataState, PageHeader } from '../../components'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { DashboardTree, type DashCard, type FolderNode } from './dashboard-tree'
import type { WidgetView } from './dashboard-canvas'

// 仪表盘详情（P6-33）。画布和图表都是懒加载，列表页不会把它们打进首屏。

const Canvas = lazy(() => import('./dashboard-canvas').then(mod => ({ default: mod.DashboardCanvas })))

interface Detail {
  id: string
  name: string
  version: number
  refreshMinutes: number | null
  canWrite: boolean
  layout: DashboardLayout
  widgets: WidgetView[]
}

interface Tree {
  folders: FolderNode[]
  dashboards: DashCard[]
  shared: DashCard[]
}

export default function DashboardDetailPage() {
  const { me } = useSession()
  const params = useParams({ strict: false })
  const id = typeof params.id === 'string' ? params.id : ''
  const search = useRouterState({ select: state => state.location.searchStr })
  const [detail, setDetail] = useState<Detail | null>(null)
  const [tree, setTree] = useState<Tree>({ folders: [], dashboards: [], shared: [] })
  const [message, setMessage] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const canWrite = hasPermission(me.permissions, DASHBOARD_WRITE)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setLoadError(null)
    void Promise.all([apiFetch<Detail>(`/dashboards/${id}`), apiFetch<Tree>('/dashboards/tree')])
      .then(([row, folders]) => {
        if (cancelled) return
        setDetail(row)
        setTree(folders)
        setIsLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setDetail(null)
        setLoadError(describeError(error).message)
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  useEffect(() => {
    const minutes = detail?.refreshMinutes
    if (!minutes || minutes < 5) return
    const timer = window.setInterval(() => setTick(value => value + 1), minutes * 60_000)
    return () => window.clearInterval(timer)
  }, [detail?.refreshMinutes])

  const reload = async () => {
    try {
      setDetail(await apiFetch<Detail>(`/dashboards/${id}`))
    } catch (error) {
      setMessage(describeError(error).message)
    }
  }

  const addWidget = async (values: { type: WidgetType; source?: string; metric?: string; text?: string }) => {
    if (!detail) return
    const source = CUSTOM_REPORT_SOURCES.find(item => item.code === values.source)
    const body =
      values.type === 'TEXT'
        ? { type: 'TEXT', options: { text: values.text ?? '' } }
        : {
            type: values.type,
            query: source ? { source: source.code, dimension: source.dimensions[0]?.code ?? 'day', metrics: [values.metric ?? source.columns[0]?.key ?? 'units'] } : undefined,
          }
    const created = await apiFetch<{ dashboardVersion: number }>(`/dashboards/${id}/widgets`, { method: 'POST', body: JSON.stringify(body) })
    const next = await apiFetch<Detail>(`/dashboards/${id}`)
    setDetail({ ...next, version: created.dashboardVersion || next.version })
  }

  return (
    <>
      <PageHeader title={detail?.name ?? '仪表盘'} description="拖动标题移动组件，拖动缩放改变大小。保存后下次打开按同一布局还原。" />
      {isLoading ? <DataState kind="skeleton" rows={6} /> : null}
      {loadError ? <DataState kind="server-error" message={loadError} onRetry={() => setAttempt(value => value + 1)} /> : null}
      {message ? <Alert type="error" showIcon message={message} /> : null}
      {!isLoading && !loadError ? (
        <div style={{ display: 'flex', gap: 16 }}>
          <DashboardTree folders={tree.folders} selected={null} onSelect={() => undefined} extra={<a href={`/app/dashboards${search}`}>返回列表</a>} />
          <div style={{ flex: 1 }}>
            {detail ? (
              <Suspense fallback={<p>读取中</p>}>
                <Canvas
                  dashboardId={detail.id}
                  name={detail.name}
                  layout={detail.layout}
                  widgets={detail.widgets}
                  version={detail.version}
                  refreshMinutes={detail.refreshMinutes}
                  canWrite={detail.canWrite && canWrite}
                  search={search}
                  tick={tick}
                  onSaved={(version, layout) => setDetail(current => (current ? { ...current, version, layout } : current))}
                  onChanged={() => void reload()}
                />
              </Suspense>
            ) : null}
            {detail?.canWrite && canWrite ? <AddWidget onAdd={addWidget} onError={setMessage} /> : null}
          </div>
        </div>
      ) : null}
    </>
  )
}

function AddWidget(props: { onAdd: (values: { type: WidgetType; source?: string; metric?: string; text?: string }) => Promise<void>; onError: (message: string) => void }) {
  const [form] = Form.useForm<{ type: WidgetType; source?: string; metric?: string; text?: string }>()
  const sourceCode = Form.useWatch('source', form)
  return (
    <Card size="small" title="添加组件" style={{ marginTop: 12 }}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ type: 'METRIC_CARD' }}
        onFinish={values => {
          if (!isWidgetType(values.type)) return
          void props.onAdd(values).catch((error: unknown) => props.onError(error instanceof Error ? error.message : '保存失败'))
        }}
      >
        <Form.Item name="type" label="组件类型">
          <Select aria-label="组件类型" options={WIDGET_TYPES.map(type => ({ value: type, label: WIDGET_TYPE_LABEL[type] }))} />
        </Form.Item>
        <Form.Item name="source" label="数据源">
          <Select aria-label="数据源" allowClear options={CUSTOM_REPORT_SOURCES.map(source => ({ value: source.code, label: source.name }))} />
        </Form.Item>
        <Form.Item name="metric" label="指标（默认数据源第一列）">
          <Select aria-label="指标" allowClear options={(CUSTOM_REPORT_SOURCES.find(item => item.code === sourceCode)?.columns ?? []).map(column => ({ value: column.key, label: column.label }))} />
        </Form.Item>
        <Form.Item name="text" label="文本">
          <Input.TextArea aria-label="文本" />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          添加组件
        </Button>
      </Form>
    </Card>
  )
}
