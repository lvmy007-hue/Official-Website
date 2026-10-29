import type { ReactNode } from 'react'
import { Space, Tag, Tooltip, Typography } from 'antd'
import { SYNC_MANAGE, SYNC_STATE_COLOR, SYNC_STATE_HINT, SYNC_STATE_LABEL, type SyncJobRow } from '@nova/api-contracts'
import { ActionGuard } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'

// 同步中心页面共用的小件（P5-06）：状态、尝试次数、进度、失败原因的写法，行内重试。
// 没有数据的写法：还没有执行过写“尚未执行”，没有进度写“尚无进度”，没有日志写“尚无记录”，任何时候都不拿 0 冒充。

export function SyncStateTag({ row }: { row: Pick<SyncJobRow, 'state'> }) {
  return (
    <Tooltip title={SYNC_STATE_HINT[row.state]}>
      <Tag color={SYNC_STATE_COLOR[row.state]} bordered={false}>
        {SYNC_STATE_LABEL[row.state]}
      </Tag>
    </Tooltip>
  )
}

export const attemptsText = (row: Pick<SyncJobRow, 'attempts' | 'maxAttempts'>): ReactNode =>
  row.attempts === 0 ? <Muted>尚未执行</Muted> : <span className="erp-num">{`${row.attempts} / ${row.maxAttempts}`}</span>

export const progressText = (row: Pick<SyncJobRow, 'progressCurrent' | 'progressTotal'>): ReactNode => {
  if (row.progressTotal <= 0) return <Muted>尚无进度</Muted>
  return <span className="erp-num">{`${row.progressCurrent} / ${row.progressTotal}`}</span>
}

export function FailureCell({ row }: { row: Pick<SyncJobRow, 'failureCode' | 'failureText'> }) {
  if (!row.failureText && !row.failureCode) return <Muted>无</Muted>
  return (
    <Typography.Text type="danger" style={{ fontSize: 12 }}>
      {row.failureText}
      {row.failureCode ? `（${row.failureCode}）` : ''}
    </Typography.Text>
  )
}

export const logText = (row: Pick<SyncJobRow, 'logSummary'>): ReactNode => (row.logSummary ? <span style={{ fontSize: 12 }}>{row.logSummary}</span> : <Muted>尚无记录</Muted>)

/** 任务名称（跳详情）加数据域、店铺、接口的小字说明。 */
export function JobTitle({ row }: { row: Pick<SyncJobRow, 'id' | 'typeLabel' | 'domainLabel' | 'storeName' | 'apiLabel'> }) {
  return (
    <div>
      <LiveLink component="SyncJobDetailPage" id={row.id}>
        {row.typeLabel}
      </LiveLink>
      <div style={{ fontSize: 12 }}>
        <Muted>
          {row.domainLabel}
          {row.storeName ? ` · ${row.storeName}` : ''}
          {row.apiLabel ? ` · ${row.apiLabel}` : ''}
        </Muted>
      </div>
    </div>
  )
}

/** 重试：只有失败的任务可以重试（服务端同样检查）；写入亚马逊的任务在确认框里提醒会重新提交一次写入。 */
export function RetryAction({ row, onDone }: { row: Pick<SyncJobRow, 'id' | 'canRetry' | 'retryBlockedReason' | 'writeType' | 'typeLabel'>; onDone?: () => void }) {
  const retry = useApiMutation<void, unknown>({ method: 'POST', path: `/sync/jobs/${encodeURIComponent(row.id)}/retry`, invalidate: ['list', 'realtime'], silent: true })
  return (
    <ActionGuard
      label="重试"
      guard={{ permission: SYNC_MANAGE, condition: { ok: row.canRetry, reason: row.retryBlockedReason ?? undefined } }}
      preview={{
        title: `重试“${row.typeLabel}”？`,
        content: (
          <Space direction="vertical" size={4}>
            <span>任务会重新入队，尝试次数重新计算（最多 5 次）；失败原因与过程记录保留在任务详情里。</span>
            {row.writeType ? <Typography.Text type="warning">这是向亚马逊写入的任务：重试会重新提交一次写入，提交前请确认亚马逊侧的当前状态。</Typography.Text> : null}
          </Space>
        ),
        confirmText: '确认重试',
      }}
      onExecute={() => retry.mutateAsync()}
      successText="已重新入队"
      onDone={onDone}
      buttonProps={{ size: 'small', type: 'link' }}
    />
  )
}
