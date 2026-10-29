import { useState } from 'react'
import { Button, Form, Input, Select, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { EXPORT_FORMATS, EXPORT_KINDS, EXPORT_MAX_ACTIVE_PER_USER, EXPORT_RETENTION_DAYS } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { ActionGuard, FormAction, PageHeader, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { openSignedUrl } from '../../security/safe-url'

// 导出中心（P1-28-5）：我发起的导出任务。
// - 文件由后台任务生成，生成中每 5 秒刷新状态；完成后保留 7 天，到期自动清理，过期的需要重新发起；
// - 点“下载”才向服务端换取 5 分钟有效的下载链接，不会把长期有效的地址暴露在页面上；
// - 导出内容按发起人当时的数据范围与字段权限生成；失败时显示具体原因。

type ExportRow = {
  id: string
  kind: string
  kindLabel: string
  sourcePage: string
  filterSummary: string
  format: string
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'EXPIRED'
  statusLabel: string
  rowCount: number | null
  fileSize: number | null
  errorMessage: string | null
  downloadable: boolean
  createdAt: string
  finishedAt: string | null
  expiresAt: string | null
}
type Page = { items: ExportRow[]; pageInfo: { nextCursor: string | null; hasMore: boolean } }

const STATUS_COLOR: Record<ExportRow['status'], string> = { QUEUED: 'default', RUNNING: 'processing', DONE: 'success', FAILED: 'error', EXPIRED: 'default' }
const sizeText = (bytes: number | null) => (bytes === null ? '—' : bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

export default function ExportCenterPage() {
  const { canPermission } = useSession()
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors[cursors.length - 1]
  const query = useApiQuery<Page>({
    domain: 'realtime',
    path: '/exports',
    scoped: false,
    params: { cursor, limit: 30 },
    refetchIntervalMs: data => (data?.items.some(item => item.status === 'QUEUED' || item.status === 'RUNNING') ? 5000 : false),
  })
  const create = useApiMutation<Record<string, unknown>, unknown>({ method: 'POST', path: '/exports', invalidate: ['realtime'], silent: true })
  const kinds = EXPORT_KINDS.filter(spec => canPermission(spec.permission))

  const columns: ColumnsType<ExportRow> = [
    {
      title: '导出内容',
      key: 'kind',
      render: (_, row) => (
        <div>
          {row.kindLabel}
          {row.filterSummary ? <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{row.filterSummary}</div> : null}
        </div>
      ),
    },
    { title: '格式', dataIndex: 'format', width: 70 },
    {
      title: '状态',
      key: 'status',
      width: 200,
      render: (_, row) => (
        <div>
          <Tag color={STATUS_COLOR[row.status]}>{row.statusLabel}</Tag>
          {row.errorMessage ? <div style={{ color: 'var(--ant-color-error)', fontSize: 12 }}>{row.errorMessage}</div> : null}
        </div>
      ),
    },
    { title: '行数', dataIndex: 'rowCount', width: 90, align: 'right', render: (value: number | null) => (value === null ? '—' : value.toLocaleString('zh-CN')) },
    { title: '大小', dataIndex: 'fileSize', width: 90, render: (value: number | null) => sizeText(value) },
    { title: '发起时间', dataIndex: 'createdAt', width: 160, render: (value: string) => formatDateTime(value) },
    { title: '保留到', dataIndex: 'expiresAt', width: 160, render: (value: string | null, row) => (row.status === 'DONE' && value ? formatDateTime(value) : '—') },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, row) => (
        <ActionGuard
          label="下载"
          guard={{
            condition: { ok: row.downloadable, reason: row.status === 'EXPIRED' ? '文件已过期被清理，请重新发起导出' : row.status === 'FAILED' ? (row.errorMessage ?? '导出失败') : '文件还在生成中' },
          }}
          onExecute={async () => {
            const link = await apiFetch<{ url: string }>(`/exports/${encodeURIComponent(row.id)}/download`)
            openSignedUrl(link.url)
          }}
          buttonProps={{ size: 'small', type: 'link' }}
        />
      ),
    },
  ]

  const actions = (
    <FormAction
      label="发起导出"
      guard={{ permission: 'export.create', condition: { ok: kinds.length > 0, reason: '你没有任何可导出数据的读取权限' } }}
      title="发起导出"
      description={`同时最多 ${EXPORT_MAX_ACTIVE_PER_USER} 个导出在排队或生成；文件默认保留 ${EXPORT_RETENTION_DAYS} 天（可在企业设置的“数据保留”里调整，以每个任务的“有效期至”为准）。更细的筛选请在对应数据页面里选好条件后再导出。`}
      initialValues={{ kind: kinds[0]?.kind, format: 'CSV' }}
      onSubmit={values => {
        const spec = kinds.find(item => item.kind === values.kind)
        const filters: Record<string, string> = {}
        const parts: string[] = []
        if (values.from && spec?.filterKeys.includes('from')) {
          filters.from = String(values.from)
          parts.push(`从 ${values.from}`)
        }
        if (values.to && spec?.filterKeys.includes('to')) {
          filters.to = String(values.to)
          parts.push(`到 ${values.to}`)
        }
        return create.mutateAsync({ kind: values.kind, format: values.format, filters, filterSummary: parts.length > 0 ? parts.join(' ') : '不限日期' })
      }}
      successText="已提交，生成完成后可在列表中下载"
      onDone={() => setCursors([])}
    >
      <Form.Item label="导出内容" name="kind" rules={[{ required: true, message: '请选择导出内容' }]}>
        <Select options={kinds.map(spec => ({ value: spec.kind, label: spec.label }))} />
      </Form.Item>
      <Form.Item label="文件格式" name="format" extra="Excel 最多 100 万行，更大的数据请选 CSV。">
        <Select options={EXPORT_FORMATS.map(value => ({ value, label: value === 'XLSX' ? 'Excel（XLSX）' : 'CSV' }))} />
      </Form.Item>
      <Space size={12}>
        <Form.Item label="开始日期（可选）" name="from">
          <Input type="date" />
        </Form.Item>
        <Form.Item label="结束日期（可选）" name="to">
          <Input type="date" />
        </Form.Item>
      </Space>
    </FormAction>
  )

  return (
    <div>
      <PageHeader title="导出中心" description="你发起的导出任务。文件只保留一周，过期后需要重新发起。" actions={actions} />
      <Typography.Paragraph type="secondary" style={{ margin: '4px 0 12px' }}>
        导出内容按你当前的店铺范围与字段权限生成，看不到的数据不会出现在文件里。
      </Typography.Paragraph>
      <SimpleGrid<ExportRow>
        gridId="my.export-center-page"
        columns={columns}
        rows={query.data?.items}
        rowKey={row => row.id}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '还没有导出任务', prerequisite: '点右上角“发起导出”，或在数据页面里点“导出”。' }}
      />
      <Space style={{ marginTop: 12 }}>
        <Button disabled={cursors.length === 0} onClick={() => setCursors(list => list.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!query.data?.pageInfo.hasMore || !query.data.pageInfo.nextCursor} onClick={() => setCursors(list => [...list, query.data?.pageInfo.nextCursor as string])}>
          下一页
        </Button>
      </Space>
    </div>
  )
}
