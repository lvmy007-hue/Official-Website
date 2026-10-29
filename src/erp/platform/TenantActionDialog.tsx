import { useState } from 'react'
import { Alert, Form, Input, InputNumber, Modal } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { DEFAULT_RETENTION_DAYS, QUOTA_KEYS, QUOTA_LABELS, type QuotaKey } from '@nova/api-contracts'
import { describeError } from '../query/errors'
import { platformPost, platformPut } from './platform-api'
import type { InvitationDelivery, TenantDetail } from './platform-queries'

// 租户的状态操作与配额调整对话框（P1-19）：每个操作都要填写原因（写入审计），危险操作额外确认。
// 对话框只收集输入并调用服务端；是否允许由服务端的状态机与权限最终判定，这里只负责把拒绝原因如实展示出来。

export type TenantAction = 'suspend' | 'resume' | 'deactivate' | 'close' | 'invite' | 'quota'

type Values = { reason?: string; retentionDays?: number; confirmSlug?: string; code?: string; email?: string } & Partial<Record<QuotaKey, number | null>>

const COPY: Record<TenantAction, { title: string; ok: string; danger?: boolean; description: string }> = {
  suspend: { title: '暂停企业', ok: '确认暂停', description: '暂停后，企业成员仍可登录查看数据，但不能修改；所有后台同步停止。可随时恢复。' },
  resume: { title: '恢复企业', ok: '确认恢复', description: '恢复后企业重新可写，并恢复定时同步。' },
  deactivate: {
    title: '停用企业',
    ok: '确认停用',
    danger: true,
    description: '停用后企业成员不能登录，所有同步停止；数据按保留期保留，保留期内可以恢复。保留期到期不会自动删除数据，需要平台人员另行发起注销。',
  },
  close: {
    title: '注销企业',
    ok: '确认注销',
    danger: true,
    description: '注销不可撤销：依次导出企业数据、撤销接口授权、删除令牌与买家个人信息、删除全部业务数据与文件，并生成删除证明。导出包保留 30 天，审计记录保留 2 年。',
  },
  invite: { title: '重发邀请', ok: '生成新邀请', description: '会作废尚未使用的旧邀请，并生成新的一次性链接（72 小时有效，只能使用一次）。留空邮箱则沿用原受邀邮箱。' },
  quota: { title: '调整配额', ok: '保存配额', description: '配额按报价约定设置。超额只提示，不会阻断企业使用。' },
}

