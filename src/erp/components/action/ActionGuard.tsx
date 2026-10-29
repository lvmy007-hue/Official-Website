import { useState, type ReactNode } from 'react'
import { App, Button, Modal, Space, Tooltip, Typography } from 'antd'
import type { ButtonProps } from 'antd'
import { AppLink } from '../../nav/AppLink'
import { describeError } from '../../query/errors'
import { useOptionalSession } from '../../session/session'
import { evaluateGuard, type GuardInput } from './guard'

// 动作守卫组件：每个会改数据的按钮都用它包起来。
// - 任一前置条件不满足：按钮禁用，悬停与旁注给出原因；有权限处理的人看到“前往处理”；
// - 全部满足：需要预览确认的先弹出预览，确认后才调服务端；
// - 结果以服务端返回为准：成功才提示成功，失败显示服务端给的原因，不做假成功。

export type ActionGuardProps = {
  label: string
  guard: GuardInput
  /** 执行动作；必须真正调用服务端，抛错即视为失败。 */
  onExecute: () => Promise<unknown>
  /** 需要预览确认的动作（改价、改预算、提交入库计划等）提供预览内容。 */
  preview?: { title: string; content: ReactNode; confirmText?: string }
  /** 服务端确认成功后的提示；不传则不提示。 */
  successText?: string
  onDone?: () => void
  danger?: boolean
  buttonProps?: Omit<ButtonProps, 'onClick' | 'disabled' | 'loading' | 'danger' | 'children'>
}

export function ActionGuard(props: ActionGuardProps) {
  const session = useOptionalSession()
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const verdict = evaluateGuard(props.guard, permission => session?.canPermission(permission) ?? false)

  const run = async () => {
    setRunning(true)
    setFailure(null)
    try {
      await props.onExecute()
      setOpen(false)
      if (props.successText) message.success(props.successText)
      props.onDone?.()
    } catch (error) {
      const info = describeError(error)
      setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    } finally {
      setRunning(false)
    }
  }

  if (!verdict.allowed) {
    return (
      <Space size={4} align="center">
        <Tooltip title={verdict.reason}>
          <span>
            <Button disabled danger={props.danger} {...props.buttonProps}>
              {props.label}
            </Button>
          </span>
        </Tooltip>
        {verdict.fix ? (
          <AppLink to={verdict.fix.href}>
            <Typography.Link>{verdict.fix.label}</Typography.Link>
          </AppLink>
        ) : null}
      </Space>
    )
  }

  return (
    <>
      <Button danger={props.danger} loading={running && !props.preview} {...props.buttonProps} onClick={() => (props.preview ? setOpen(true) : void run())}>
        {props.label}
      </Button>
      {props.preview ? (
        <Modal
          open={open}
          title={props.preview.title}
          okText={props.preview.confirmText ?? '确认执行'}
          cancelText="取消"
          okButtonProps={{ danger: props.danger, loading: running }}
          onOk={() => void run()}
          onCancel={() => (running ? undefined : setOpen(false))}
          maskClosable={false}
        >
          {props.preview.content}
          {failure ? (
            <Typography.Paragraph type="danger" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
              {failure}
            </Typography.Paragraph>
          ) : null}
        </Modal>
      ) : null}
      {!props.preview && failure ? (
        <Typography.Text type="danger" role="alert" style={{ marginLeft: 8 }}>
          {failure}
        </Typography.Text>
      ) : null}
    </>
  )
}
