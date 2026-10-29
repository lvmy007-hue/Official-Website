import { useState } from 'react'
import { Alert, Button, Card, Form, Input, QRCode, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { describeError } from '../query/errors'
import { platformPost, setPlatformToken } from './platform-api'
import type { PlatformAdmin } from './platform-queries'

// 平台运营后台登录（P1-19）：密码 + 动态验证码两步。首次登录先绑定验证器（扫码或输入密钥），之后每次登录输入验证码。
// 平台账号与企业账号完全分开，这里不提供注册与找回入口——账号由平台负责人在服务器上开通。

type Challenge = { stage: 'VERIFY' | 'ENROLL'; challengeToken: string; secret?: string; otpauthUri?: string; issuer?: string }
type Verified = { accessToken: string; expiresInSeconds: number; admin: PlatformAdmin }

export function PlatformLoginPage() {
  const router = useRouter()
  const client = useQueryClient()
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      const info = describeError(failure)
      setError({ message: info.message, requestId: info.requestId })
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = (values: { email: string; password: string }) =>
    run(async () => {
      setChallenge(await platformPost<Challenge>('/platform/auth/login', { email: values.email.trim(), password: values.password }))
    })

  const submitCode = (values: { code: string }) =>
    run(async () => {
      const result = await platformPost<Verified>('/platform/auth/mfa/verify', { challengeToken: challenge!.challengeToken, code: values.code.trim() })
      setPlatformToken(result.accessToken, result.expiresInSeconds)
      client.setQueryData(['platform', 'me'], result.admin)
      void router.navigate({ to: '/platform/tenants' })
    })

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--ant-color-bg-layout)', padding: 16 }}>
      <Card style={{ width: 400 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          平台运营后台
        </Typography.Title>
        <Typography.Paragraph type="secondary">仅限平台运营人员使用。登录需要密码与动态验证码。</Typography.Paragraph>
        {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error.message} description={error.requestId ? `请求编号：${error.requestId}` : undefined} /> : null}

        {!challenge ? (
          <Form layout="vertical" onFinish={submitPassword} requiredMark={false} disabled={busy}>
            <Form.Item
              label="平台账号（邮箱）"
              name="email"
              rules={[
                { required: true, message: '请输入平台账号' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
            >
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item label="登录密码" name="password" rules={[{ required: true, message: '请输入登录密码' }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              下一步
            </Button>
          </Form>
        ) : (
          <Form layout="vertical" onFinish={submitCode} requiredMark={false} disabled={busy}>
            {challenge.stage === 'ENROLL' && challenge.otpauthUri && challenge.secret ? (
              <div style={{ marginBottom: 16 }}>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="首次登录：请先绑定动态验证码"
                  description="用验证器 App（如 Microsoft Authenticator、Google Authenticator）扫描二维码，或手动输入下方密钥，然后输入 App 显示的 6 位验证码完成绑定。"
                />
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
                  <QRCode value={challenge.otpauthUri} size={168} />
                </div>
                <Typography.Text type="secondary">手动输入密钥：</Typography.Text>
                <Typography.Paragraph copyable code style={{ marginBottom: 0 }}>
                  {challenge.secret}
                </Typography.Paragraph>
              </div>
            ) : (
              <Typography.Paragraph type="secondary">请输入验证器 App 当前显示的 6 位验证码。</Typography.Paragraph>
            )}
            <Form.Item
              label="动态验证码"
              name="code"
              rules={[
                { required: true, message: '请输入验证码' },
                { pattern: /^\d{6}$/, message: '请输入 6 位数字验证码' },
              ]}
            >
              <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              {challenge.stage === 'ENROLL' ? '绑定并登录' : '登录'}
            </Button>
            <Button type="link" block onClick={() => setChallenge(null)} disabled={busy}>
              返回上一步
            </Button>
          </Form>
        )}
      </Card>
    </div>
  )
}
