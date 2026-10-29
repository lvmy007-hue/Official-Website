import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter, useSearch } from '@tanstack/react-router'
import { login } from '../../api'
import { describeError } from '../query/errors'
import { resetForTenantChange } from '../query/client'
import { safeRedirectPath } from '../security/safe-url'

// 登录页（/login 与 /app/login）：邮箱 + 密码。生产环境只接受已初始化的企业账号。

type FormValues = { email: string; password: string }

export function LoginPage() {
  const router = useRouter()
  const client = useQueryClient()
  const { redirect } = useSearch({ strict: false }) as { redirect?: string }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)

  const submit = async (values: FormValues) => {
    setBusy(true)
    setError(null)
    try {
      await login(values.email.trim(), values.password)
      // 换了身份：上一个账号的缓存一律不留
      resetForTenantChange(client)
      // 地址栏里的 redirect 是外部输入：只接受工作台内部路径，防止登录后被带到别的站点（开放重定向）
      router.history.push(safeRedirectPath(redirect))
    } catch (failure) {
      const info = describeError(failure)
      setError({ message: info.message, requestId: info.requestId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--ant-color-bg-layout)', padding: 16 }}>
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          登录 NOVA ERP
        </Typography.Title>
        <Typography.Paragraph type="secondary">使用企业账号进入工作台。首个账号由企业管理员开通。</Typography.Paragraph>
        {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error.message} description={error.requestId ? `请求编号：${error.requestId}` : undefined} /> : null}
        <Form<FormValues> layout="vertical" onFinish={submit} requiredMark={false} disabled={busy}>
          <Form.Item
            label="企业邮箱"
            name="email"
            rules={[
              { required: true, message: '请输入企业邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input autoComplete="username" placeholder="name@company.com" />
          </Form.Item>
          <Form.Item label="登录密码" name="password" rules={[{ required: true, message: '请输入登录密码' }]}>
            <Input.Password autoComplete="current-password" placeholder="请输入密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  )
}
