import { Alert, Button, Form, Input, Select, Space } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { PRESET_ROLES } from '@nova/authz'
import { useApiQuery } from '../query/api-query'
import type { ScopeOptions } from '../shell/ScopeBar'
import { StepFrame } from './StepFrame'
import type { StepPanelProps } from './onboarding-types'

// 邀请成员（P1-19，选填）：每人一个邮箱、一个角色、数据范围（不选店铺 = 全部店铺）。
// 完成后服务端为每人生成一次性邀请（72 小时有效）；邮件通道未配置时，链接在完成后的弹窗里一次性展示，由管理员复制交付。

type Invite = { email: string; roleId: string; sellerAccountIds: string[] }
type Values = { invites: Invite[] }

const ROLE_OPTIONS = PRESET_ROLES.filter(role => role.key !== 'owner').map(role => ({ value: role.id, label: `${role.name}：${role.description}` }))

export function MembersStep({ step, view, busy, onSubmit }: StepPanelProps) {
  const [form] = Form.useForm<Values>()
  const stores = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const quota = view.quotas.find(item => item.key === 'members')
  const initial = (step.data as Values | null) ?? { invites: [{ email: '', roleId: 'preset-ops', sellerAccountIds: [] }] }
  const invites = Form.useWatch('invites', form)
  const over = quota?.limit != null && quota.used + (invites?.length ?? 0) > quota.limit
  return (
    <StepFrame step={step} busy={busy} onSave={() => onSubmit('SAVE', form.getFieldsValue())} onComplete={() => form.submit()} onSkip={action => onSubmit(action)} completeText="发送邀请并完成">
      {quota?.limit != null ? (
        <Alert
          type={over ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 12, maxWidth: 720 }}
          message={over ? `按本次邀请，成员数将超过报价约定的 ${quota.limit} 人；仍可提交，但需联系平台运营调整配额。` : `当前成员 ${quota.used} 人，报价约定上限 ${quota.limit} 人。`}
        />
      ) : null}
      <Form<Values> form={form} layout="vertical" requiredMark={false} disabled={busy || step.state === 'COMPLETED'} initialValues={initial} onFinish={values => onSubmit('COMPLETE', values)}>
        <Form.List name="invites">
          {(fields, { add, remove }) => (
            <>
              {fields.map(field => (
                <Space key={field.key} align="start" wrap style={{ display: 'flex', marginBottom: 4 }}>
                  <Form.Item
                    name={[field.name, 'email']}
                    label={field.name === 0 ? '邮箱' : undefined}
                    rules={[
                      { required: true, message: '请输入邮箱' },
                      { type: 'email', message: '邮箱格式不正确' },
                    ]}
                  >
                    <Input placeholder="name@company.com" style={{ width: 220 }} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'roleId']} label={field.name === 0 ? '角色' : undefined} rules={[{ required: true, message: '请选择角色' }]}>
                    <Select options={ROLE_OPTIONS} style={{ width: 220 }} popupMatchSelectWidth={false} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'sellerAccountIds']} label={field.name === 0 ? '数据范围' : undefined}>
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="全部店铺"
                      style={{ width: 240 }}
                      loading={stores.isPending}
                      options={(stores.data?.stores ?? []).map(store => ({ value: store.id, label: store.name }))}
                    />
                  </Form.Item>
                  <Form.Item label={field.name === 0 ? ' ' : undefined}>
                    <Button type="text" aria-label="移除这一行" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} disabled={fields.length <= 1} />
                  </Form.Item>
                </Space>
              ))}
              {fields.length < 20 ? (
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ email: '', roleId: 'preset-ops', sellerAccountIds: [] })}>
                  再添加一人
                </Button>
              ) : null}
            </>
          )}
        </Form.List>
      </Form>
    </StepFrame>
  )
}
