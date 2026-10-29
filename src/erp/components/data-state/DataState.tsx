import type { ReactNode } from 'react'
import { Alert, Button, Skeleton, Space } from 'antd'
import { PERMISSION_ADMIN_HINT } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { formatDateTime } from '../../format'
import { LazyResult } from './LazyResult'

// 数据状态组件（P1-05，依据 03 章 3.2“数据状态”）：每个页面的数据区都要覆盖这 9 种状态。
// 阻断型（骨架、未授权、无权限、资格不足、无数据、服务端错误）替换内容区；
// 横幅型（数据延迟、局部同步失败、部分数据可用）显示在内容上方，内容照常展示。

export type StateAction = { label: string; onClick?: () => void; href?: string; disabledReason?: string }

export type DataStateProps =
  | { kind: 'skeleton'; rows?: number }
  | { kind: 'unauthorized'; domain: string; authorize?: StateAction }
  | { kind: 'forbidden'; permission: string; adminHint?: string }
  | { kind: 'qualification'; requirement: string; explanation: string }
  | {
      kind: 'empty'
      /** 数据域说明：这里本应显示什么。 */
      domain: string
      /** 前置条件：需要先做什么才会有数据。 */
      prerequisite: string
      sync?: StateAction
      lastJob?: { status: string; finishedAt?: string | null; failureReason?: string | null; handle?: StateAction }
    }
  | { kind: 'delayed'; lastSuccessAt: string | null; expectedRecoveryAt?: string | null; timeZone?: string }
  | { kind: 'partial-failure'; failed: Array<{ domain: string; impact: string }>; onRetry?: () => void }
  | { kind: 'server-error'; message?: string; errorCode?: string; requestId?: string; onRetry?: () => void }
  | { kind: 'partial-available'; available: string[]; unavailable: Array<{ name: string; reason: string }> }

export type DataStateKind = DataStateProps['kind']

/** 9 种状态的全集，测试与页面按此检查覆盖。 */
export const DATA_STATE_KINDS: readonly DataStateKind[] = ['skeleton', 'unauthorized', 'forbidden', 'qualification', 'empty', 'delayed', 'partial-failure', 'server-error', 'partial-available']

const BANNER_KINDS = new Set<DataStateKind>(['delayed', 'partial-failure', 'partial-available'])
/** 横幅型状态：内容区仍然显示，状态只在上方提示。 */
export const isBannerState = (kind: DataStateKind) => BANNER_KINDS.has(kind)

function ActionButton({ action, type = 'primary' }: { action: StateAction; type?: 'primary' | 'default' }) {
  if (action.disabledReason) {
    return (
      <Button type={type} disabled title={action.disabledReason}>
        {action.label}
      </Button>
    )
  }
  if (action.href) {
    return (
      <AppLink to={action.href}>
        <Button type={type}>{action.label}</Button>
      </AppLink>
    )
  }
  return (
    <Button type={type} onClick={action.onClick}>
      {action.label}
    </Button>
  )
}

function Block({ status, title, description, extra, testId }: { status: 'info' | 'warning' | 'error' | '403'; title: string; description: ReactNode; extra?: ReactNode; testId: string }) {
  return (
    <div data-state={testId} role="status">
      <LazyResult status={status} title={title} subTitle={description} extra={extra} style={{ padding: '32px 16px' }} />
    </div>
  )
}

export function DataState(props: DataStateProps) {
  switch (props.kind) {
    case 'skeleton':
      return (
        <div data-state="skeleton" aria-busy="true" aria-label="正在加载">
          <Skeleton active paragraph={{ rows: props.rows ?? 6 }} />
        </div>
      )
    case 'unauthorized':
      return (
        <Block
          testId="unauthorized"
          status="info"
          title="需要先完成授权"
          description={`“${props.domain}”的数据来自亚马逊，需要先授权后才会同步。`}
          extra={props.authorize ? <ActionButton action={props.authorize} /> : <span style={{ color: 'var(--erp-ink-soft)' }}>请联系企业管理员完成授权。</span>}
        />
      )
    case 'forbidden':
      return (
        <Block
          testId="forbidden"
          status="403"
          title="无权限查看此内容"
          description={
            <Space direction="vertical" size={2}>
              <span>
                缺少权限：<code>{props.permission}</code>
              </span>
              <span>{props.adminHint ?? PERMISSION_ADMIN_HINT}</span>
            </Space>
          }
        />
      )
    case 'qualification':
      return (
        <Block
          testId="qualification"
          status="warning"
          title="当前账号资格不足"
          description={
            <Space direction="vertical" size={2}>
              <span>需要：{props.requirement}</span>
              <span>{props.explanation}</span>
            </Space>
          }
        />
      )
    case 'empty':
      return (
        <Block
          testId="empty"
          status="info"
          title="暂无数据"
          description={
            <Space direction="vertical" size={2}>
              <span>{props.domain}</span>
              <span>前置条件：{props.prerequisite}</span>
              {props.lastJob ? (
                <span>
                  最近任务：{props.lastJob.status}
                  {props.lastJob.finishedAt ? `（${formatDateTime(props.lastJob.finishedAt)}）` : ''}
                  {props.lastJob.failureReason ? `，失败原因：${props.lastJob.failureReason}` : ''}
                </span>
              ) : null}
            </Space>
          }
          extra={
            <Space>
              {props.sync ? <ActionButton action={props.sync} /> : null}
              {props.lastJob?.handle ? <ActionButton action={props.lastJob.handle} type="default" /> : null}
            </Space>
          }
        />
      )
    case 'delayed':
      return (
        <Alert
          data-state="delayed"
          type="warning"
          showIcon
          message="数据同步延迟"
          description={
            <span>
              最近成功同步：{props.lastSuccessAt ? formatDateTime(props.lastSuccessAt, { timeZone: props.timeZone }) : '尚无成功记录'}
              {props.expectedRecoveryAt ? `；预计恢复：${formatDateTime(props.expectedRecoveryAt, { timeZone: props.timeZone })}` : '；暂无预计恢复时间'}
            </span>
          }
        />
      )
    case 'partial-failure':
      return (
        <Alert
          data-state="partial-failure"
          type="error"
          showIcon
          message={`${props.failed.length} 个数据域同步失败`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {props.failed.map(item => (
                <li key={item.domain}>
                  {item.domain}：{item.impact}
                </li>
              ))}
            </ul>
          }
          action={
            props.onRetry ? (
              <Button size="small" onClick={props.onRetry}>
                重试
              </Button>
            ) : undefined
          }
        />
      )
    case 'server-error':
      return (
        <Block
          testId="server-error"
          status="error"
          title="服务暂时不可用"
          description={
            <Space direction="vertical" size={2}>
              <span>{props.message ?? '服务端处理出错，请稍后重试。'}</span>
              {props.errorCode ? <span>错误编号：{props.errorCode}</span> : null}
              {props.requestId ? <span>请求编号：{props.requestId}（反馈问题时请提供）</span> : null}
            </Space>
          }
          extra={
            props.onRetry ? (
              <Button type="primary" onClick={props.onRetry}>
                重试
              </Button>
            ) : undefined
          }
        />
      )
    case 'partial-available':
      return (
        <Alert
          data-state="partial-available"
          type="info"
          showIcon
          message="部分数据可用"
          description={
            <Space direction="vertical" size={2}>
              <span>可用：{props.available.join('、') || '无'}</span>
              <span>不可用：{props.unavailable.map(item => `${item.name}（${item.reason}）`).join('；') || '无'}</span>
            </Space>
          }
        />
      )
  }
}
