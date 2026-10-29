import { useRef, useState } from 'react'
import { Alert, Button, Select, Space, Tag, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { APLUS_LIMITS, APLUS_UPLOAD_TYPES, aplusFailureText, type AplusUploadResult, type AplusUploadRow, type AplusUploadsResponse } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { UploadStepError, uploadAplusImage } from './aplus-api'
import { formatBytes, imageFileIssue } from './aplus-format'
import { useBoundedPolling } from './aplus-polling'
import { NONE, WriteButton, WriteNotice } from './aplus-ui'
import { SimpleGrid } from '../../components'

// 图片库（P4-14）：列出上传记录，上传 JPG 与 PNG（本地先校验类型与大小）。
// 流程：申请直传票据 → 浏览器 PUT 到存储 → 确认登记；每一步失败都给中文提示。登记后状态是“排队中/处理中”，由后台任务传给亚马逊，可以点“刷新”看结果。

const COLOR: Record<AplusUploadRow['status'], string> = { QUEUED: 'default', RUNNING: 'processing', SUCCEEDED: 'green', FAILED: 'red' }
const busyOf = (row: AplusUploadRow) => row.status === 'QUEUED' || row.status === 'RUNNING'
type Feedback = { type: 'success' | 'warning' | 'error'; text: string }

export function AplusUploads() {
  const [storeId, setStoreId] = useState<string | undefined>()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const client = useQueryClient()
  const query = useApiQuery<AplusUploadsResponse>({ domain: 'list', path: '/aplus/uploads', scoped: false, params: { storeId } })
  const data = query.data
  const items = data?.items
  const hasBusy = Boolean(items?.some(busyOf))
  const polling = useBoundedPolling(hasBusy, () => void query.refetch())
  // 上传要落到一个确定的店铺：只有一个店铺时自动用它，多个店铺要先选
  const target = storeId ?? (data?.stores.length === 1 ? data.stores[0].id : undefined)

  const send = async (file: File) => {
    if (!target) return
    const issue = imageFileIssue(file)
    if (issue) {
      setFeedback({ type: 'error', text: issue })
      return
    }
    setSending(true)
    setFeedback(null)
    try {
      const result: AplusUploadResult = await uploadAplusImage(file, target)
      setFeedback(
        result.queued
          ? { type: 'success', text: `已登记，稍后在写入记录里看结果：“${file.name}”（${result.width}×${result.height}）正在排队上传到亚马逊，完成后状态会变成“已完成”，点“刷新”查看` }
          : { type: 'warning', text: `“${file.name}”已传到存储，但没能进入任务队列，上传记录已标为失败，请重新上传` },
      )
      polling.restart()
      await client.invalidateQueries({ predicate: entry => entry.queryKey[1] === 'list' })
    } catch (error) {
      setFeedback({ type: 'error', text: error instanceof UploadStepError ? error.message : '上传失败，请稍后重试' })
    } finally {
      setSending(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div data-testid="aplus-uploads">
      <WriteNotice write={data?.write} />
      <Space wrap style={{ marginBottom: 8 }}>
        <Select
          allowClear
          virtual={false}
          style={{ width: 220 }}
          placeholder="全部店铺"
          aria-label="图片库店铺"
          value={storeId}
          options={(data?.stores ?? []).map(store => ({ value: store.id, label: store.name }))}
          onChange={value => setStoreId(value)}
        />
        <input ref={input} type="file" hidden accept=".jpg,.jpeg,.png,image/jpeg,image/png" aria-label="选择图片文件" onChange={event => event.target.files?.[0] && void send(event.target.files[0])} />
        <WriteButton
          label="上传图片"
          type="primary"
          write={data?.write}
          loading={sending}
          action={{ allowed: Boolean(target), reason: '请先在左侧选择要上传到的店铺' }}
          onClick={() => input.current?.click()}
        />
        {data && !target ? <Typography.Text type="warning">要上传图片，请先选择店铺</Typography.Text> : null}
        <Button
          onClick={() => {
            polling.restart()
            void query.refetch()
          }}
          loading={query.isFetching}
        >
          刷新
        </Button>
        <Typography.Text type="secondary">
          只收 {APLUS_UPLOAD_TYPES.map(type => type.replace('image/', '').toUpperCase()).join('、')}，单张不超过 {formatBytes(APLUS_LIMITS.imageMaxBytes)}；图片的宽高要不小于模块要求的尺寸
        </Typography.Text>
      </Space>
      {feedback ? <Alert data-testid="aplus-upload-feedback" closable onClose={() => setFeedback(null)} style={{ marginBottom: 8 }} type={feedback.type} showIcon message={feedback.text} /> : null}
      {hasBusy ? (
        <Typography.Paragraph type="secondary" style={{ margin: '0 0 8px' }}>
          {polling.expired ? '已停止自动刷新，请手动点“刷新”' : '有图片正在处理，每 5 秒自动刷新一次（最多 2 分钟）'}
        </Typography.Paragraph>
      ) : null}
      {query.isError ? <Alert type="error" showIcon role="alert" style={{ marginBottom: 8 }} message="读取图片库失败，请稍后重试" /> : null}
      <SimpleGrid<AplusUploadRow>
        gridId="aplus.aplus-uploads"
        columns={[
          { title: '文件名', dataIndex: 'fileName' },
          { title: '店铺', dataIndex: 'storeName', width: 140 },
          { title: '尺寸', key: 'size', width: 100, render: (_v, row) => `${row.width}×${row.height}` },
          { title: '大小', key: 'bytes', width: 90, render: (_v, row) => formatBytes(row.sizeBytes) },
          { title: '状态', key: 'status', width: 100, render: (_v, row) => <Tag color={COLOR[row.status]}>{row.statusLabel}</Tag> },
          { title: '失败原因', key: 'failure', width: 240, render: (_v, row) => (row.status === 'FAILED' ? (row.failureText ?? aplusFailureText(row.failureCode) ?? '失败原因尚无记录') : NONE) },
          { title: '时间', key: 'time', width: 170, render: (_v, row) => formatDateTime(row.createdAt) },
        ]}
        rows={items}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '图片库', prerequisite: '还没有上传过图片' }}
        loading={query.isFetching && !items}
      />
      {items && items.length >= APLUS_LIMITS.uploadsShown ? <Typography.Text type="secondary">只显示最近 {APLUS_LIMITS.uploadsShown} 条</Typography.Text> : null}
    </div>
  )
}
