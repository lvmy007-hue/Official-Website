import { useState } from 'react'
import { Alert, Form, Input, InputNumber, Modal, Select, Switch } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { DEFAULT_QUOTAS, DEFAULT_RETENTION_DAYS, QUOTA_KEYS, QUOTA_LABELS, type QuotaKey } from '@nova/api-contracts'
import { describeError } from '../query/errors'
import { platformPost } from './platform-api'
import type { InvitationDelivery } from './platform-queries'

// 开通企业（P1-19）：填写企业资料、首个管理员邮箱与报价约定的配额。成功后生成一次性邀请。
// 数据口径时区固定为美国太平洋时区、显示币种固定为美元（亚马逊美国站），这里只设企业本地时区。

type Values = { name: string; slug: string; adminEmail: string; trial: boolean; localTimezone: string; retentionDays: number } & Record<QuotaKey, number>

const timezones: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['Asia/Shanghai']
  } catch {
    return ['Asia/Shanghai']
  }
})()

export type CreatedTenant = { tenant: { id: string; name: string; slug: string; status: string }; invitation: InvitationDelivery }

export function TenantCreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (result: CreatedTenant) => void }) {
  const [form] = Form.useForm<Values>()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string; fields?: Record<string, string[]> } | null>(null)

  const submit = async (values: Values) => {
    setBusy(true)
    setError(null)
    try {
      const quotas = Object.fromEntries(QUOTA_KEYS.map(key => [key, values[key]])) as Record<QuotaKey, number>
      const result = await platformPost<CreatedTenant>('/platform/tenants', {
        name: values.name,
        slug: values.slug,
        adminEmail: values.adminEmail,
        trial: values.trial,
        localTimezone: values.localTimezone,
        retentionDays: values.retentionDays,
        quotas,
      })
      await client.invalidateQueries({ queryKey: ['platform', 'tenants'] })
      form.resetFields()
      onCreated(result)
    } catch (failure) {
      const info = describeError(failure)
      setError({ message: info.message, requestId: info.requestId, fields: info.fieldErrors })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title="开通企业" okText="开通并生成邀请" cancelText="取消" onCancel={onClose} onOk={() => form.submit()} confirmLoading={busy} maskClosable={false} width={560} destroyOnClose>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={error.message}
          description={[error.requestId ? `请求编号：${error.requestId}` : null, ...Object.entries(error.fields ?? {}).map(([field, messages]) => `${field}：${messages.join('；')}`)]
            .filter(Boolean)
            .join('　')}
        />
      ) : null}
      <Form<Values>
        form={form}
        layout="vertical"
        size="small"
        requiredMark={false}
        disabled={busy}
        onFinish={submit}
        initialValues={{ trial: false, localTimezone: 'Asia/Shanghai', retentionDays: DEFAULT_RETENTION_DAYS, ...DEFAULT_QUOTAS }}
      >
        <Form.Item
          label="企业名称"
          name="name"
          rules={[
            { required: true, message: '请输入企业名称' },
            { min: 2, message: '至少 2 个字' },
          ]}
        >
          <Input maxLength={160} />
        </Form.Item>
        <Form.Item
          label="企业标识（唯一，开通后不可修改）"
          name="slug"
          extra="小写字母、数字、连字符，3 至 63 位；注销时需要重新输入它来确认。"
          rules={[
            { required: true, message: '请输入企业标识' },
            { pattern: /^[a-z0-9][a-z0-9-]{2,62}$/, message: '只能含小写字母、数字、连字符，3 至 63 位' },
          ]}
        >
          <Input maxLength={63} />
        </Form.Item>
        <Form.Item
          label="首个管理员邮箱"
          name="adminEmail"
          extra="该邮箱会收到一次性邀请，激活后成为企业所有者并必须绑定动态验证码。"
          rules={[
            { required: true, message: '请输入管理员邮箱' },
            { type: 'email', message: '邮箱格式不正确' },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="试用企业" name="trial" valuePropName="checked" extra="试用与正常功能相同，仅在企业列表里标注状态。">
          <Switch />
        </Form.Item>
        <Form.Item label="企业本地时区" name="localTimezone" extra="用于日报发送时间；数据口径固定为美国太平洋时区，币种固定为美元。" rules={[{ required: true, message: '请选择时区' }]}>
          <Select showSearch options={timezones.map(zone => ({ value: zone, label: zone }))} />
        </Form.Item>
        <Form.Item label="停用后数据保留天数" name="retentionDays" rules={[{ required: true, message: '请输入保留天数' }]}>
          <InputNumber min={1} max={3650} precision={0} style={{ width: '100%' }} addonAfter="天" />
        </Form.Item>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {QUOTA_KEYS.map(key => (
            <Form.Item key={key} label={`配额：${QUOTA_LABELS[key]}`} name={key} rules={[{ required: true, message: '请输入配额' }]}>
              <InputNumber min={0} max={key === 'backfillDays' ? 730 : key === 'stores' ? 1000 : 10000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          ))}
        </div>
      </Form>
    </Modal>
  )
}
