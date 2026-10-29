import { useState } from 'react'
import { Alert, App, Button, Card, Checkbox, Input, Modal, QRCode, Space, Tag, Typography } from 'antd'
import { useSearch } from '@tanstack/react-router'
import { ApiError } from '../../../api'
import { useApiMutation } from '../../query/api-query'
import { useSession } from '../../session/session'
import { useRefreshMe } from './profile-parts'

// 多因素认证（09 章 9.15 第 2 块，由 P1-17 的登录安全迁入）：绑定验证器应用、领取一次性恢复码。
// 本页不提供“关闭多因素认证”与“修改密码”：前者会削弱账号安全，需要单独的找回流程；后者随登录方式一起在后续包里设计，页面上如实说明，不放不能用的按钮。
// 成功提示只在服务端返回成功之后出现。

type Enrollment = { secret: string; otpauthUri: string }
type VerifyResult = { recoveryCodes?: string[] }

export function MfaPanel() {
  const { me } = useSession()
  const { message } = App.useApp()
  const refresh = useRefreshMe()
  const search = useSearch({ strict: false }) as { mfa?: string }
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  const enroll = useApiMutation<void, Enrollment>({ method: 'POST', path: '/auth/mfa/enroll', body: () => undefined, silent: true })
  const verify = useApiMutation<{ code: string }, VerifyResult>({ method: 'POST', path: '/auth/mfa/verify', silent: true })
  const mfa = me.mfa
  const support = me.accessMode === 'SUPPORT'

  const start = async () => {
    try {
      setEnrollment(await enroll.mutateAsync())
      setCode('')
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '无法开始绑定，请稍后重试')
    }
  }

  const submit = async () => {
    try {
      const result = await verify.mutateAsync({ code })
      setEnrollment(null)
      setSaved(false)
      setRecoveryCodes(result.recoveryCodes ?? null)
      message.success('多因素认证已启用')
      await refresh()
    } catch (reason) {
      message.error(
        reason instanceof ApiError && reason.code === 'MFA_CODE_INVALID'
          ? '验证码不正确或已使用过，请输入验证器里当前显示的 6 位数字'
          : reason instanceof Error
            ? reason.message
            : '验证失败，请稍后重试',
      )
    }
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {search.mfa === 'required' && !mfa?.enrolled ? <Alert type="warning" showIcon message="管理员账号必须先启用多因素认证" description="完成下方绑定后才能继续使用其他功能。" /> : null}
      <Card size="small" title="多因素认证">
        {support ? (
          <Typography.Text type="secondary">平台支持访问没有成员账号，不涉及多因素认证。</Typography.Text>
        ) : mfa?.enrolled ? (
          <Space direction="vertical" size={4}>
            <Space>
              <Tag color="green">已启用</Tag>
              <span>登录安全由验证器应用的动态验证码保护</span>
            </Space>
            <Typography.Text type="secondary">剩余恢复码 {mfa.recoveryCodesRemaining} 个。设备丢失时，可用恢复码代替动态验证码，每个恢复码只能使用一次。</Typography.Text>
          </Space>
        ) : (
          <Space direction="vertical" size={8}>
            <Space>
              <Tag>未启用</Tag>
              <span>使用验证器应用（例如 Microsoft Authenticator、Google Authenticator）生成动态验证码。</span>
            </Space>
            <Button type="primary" loading={enroll.isPending} onClick={() => void start()}>
              {mfa?.pending ? '重新获取绑定信息' : '启用多因素认证'}
            </Button>
          </Space>
        )}
      </Card>
      <Card size="small" title="暂不支持的操作">
        <Typography.Text type="secondary">修改密码与关闭多因素认证暂未在个人账号页开放；需要时请联系企业管理员或平台运营处理。</Typography.Text>
      </Card>

      <Modal title="绑定验证器应用" open={Boolean(enrollment)} onCancel={() => setEnrollment(null)} footer={null} destroyOnClose width={420}>
        {enrollment ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <span>1. 用验证器应用扫描二维码；无法扫码时，选择“手动输入”并填入下方密钥。</span>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <QRCode value={enrollment.otpauthUri} size={168} />
            </div>
            <Typography.Text copyable code style={{ wordBreak: 'break-all' }}>
              {enrollment.secret}
            </Typography.Text>
            <span>2. 输入验证器里显示的 6 位验证码完成绑定。</span>
            <Input
              aria-label="6 位验证码"
              value={code}
              onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 位验证码"
              inputMode="numeric"
              maxLength={6}
              onPressEnter={() => code.length === 6 && void submit()}
            />
            <Button type="primary" block loading={verify.isPending} disabled={code.length !== 6} onClick={() => void submit()}>
              验证并启用
            </Button>
          </Space>
        ) : null}
      </Modal>

      <Modal
        title="保存恢复码"
        open={Boolean(recoveryCodes)}
        closable={false}
        maskClosable={false}
        keyboard={false}
        width={420}
        footer={
          <Button type="primary" disabled={!saved} onClick={() => setRecoveryCodes(null)}>
            完成
          </Button>
        }
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert type="warning" showIcon message="恢复码只显示这一次" description="设备丢失、无法获得动态验证码时，可用恢复码登录验证。请离线保存在安全的地方。" />
          <Typography.Paragraph copyable={{ text: (recoveryCodes ?? []).join('\n') }} style={{ marginBottom: 0 }}>
            <code style={{ display: 'block', columnCount: 2, lineHeight: 1.9 }}>
              {(recoveryCodes ?? []).map(item => (
                <span key={item} style={{ display: 'block' }}>
                  {item}
                </span>
              ))}
            </code>
          </Typography.Paragraph>
          <Checkbox checked={saved} onChange={event => setSaved(event.target.checked)}>
            我已妥善保存恢复码
          </Checkbox>
        </Space>
      </Modal>
    </Space>
  )
}
