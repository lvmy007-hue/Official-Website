import type { ReactNode } from 'react'
import { Alert, Card, Typography } from 'antd'
import type { DashCompare, DashState } from '@nova/api-contracts'
import { DataState, stateFromError } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { describeError } from '../../query/errors'
import { useLivePages } from '../../routes/live-context'
import { specByComponent } from '../../routes/manifest'

// 经营控制台的公共小件：数据状态文案、下钻链接（只指向已上线页面）、区域外框。

export const STATE_TEXT: Record<DashState, string> = { OK: '', NO_DATA: '尚无记录', NOT_CONNECTED: '尚未接入', RESTRICTED: '无权查看' }

export const COMPARE_LABEL: Record<DashCompare['mode'], string> = { previous: '环比', yoy: '同比', custom: '较对比期' }

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

/** 下钻链接：目标页已上线才可点，否则如实提示“页面尚未上线”，不给死链接。 */
export function DrillLink({ component, label = '查看明细', search }: { component: string; label?: string; search?: Record<string, unknown> }) {
  const pages = useLivePages()
  const spec = specByComponent.get(component)
  if (!spec || !(component in pages)) return <Typography.Text type="secondary">页面尚未上线</Typography.Text>
  return (
    <AppLink to={spec.path} search={search}>
      {label}
    </AppLink>
  )
}

/** 下钻目标是否已上线（用于追溯弹层里决定要不要给链接）。 */
export function useDrillPath(component: string): string | undefined {
  const pages = useLivePages()
  const spec = specByComponent.get(component)
  return spec && component in pages ? spec.path : undefined
}

/** 区域外框：标题、右上角附加内容、读取失败与加载中的统一展示。 */
export function Section(props: { title: string; extra?: ReactNode; loading?: boolean; error?: unknown; onRetry?: () => void; children?: ReactNode; testId?: string }) {
  return (
    <Card size="small" title={props.title} extra={props.extra} style={{ marginBottom: 12 }} data-testid={props.testId}>
      {props.error ? <DataState {...stateFromError(describeError(props.error), { onRetry: props.onRetry })} /> : props.loading ? <DataState kind="skeleton" rows={3} /> : props.children}
    </Card>
  )
}

/** 暂未交付的区域：写明由哪个工作包接入，不画任何示例图。 */
export function PendingNote({ note, workPackage }: { note: string; workPackage: string }) {
  return <Alert type="info" showIcon message="尚未接入" description={`${note}（由 ${workPackage} 交付）`} />
}
