import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Result, Skeleton, Typography } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useParams, useRouter } from '@tanstack/react-router'
import { passwordProblems } from '@nova/api-contracts'
import { apiFetch } from '../../api'
import { describeError } from '../query/errors'

// 邀请激活（P1-19，/invite/:token）：打开邀请链接 → 确认企业与邮箱 → 设置姓名与密码 → 账号激活后去登录。
// 链接一次性、72 小时有效；无效、过期、已使用的链接给出同一句提示，不透露具体原因。首个管理员登录后需要绑定动态验证码。

type Preview = { tenantName: string; email: string; firstAdmin: boolean }
type Accepted = { email: string; tenantName: string; mfaEnrollmentRequired: boolean }
type FormValues = { displayName: string; password: string; confirm: string }

export function InviteAcceptPage() {
  const { token } = useParams({ strict: false }) as { token: string }
  const router = useRouter()
  const preview = useQuery({ queryKey: ['invitation', token], queryFn: () => apiFetch<Preview>(`/auth/invitations/${encodeURIComponent(token)}`), retry: false, staleTime: Infinity })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const [done, setDone] = useState<Accepted | null>(null)

  const submit = async (values: FormValues) => {
    setBusy(true)
    setError(null)
    try {
      setDone(
        await apiFetch<Accepted>(`/auth/invitations/${encodeURIComponent(token)}/accept`, {
          method: 'POST',
          body: JSON.stringify({ displayName: values.displayName.trim(), password: values.password }),
        }),
      )
    } catch (failure) {
      const info = describeError(failure)
      setError({ message: info.message, requestId: info.requestId })
    } finally {
      setBusy(false)
    }
  }

  const shell = (content: React.ReactNode) => (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--ant-color-bg-layout)', padding: 16 }}>
      <Card style={{ width: 440 }}>{content}</Card>
    </div>
  )

  if (done) {
    return shell(
      <Result
        status="success"
        title="账号已激活"
        subTitle={done.mfaEnrollmentRequired ? `欢迎加入 ${done.tenantName}。作为企业管理员，首次登录后需要先绑定动态验证码。` : `欢迎加入 ${done.tenantName}，现在可以登录了。`}
        extra={
          <Button type="primary" onClick={() => void router.navigate({ to: '/app/login' })}>
            去登录
          </Button>
        }
      />,
    )
  }
  if (preview.isPending) return shell(<Skeleton active />)
  if (preview.isError) {
    const info = describeError(preview.error)
    return shell(<Result status="warning" title="邀请链接不可用" subTitle={info.kind === 'not-found' ? '邀请链接无效、已过期或已被使用。请联系邀请你的人重新发送。' : info.message} />)
  }

  const { tenantName, email, firstAdmin } = preview.data
  return shell(
    <>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        加入 {tenantName}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        受邀邮箱：<b>{email}</b>。{firstAdmin ? '你将成为该企业的所有者，登录后需要绑定动态验证码。' : '设置姓名与密码后即可登录。'}
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error.message} description={error.requestId ? `请求编号：${error.requestId}` : undefined} /> : null}
      <Form<FormValues> layout="vertical" requiredMark={false} onFinish={submit} disabled={busy}>
        <Form.Item label="姓名" name="displayName" rules={[{ required: true, whitespace: true, message: '请输入姓名' }]}>
          <Input maxLength={80} autoComplete="name" />
        </Form.Item>
        <Form.Item
          label="设置密码"
          name="password"
          extra="至少 12 位，需包含大写字母、小写字母、数字、符号中的至少三类，不能含有邮箱名。"
          rules={[
            { required: true, message: '请设置密码' },
            {
              validator: (_, value: string) => {
                const problems = value ? passwordProblems(value, { email }) : []
                return problems.length ? Promise.reject(new Error(problems.join('；'))) : Promise.resolve()
              },
            },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          label="确认密码"
          name="confirm"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入密码' },
            ({ getFieldValue }) => ({ validator: (_, value) => (!value || getFieldValue('password') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致'))) }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>
          激活账号
        </Button>
      </Form>
    </>,
  )
}
