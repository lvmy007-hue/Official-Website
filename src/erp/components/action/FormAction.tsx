import { useState, type ReactNode } from 'react'
import { App, Alert, Button, Checkbox, Form, Input, Modal, Radio, Space, Tooltip, Typography } from 'antd'
import type { ButtonProps } from 'antd'
import { STEP_UP_ACTIONS, STEP_UP_TTL_MINUTES, type StepUpAction } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { AppLink } from '../../nav/AppLink'
import { describeError } from '../../query/errors'
import { useOptionalSession } from '../../session/session'
import { evaluateGuard, type GuardInput } from './guard'

// 带表单的动作（03 章 3.2 动作守卫 + 3.3 高风险操作）：
// - 前置条件（权限、连接、写入开关、数据条件）不满足：按钮禁用，悬停给出原因，有权处理的人看到“前往处理”；
// - 满足后点击弹出表单：原因（必填）、需要时的二次确认勾选、需要时的再次验证身份（密码，或已绑定时的多因素验证码）；
// - 提交只调服务端，结果以服务端为准：成功才提示，失败显示服务端给的原因与请求编号，字段错误回填到表单。

export type FormActionProps = {
  label: string
  guard: GuardInput
  title: string
  description?: ReactNode
  /** 需要填写原因（至少 2 个字）；不传则不显示原因输入。 */
  reason?: { label?: string; placeholder?: string }
  /** 需要二次确认：显示一个必须勾选的确认语。 */
  confirmText?: string
  /** 需要再次验证身份：提交前先验证，通过后才提交业务请求。 */
  stepUp?: StepUpAction
  /** 额外的表单项（Form.Item）。 */
  children?: ReactNode
  initialValues?: Record<string, unknown>
  /** 一出现就打开弹窗（从别的页面带着参数跳过来时用，例如“从模板新建”）。 */
  defaultOpen?: boolean
  /** 弹窗关闭（取消或提交成功）时调用，用来清掉带进来的地址参数。 */
  onClose?: () => void
  /** 弹窗宽度（像素）；表单项较宽时（例如权限矩阵）使用，缺省为 antd 默认值。 */
  width?: number
  /** 提交：必须真正调用服务端，抛错即失败。values 含 reason 与额外表单项。 */
  onSubmit: (values: Record<string, unknown> & { reason?: string }) => Promise<unknown>
  successText?: string
  onDone?: () => void
  danger?: boolean
  okText?: string
  buttonProps?: Omit<ButtonProps, 'onClick' | 'disabled' | 'danger' | 'children'>
}

type FormValues = Record<string, unknown> & { reason?: string; confirm?: boolean; stepUpMethod?: 'PASSWORD' | 'TOTP'; password?: string; code?: string }

export function FormAction(props: FormActionProps) {
  const session = useOptionalSession()
  const { message } = App.useApp()
  const [open, setOpen] = useState(props.defaultOpen === true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [form] = Form.useForm<FormValues>()
  const mfa = session?.me.mfa?.enrolled === true
  const method = Form.useWatch('stepUpMethod', form) ?? 'PASSWORD'

  const verdict = evaluateGuard(props.guard, permission => session?.canPermission(permission) ?? false)
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

  const close = () => {
    if (busy) return
    setOpen(false)
    setFailure(null)
    form.resetFields()
    props.onClose?.()
  }

  const submit = async (values: FormValues) => {
    setBusy(true)
    setFailure(null)
    try {
      if (props.stepUp) {
        const verifyBody = values.stepUpMethod === 'TOTP' ? { action: props.stepUp, method: 'TOTP', code: values.code } : { action: props.stepUp, method: 'PASSWORD', password: values.password }
        await apiFetch('/auth/step-up', { method: 'POST', body: JSON.stringify(verifyBody) })
      }
      // 再次验证身份用的字段只用于验证，不随业务请求发送
      const rest: FormValues = { ...values }
      for (const key of ['confirm', 'stepUpMethod', 'password', 'code']) delete rest[key]
      await props.onSubmit(rest)
      setOpen(false)
      form.resetFields()
      if (props.successText) void message.success(props.successText)
      props.onDone?.()
      props.onClose?.()
    } catch (error) {
      const info = describeError(error)
      if (info.fieldErrors) form.setFields(Object.entries(info.fieldErrors).map(([name, errors]) => ({ name: name.split('.')[0] ?? name, errors })))
      setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button danger={props.danger} {...props.buttonProps} onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      <Modal
        open={open}
        title={props.title}
        okText={props.okText ?? '确认'}
        cancelText="取消"
        okButtonProps={{ danger: props.danger, loading: busy }}
        onOk={() => form.submit()}
        onCancel={close}
        maskClosable={false}
        width={props.width}
        destroyOnClose
      >
        {props.description ? <div style={{ marginBottom: 12 }}>{props.description}</div> : null}
        <Form<FormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          disabled={busy}
          onFinish={values => void submit(values)}
          initialValues={{ stepUpMethod: 'PASSWORD', ...props.initialValues }}
        >
          {props.children}
          {props.reason ? (
            <Form.Item
              label={props.reason.label ?? '原因'}
              name="reason"
              rules={[
                { required: true, whitespace: true, message: '请填写原因' },
                { min: 2, message: '至少 2 个字' },
              ]}
            >
              <Input.TextArea rows={3} maxLength={500} showCount placeholder={props.reason.placeholder} />
            </Form.Item>
          ) : null}
          {props.stepUp ? (
            <>
              <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`${STEP_UP_ACTIONS[props.stepUp]}需要先再次验证身份（验证后 ${STEP_UP_TTL_MINUTES} 分钟内有效）`} />
              {mfa ? (
                <Form.Item name="stepUpMethod" label="验证方式">
                  <Radio.Group
                    options={[
                      { value: 'PASSWORD', label: '登录密码' },
                      { value: 'TOTP', label: '多因素验证码' },
                    ]}
                  />
                </Form.Item>
              ) : null}
              {method === 'TOTP' ? (
                <Form.Item label="多因素验证码" name="code" rules={[{ required: true, message: '请输入验证码' }]}>
                  <Input inputMode="numeric" maxLength={8} autoComplete="one-time-code" />
                </Form.Item>
              ) : (
                <Form.Item label="登录密码" name="password" rules={[{ required: true, message: '请输入登录密码' }]}>
                  <Input.Password autoComplete="current-password" />
                </Form.Item>
              )}
            </>
          ) : null}
          {props.confirmText ? (
            <Form.Item name="confirm" valuePropName="checked" rules={[{ validator: (_rule, value) => (value ? Promise.resolve() : Promise.reject(new Error('请先勾选确认'))) }]}>
              <Checkbox>{props.confirmText}</Checkbox>
            </Form.Item>
          ) : null}
        </Form>
        {failure ? (
          <Typography.Paragraph type="danger" role="alert" style={{ marginBottom: 0 }}>
            {failure}
          </Typography.Paragraph>
        ) : null}
      </Modal>
    </>
  )
}
