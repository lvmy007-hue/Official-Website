import { useState } from 'react'
import { Button, Card, Form, Input, Select, Space, Tag } from 'antd'
import { hasPermission } from '@nova/authz'
import { CUSTOM_REPORT_SOURCES, type ReportFormat } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PageHeader, PagedGrid, textColumn, type PageFetcher } from '../../components'
import { useSession } from '../../session/session'

// 自定义指标（P6-32）：用已有指标做四则运算。保存前先校验；没有写权限只能看。

interface MetricRow {
  id: string
  key: string
  name: string
  expression: string
  dimensions: string[]
  format: string
  version: number
}

interface MetricList {
  items: MetricRow[]
  total: number
}

const FORMATS: Array<{ value: ReportFormat; label: string }> = [
  { value: 'money', label: '金额' },
  { value: 'number', label: '数量' },
  { value: 'percent', label: '百分比' },
  { value: 'decimal', label: '小数' },
]

const dimensions = CUSTOM_REPORT_SOURCES.flatMap(source => source.dimensions.map(item => ({ value: item.code, label: `${source.name} · ${item.label}` })))

export default function CustomMetricsPage() {
  const { me } = useSession()
  const canWrite = hasPermission(me.permissions, 'reports.custom.write')
  const [form] = Form.useForm<{ key: string; name: string; expression: string; dimensions: string[]; format: ReportFormat }>()
  const [issues, setIssues] = useState<string[]>([])
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)

  const fetchPage: PageFetcher<MetricRow> = async ({ page, pageSize }) => {
    const data = await apiFetch<MetricList>(`/custom-metrics?page=${page}&pageSize=${pageSize}`)
    return { items: data.items, total: data.total }
  }

  const validate = async () => {
    const values = await form.validateFields()
    const data = await apiFetch<{ ok: boolean; issues: string[] }>('/custom-metrics/validate', { method: 'POST', body: JSON.stringify({ key: values.key, expression: values.expression }) })
    setIssues(data.issues)
  }

  const save = async () => {
    const values = await form.validateFields()
    setBusy(true)
    try {
      await apiFetch('/custom-metrics', { method: 'POST', body: JSON.stringify(values) })
      setIssues([])
      setVersion(value => value + 1)
    } catch (error) {
      setIssues([error instanceof Error ? error.message : '保存失败'])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="自定义指标" description="用字典里已有的指标做加减乘除。保存后出现在指标字典，类型标记为自定义。" />
      <PagedGrid<MetricRow>
        gridId="reports.custom-metrics"
        resetKey={String(version)}
        columns={[
          textColumn<MetricRow>('编号', 'key'),
          textColumn<MetricRow>('名称', 'name'),
          textColumn<MetricRow>('公式', 'expression', { flex: 1 }),
          textColumn<MetricRow>('格式', 'format', { width: 100 }),
        ]}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        emptyState={{ kind: 'empty', domain: '自定义指标', prerequisite: '填写名称和公式并保存后，会出现在这里' }}
        height={360}
      />
      {canWrite ? (
        <Card size="small" title="新建" style={{ marginTop: 12 }}>
          <Form form={form} layout="vertical" initialValues={{ format: 'number', dimensions: ['asin'] }}>
            <Space wrap>
              <Form.Item name="key" label="编号" rules={[{ required: true }]}>
                <Input aria-label="指标编号" placeholder="C-NET" style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="name" label="名称" rules={[{ required: true }]}>
                <Input aria-label="指标名称" style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name="format" label="格式">
                <Select aria-label="显示格式" style={{ width: 120 }} options={FORMATS} />
              </Form.Item>
            </Space>
            <Form.Item name="expression" label="公式" rules={[{ required: true }]}>
              <Input aria-label="公式" placeholder="(M-001 - M-007) / M-002" />
            </Form.Item>
            <Form.Item name="dimensions" label="适用维度" rules={[{ required: true }]}>
              <Select aria-label="适用维度" mode="multiple" options={dimensions} />
            </Form.Item>
            {issues.length ? issues.map(issue => <Tag key={issue}>{issue}</Tag>) : null}
            <Space>
              <Button onClick={() => void validate()}>检查公式</Button>
              <Button type="primary" loading={busy} onClick={() => void save()}>
                保存
              </Button>
            </Space>
          </Form>
        </Card>
      ) : null}
    </>
  )
}
