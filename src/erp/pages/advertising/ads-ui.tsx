import type { ReactNode } from 'react'
import { Card, Typography } from 'antd'
import type { DashState } from '@nova/api-contracts'
import { DataState, stateFromError } from '../../components'
import { describeError } from '../../query/errors'

// 广告控制台的公共小件：数据状态文案、区域外框。公共小件放在页面自己的目录里（不跨页面引用，避免多出共享脚本块）。

export const STATE_TEXT: Record<DashState, string> = { OK: '', NO_DATA: '尚无记录', NOT_CONNECTED: '尚未接入', RESTRICTED: '无权查看' }

/** 非“有数据”状态的说明：先说状态，再说原因。 */
export function StateNote({ state, note }: { state: DashState; note?: string | null }) {
  if (state === 'OK') return note ? <Typography.Text type="secondary">{note}</Typography.Text> : null
  return (
    <div>
      <Typography.Text strong>{STATE_TEXT[state]}</Typography.Text>
      {note ? <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{note}</div> : null}
    </div>
  )
}

/** 区域外框：标题、右上角附加内容、读取失败与加载中的统一展示。 */
export function Section(props: { title: string; extra?: ReactNode; loading?: boolean; error?: unknown; onRetry?: () => void; children?: ReactNode; testId?: string }) {
  return (
    <Card size="small" title={props.title} extra={props.extra} style={{ marginBottom: 12 }} data-testid={props.testId}>
      {props.error ? <DataState {...stateFromError(describeError(props.error), { onRetry: props.onRetry })} /> : props.loading ? <DataState kind="skeleton" rows={3} /> : props.children}
    </Card>
  )
}
