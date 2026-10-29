import { useMemo, useState } from 'react'
import { Alert, Button, Card, Descriptions, Space } from 'antd'
import { useParams } from '@tanstack/react-router'
import { aplusModulesFromAmazon, type AplusDetailResponse, type AplusFormModule, type AplusWriteResult } from '@nova/api-contracts'
import { DataState, FreshnessBar, PageHeader, stateFromError } from '../../components'
import { formatDateTime, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { AssociateModal, SubmitModal } from './AplusAssociateModal'
import { AplusCompareCard } from './AplusCompareCard'
import { AsinsCard, RejectionBlock, RunsCard, TimelineCard } from './AplusDetailParts'
import { AplusEditorDrawer } from './AplusEditorDrawer'
import { AplusModulePreview } from './AplusModulePreview'
import { pendingRunText, writeResultNote } from './aplus-format'
import { useBoundedPolling } from './aplus-polling'
import { ActionNotes, Basis, NONE, StatusTag, WriteButton, WriteNotice } from './aplus-ui'

// A+ 内容详情（P4-14，05 章 5.8）：状态与基本信息、被拒原因与修复建议、模块预览、关联 ASIN、审核时间线、发布前后对照、写入记录。
// 编辑、关联 ASIN、提交审核都只代表“已登记”，由后台任务发给亚马逊，结果在写入记录里看；有进行中的写入时每 5 秒自动刷新（最多 2 分钟）。
// 模块预览不渲染真实图片（接口只给图片编号），用占位框表示。

type Dialog = 'edit' | 'associate' | 'submit' | null
type Note = { type: 'success' | 'warning'; text: string }

export default function AplusDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [dialog, setDialog] = useState<Dialog>(null)
  const [note, setNote] = useState<Note | null>(null)
  const query = useApiQuery<AplusDetailResponse>({ domain: 'list', path: `/aplus/${encodeURIComponent(id ?? '')}`, scoped: false, enabled: Boolean(id) })
  const data = query.data
  const view = useMemo(() => (data ? aplusModulesFromAmazon(data.modules) : null), [data])
  const busy = Boolean(data && (data.item.pendingRun || data.runs.some(run => run.status === 'QUEUED' || run.status === 'RUNNING')))
  const polling = useBoundedPolling(busy, () => void query.refetch())

  const written = (result: AplusWriteResult) => {
    setNote(writeResultNote(result))
    setDialog(null)
  }

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'aplus.read', onRetry: () => void query.refetch() })} />
  if (!data || !view) return <DataState kind="skeleton" rows={6} />

  const { item, actions, write } = data
  const editAction = actions.edit.allowed && !data.editable ? { allowed: false, reason: data.editNote } : actions.edit
  // 编辑器只能打开“全部模块都能转成表单”的内容
  const modules = view.modules.every(module => module !== null) ? (view.modules as AplusFormModule[]) : []

  return (
    <div data-testid="aplus-detail-page">
      <PageHeader title={item.name} description={`${item.contentTypeLabel} · ${item.storeName}`} actions={<AppLink to="/app/aplus">返回 A+ 内容列表</AppLink>} />
      <FreshnessBar freshness={data.freshness ?? null} />
      <WriteNotice write={write} />
      {note ? <Alert data-testid="aplus-write-result" closable onClose={() => setNote(null)} style={{ marginTop: 8 }} type={note.type} showIcon message={note.text} /> : null}
      <Card size="small" style={{ marginTop: 8 }} data-testid="aplus-header">
        <Descriptions size="small" column={3}>
          <Descriptions.Item label="状态">
            <StatusTag status={item.status} label={item.statusLabel} />
          </Descriptions.Item>
          <Descriptions.Item label="类型">{item.contentTypeLabel}</Descriptions.Item>
          <Descriptions.Item label="店铺">{item.storeName}</Descriptions.Item>
          <Descriptions.Item label="版本">{`v${data.version}`}</Descriptions.Item>
          <Descriptions.Item label="最近更新">{formatDateTime(item.updatedAt)}</Descriptions.Item>
          <Descriptions.Item label="已发布时间">{item.publishedAt ? formatDateTime(item.publishedAt) : NONE}</Descriptions.Item>
          <Descriptions.Item label="关联 ASIN 数">{item.asinCount > 0 ? <span className="erp-num">{formatNumber(item.asinCount, { digits: 0 })}</span> : '未关联'}</Descriptions.Item>
          <Descriptions.Item label="进行中写入">{item.pendingRun ? pendingRunText(item.pendingRun) : '无'}</Descriptions.Item>
        </Descriptions>
        <Space wrap style={{ marginTop: 8 }}>
          <WriteButton label="编辑" type="primary" write={write} action={editAction} onClick={() => setDialog('edit')} />
          <WriteButton label="提交审核" write={write} action={actions.submit} onClick={() => setDialog('submit')} />
          <Button onClick={() => void query.refetch()} loading={query.isFetching}>
            刷新
          </Button>
        </Space>
        <ActionNotes
          notes={[
            { label: '编辑', reason: editAction.allowed ? null : editAction.reason },
            { label: '关联 ASIN', reason: actions.associate.allowed ? null : actions.associate.reason },
            { label: '提交审核', reason: actions.submit.allowed ? null : actions.submit.reason },
          ]}
        />
      </Card>
      {data.rejection ? <RejectionBlock rejection={data.rejection} /> : null}

      <Card size="small" title="模块预览" style={{ marginTop: 8 }}>
        {!data.editable && data.editNote ? <Alert data-testid="aplus-edit-note" type="warning" showIcon style={{ marginBottom: 8 }} message={data.editNote} /> : null}
        <AplusModulePreview modules={view.modules} raw={data.modules} />
      </Card>

      <AsinsCard asins={data.asins} truncated={data.asinsTruncated} action={<WriteButton label="关联 ASIN" write={write} action={actions.associate} onClick={() => setDialog('associate')} />} />
      <AplusCompareCard compare={data.compare} />
      <TimelineCard events={data.timeline} />
      <RunsCard
        runs={data.runs}
        busy={busy}
        expired={polling.expired}
        refreshing={query.isFetching}
        onRefresh={() => {
          polling.restart()
          void query.refetch()
        }}
      />
      <Basis>{data.basis}</Basis>

      <AplusEditorDrawer
        open={dialog === 'edit'}
        stores={[]}
        initial={{ id: item.id, version: data.version, storeId: item.storeId, storeName: item.storeName, name: item.name, modules }}
        onClose={() => setDialog(null)}
        onDone={written}
      />
      <AssociateModal open={dialog === 'associate'} id={item.id} version={data.version} onClose={() => setDialog(null)} onDone={written} />
      <SubmitModal open={dialog === 'submit'} id={item.id} version={data.version} onClose={() => setDialog(null)} onDone={written} />
    </div>
  )
}
