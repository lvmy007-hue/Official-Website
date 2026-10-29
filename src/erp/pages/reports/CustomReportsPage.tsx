import { useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Alert, Button, Card, Form, Input, Select, Space, Switch } from 'antd'
import { hasPermission } from '@nova/authz'
import { CUSTOM_REPORT_SOURCES } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PageHeader, PagedGrid, textColumn, type PageFetcher } from '../../components'
import { useSession } from '../../session/session'

// 我的报表（P6-32）：选数据源、维度和指标后保存。运行时按当前登录人的权限取数；超过一页走导出中心。

interface ReportRow {
  id: string
  name: string
  source: string
  shared: boolean
  version: number
  ownerId: string
  starred: boolean
  schedule: { frequency: string; hour: number; weekday?: number; lastError?: string | null } | null
  config: { dimension: string; metrics: string[]; from?: string; to?: string; q?: string }
}

interface ReportList {
  items: ReportRow[]
  total: number
}

interface ResultRow {
  id: string
  label: string
  values: Record<string, number | null>
}

interface RunInline {
  mode: 'INLINE'
  columns: Array<{ key: string; label: string }>
  rows: ResultRow[]
  restrictions: string[]
}

interface RunExport {
  mode: 'EXPORT'
  exportJobId: string
  rowCount: number
  truncated: boolean
}