export function TenantActionDialog({
  action,
  tenant,
  onClose,
  onInvitation,
}: {
  action: TenantAction | null
  tenant: TenantDetail
  onClose: () => void
  onInvitation: (delivery: InvitationDelivery) => void
}) {
  const [form] = Form.useForm<Values>()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const resumingClose = action === 'close' && tenant.status === 'CLOSING'

  const refresh = async (detail?: TenantDetail) => {
    if (detail) client.setQueryData(['platform', 'tenant', tenant.id], detail)
    await Promise.all([client.invalidateQueries({ queryKey: ['platform', 'tenant', tenant.id] }), client.invalidateQueries({ queryKey: ['platform', 'tenants'] })])
  }

  const submit = async (values: Values) => {
    if (!action) return
    setBusy(true)
    setError(null)
    const base = `/platform/tenants/${encodeURIComponent(tenant.id)}`
    try {
      if (action === 'invite') {
        const result = await platformPost<{ invitation: InvitationDelivery }>(`${base}/invite`, values.email?.trim() ? { email: values.email.trim() } : {})
        await refresh()
        onInvitation(result.invitation)
      } else if (action === 'quota') {
        const quotas = Object.fromEntries(
          QUOTA_KEYS.filter(key => values[key] !== null && values[key] !== undefined && values[key] !== tenant.quotas.find(item => item.key === key)?.limit).map(key => [key, values[key]]),
        )
        await platformPut(`${base}/quota`, { quotas, reason: values.reason })
        await refresh()
        await client.invalidateQueries({ queryKey: ['platform', 'tenant', tenant.id, 'usage'] })
      } else if (action === 'close') {
        await refresh(await platformPost<TenantDetail>(`${base}/close`, { reason: values.reason, confirmSlug: values.confirmSlug?.trim(), code: values.code?.trim() }))
      } else if (action === 'deactivate') {
        await refresh(await platformPost<TenantDetail>(`${base}/deactivate`, { reason: values.reason, retentionDays: values.retentionDays }))
      } else {
        await refresh(await platformPost<TenantDetail>(`${base}/${action}`, { reason: values.reason }))
      }
      form.resetFields()
      onClose()
    } catch (failure) {
      const info = describeError(failure)
      setError({ message: info.message, requestId: info.requestId })
    } finally {
      setBusy(false)
    }
  }

  const copy = action ? COPY[action] : null
  const reasonRule = [
    { required: true, message: '请填写原因（会写入审计）' },
    { min: 5, message: '至少 5 个字' },
  ]
  return (
    <Modal
      open={Boolean(action)}
      title={resumingClose ? '继续注销（从失败处续跑）' : copy?.title}
      okText={resumingClose ? '继续注销' : copy?.ok}
      okButtonProps={{ danger: copy?.danger }}
      cancelText="取消"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={busy}
      maskClosable={false}
      destroyOnClose
    >
      {copy ? <Alert type={copy.danger ? 'warning' : 'info'} showIcon style={{ marginBottom: 12 }} message={copy.description} /> : null}
      {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error.message} description={error.requestId ? `请求编号：${error.requestId}` : undefined} /> : null}
      <Form<Values>
        form={form}
        layout="vertical"
        size="small"
        requiredMark={false}
        disabled={busy}
        onFinish={submit}
        preserve={false}
        initialValues={{ retentionDays: tenant.retentionDays || DEFAULT_RETENTION_DAYS, ...Object.fromEntries(tenant.quotas.map(item => [item.key, item.limit])) }}
      >
        {action === 'invite' ? (
          <Form.Item label="受邀管理员邮箱（可选）" name="email" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder={tenant.invitations[0]?.email ?? '沿用原受邀邮箱'} />
          </Form.Item>
        ) : (
          <Form.Item label="原因" name="reason" rules={reasonRule}>
            <Input.TextArea rows={2} maxLength={500} showCount />
          </Form.Item>
        )}
        {action === 'deactivate' ? (
          <Form.Item label="数据保留天数" name="retentionDays" extra="保留期内可以恢复企业；到期后需要平台人员另行发起注销。">
            <InputNumber min={1} max={3650} precision={0} style={{ width: '100%' }} addonAfter="天" />
          </Form.Item>
        ) : null}
        {action === 'quota'
          ? QUOTA_KEYS.map(key => (
              <Form.Item key={key} label={QUOTA_LABELS[key]} name={key} extra={key === 'backfillDays' ? '历史回补天数，最多 730 天' : undefined}>
                <InputNumber min={0} max={key === 'backfillDays' ? 730 : key === 'stores' ? 1000 : 10000} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            ))
          : null}
        {action === 'close' ? (
          <>
            <Form.Item
              label={`请输入企业标识“${tenant.slug}”以确认`}
              name="confirmSlug"
              rules={[
                { required: true, message: '请输入企业标识' },
                { validator: (_, value) => (!value || value.trim() === tenant.slug ? Promise.resolve() : Promise.reject(new Error('与企业标识不一致'))) },
              ]}
            >
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item
              label="动态验证码（再次验证身份）"
              name="code"
              rules={[
                { required: true, message: '请输入验证码' },
                { pattern: /^\d{6}$/, message: '请输入 6 位数字验证码' },
              ]}
              extra="同一个验证码只能用一次；如刚用过，请等待验证器刷新。"
            >
              <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
            </Form.Item>
          </>
        ) : null}
      </Form>
    </Modal>
  )
}