export default function CustomReportsPage() {
  const { me } = useSession()
  const canWrite = hasPermission(me.permissions, 'reports.custom.write')
  const canShare = hasPermission(me.permissions, 'reports.custom.share')
  const search = useRouterState({ select: state => state.location.searchStr })
  const [form] = Form.useForm<{ name: string; source: string; dimension: string; metrics: string; shared: boolean; schedule: string }>()
  const source = Form.useWatch('source', form) ?? 'product-performance'
  const userId = me.user.id
  const spec = CUSTOM_REPORT_SOURCES.find(item => item.code === source) ?? CUSTOM_REPORT_SOURCES[0]!
  const [version, setVersion] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [inline, setInline] = useState<RunInline | null>(null)
  const [busy, setBusy] = useState(false)

  const fetchPage: PageFetcher<ReportRow> = async ({ page, pageSize }) => {
    const data = await apiFetch<ReportList>(`/custom-reports?page=${page}&pageSize=${pageSize}`)
    return { items: data.items, total: data.total }
  }

  const save = async () => {
    const values = await form.validateFields()
    setBusy(true)
    try {
      await apiFetch('/custom-reports', {
        method: 'POST',
        body: JSON.stringify({
          name: values.name,
          source: values.source,
          shared: values.shared === true,
          config: { dimension: values.dimension, metrics: values.metrics.split(/[,，\s]+/).filter(Boolean) },
          schedule: values.schedule === 'DAILY' ? { frequency: 'DAILY', hour: 0 } : values.schedule === 'WEEKLY' ? { frequency: 'WEEKLY', hour: 0, weekday: 1 } : null,
        }),
      })
      setMessage(null)
      setVersion(value => value + 1)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleStar = async (row: ReportRow) => {
    try {
      await apiFetch(`/custom-reports/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: row.name, source: row.source, config: row.config, version: row.version, starred: !row.starred }),
      })
      setMessage(null)
      setVersion(value => value + 1)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败')
    }
  }

  const remove = async (row: ReportRow) => {
    try {
      await apiFetch(`/custom-reports/${row.id}`, { method: 'DELETE' })
      setMessage(null)
      setVersion(value => value + 1)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败')
    }
  }

  const run = async (row: ReportRow) => {
    let data: RunInline | RunExport
    try {
      data = await apiFetch<RunInline | RunExport>(`/custom-reports/${row.id}/run${search}`, { method: 'POST', body: '{}' })
    } catch (error) {
      setInline(null)
      setMessage(error instanceof Error ? error.message : '运行失败')
      return
    }
    if (data.mode === 'EXPORT') {
      setInline(null)
      setMessage(data.truncated ? `结果较大，已放入导出中心（${data.rowCount} 行，已截断）` : `结果较大，已放入导出中心（${data.rowCount} 行）`)
      return
    }
    setMessage(data.restrictions.length ? data.restrictions.join('；') : null)
    setInline(data)
  }

  return (
    <>
      <PageHeader title="我的报表" description="选择数据源、维度和指标。共享后，别人打开时按他自己的数据范围和字段权限取数。" />
      <PagedGrid<ReportRow>
        gridId="reports.custom"
        resetKey={String(version)}
        columns={[
          textColumn<ReportRow>('名称', 'name', { flex: 1 }),
          textColumn<ReportRow>('数据源', 'source', { valueFormatter: params => CUSTOM_REPORT_SOURCES.find(item => item.code === params.value)?.name ?? String(params.value) }),
          textColumn<ReportRow>('共享', 'shared', { valueFormatter: params => (params.value ? '已共享' : '仅自己') }),
          textColumn<ReportRow>('定时（UTC）', 'schedule', {
            valueFormatter: params => {
              const value = params.value as ReportRow['schedule']
              if (!value) return '不定时'
              const base = value.frequency === 'DAILY' ? `每天 ${value.hour} 点` : `每周${value.weekday ?? 1} ${value.hour} 点`
              return value.lastError ? `${base}（上次失败：${value.lastError}）` : base
            },
          }),
          {
            headerName: '操作',
            colId: 'run',
            width: 220,
            cellRenderer: ({ data }: { data?: ReportRow }) =>
              data ? (
                <Space size={4}>
                  <Button size="small" onClick={() => void run(data)}>
                    运行
                  </Button>
                  {canWrite ? (
                    <Button size="small" onClick={() => void toggleStar(data)}>
                      {data.starred ? '取消收藏' : '收藏'}
                    </Button>
                  ) : null}
                  {canWrite && data.ownerId === userId ? (
                    <Button size="small" danger onClick={() => void remove(data)}>
                      删除
                    </Button>
                  ) : null}
                </Space>
              ) : null,
          },
        ]}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        emptyState={{ kind: 'empty', domain: '我的报表', prerequisite: '保存一张报表后，可以在这里运行' }}
        height={320}
      />
      {message ? <Alert style={{ marginTop: 8 }} type="info" showIcon message={message} /> : null}
      {inline ? (
        <PagedGrid<ResultRow>
          gridId="reports.custom-result"
          resetKey={inline.rows.map(row => row.id).join(',')}
          columns={[
            textColumn<ResultRow>('名称', 'label', { flex: 1 }),
            ...inline.columns.map(column =>
              textColumn<ResultRow>(column.label, 'id', {
                colId: column.key,
                valueGetter: params => params.data?.values[column.key] ?? '—',
              }),
            ),
          ]}
          fetchPage={async ({ page, pageSize }) => ({ items: inline.rows.slice((page - 1) * pageSize, page * pageSize), total: inline.rows.length })}
          getRowId={row => row.id}
          emptyState={{ kind: 'empty', domain: '运行结果', prerequisite: '这次查询没有行' }}
          height={320}
        />
      ) : null}
      {canWrite ? (
        <Card size="small" title="新建" style={{ marginTop: 12 }}>
          <Form form={form} layout="vertical" initialValues={{ source: 'product-performance', dimension: 'asin', shared: false, schedule: 'NONE' }}>
            <Space wrap>
              <Form.Item name="name" label="名称" rules={[{ required: true }]}>
                <Input aria-label="报表名称" style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name="source" label="数据源">
                <Select
                  aria-label="数据源"
                  style={{ width: 160 }}
                  options={CUSTOM_REPORT_SOURCES.map(item => ({ value: item.code, label: item.name }))}
                  onChange={(code: string) => form.setFieldValue('dimension', CUSTOM_REPORT_SOURCES.find(item => item.code === code)?.dimensions[0]?.code)}
                />
              </Form.Item>
              <Form.Item name="schedule" label="定时生成（UTC 0 点，结果进导出中心）">
                <Select
                  aria-label="定时生成"
                  style={{ width: 200 }}
                  options={[
                    { value: 'NONE', label: '不定时' },
                    { value: 'DAILY', label: '每天' },
                    { value: 'WEEKLY', label: '每周一' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="dimension" label="维度">
                <Select aria-label="维度" style={{ width: 140 }} options={spec.dimensions.map(item => ({ value: item.code, label: item.label }))} />
              </Form.Item>
              {canShare ? (
                <Form.Item name="shared" label="共享给团队" valuePropName="checked">
                  <Switch aria-label="共享给团队" />
                </Form.Item>
              ) : null}
            </Space>
            <Form.Item name="metrics" label="指标（用逗号分隔列名或自定义编号）" rules={[{ required: true }]}>
              <Input
                aria-label="指标"
                placeholder={spec.columns
                  .map(column => column.key)
                  .slice(0, 4)
                  .join(', ')}
              />
            </Form.Item>
            <Button type="primary" loading={busy} onClick={() => void save()}>
              保存
            </Button>
          </Form>
        </Card>
      ) : null}
    </>
  )
}
