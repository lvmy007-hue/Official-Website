import { useState } from 'react'
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import type { InboundActionResponse } from '@nova/api-contracts'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useOptionalSession } from '../../session/session'
import { INBOUND_WRITE_PERMISSION } from './inbound-ui'

// 新建入仓计划：只保存我方草稿，不调用亚马逊（要先做资格预检，再提交创建）。
// 预处理与贴标固定由卖家负责（美国站亚马逊不再提供这两项服务），所以这里没有任何相关选项。

type Values = {
  sellerAccountId?: string
  name?: string
  address?: Record<string, string | undefined>
  items?: Array<{ sku?: string; quantity?: number; expiry?: string }>
}

const clean = (value: Record<string, string | undefined> | undefined) => Object.fromEntries(Object.entries(value ?? {}).flatMap(([key, text]) => (text && text.trim() ? [[key, text.trim()]] : [])))

export function InboundCreateDrawer({ open, onClose, stores, onSaved }: { open: boolean; onClose: () => void; stores: Array<{ id: string; name: string }>; onSaved?: (id: string) => void }) {
  const session = useOptionalSession()
  const { message } = App.useApp()
  const [form] = Form.useForm<Values>()
  const [failure, setFailure] = useState<string | null>(null)
  const create = useApiMutation<Record<string, unknown>, InboundActionResponse>({ method: 'POST', path: '/inbound/plans', invalidate: ['list'], silent: true })
  const canWrite = session?.canPermission(INBOUND_WRITE_PERMISSION) ?? false

  const save = async () => {
    setFailure(null)
    try {
      const values = await form.validateFields()
      const result = await create.mutateAsync({
        sellerAccountId: values.sellerAccountId,
        name: values.name?.trim(),
        sourceAddress: clean(values.address),
        items: (values.items ?? []).map(item => ({ sku: item.sku?.trim(), quantity: item.quantity, ...(item.expiry?.trim() ? { expiry: item.expiry.trim() } : {}) })),
      })
      void message.success('已保存为草稿；下一步做资格预检')
      form.resetFields()
      onSaved?.(result.plan.id)
      onClose()
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return
      const info = describeError(error)
      setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => !create.isPending && onClose()}
      width={720}
      destroyOnClose
      maskClosable={false}
      title="新建入仓计划"
      footer={
        <Space>
          <Button onClick={onClose} disabled={create.isPending}>
            取消
          </Button>
          <Button type="primary" loading={create.isPending} disabled={!canWrite} onClick={() => void save()}>
            保存草稿
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="草稿只保存在我们这里"
        description="保存后先做资格预检，全部通过再提交创建；预处理与贴标固定由卖家负责（美国站亚马逊不再提供这两项服务）。"
      />
      <Form<Values> form={form} layout="vertical" requiredMark={false} disabled={create.isPending} initialValues={{ address: { countryCode: 'CN' }, items: [{}] }}>
        <Form.Item label="店铺" name="sellerAccountId" rules={[{ required: true, message: '请选择店铺' }]}>
          <Select aria-label="店铺" showSearch optionFilterProp="label" placeholder="选择店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} />
        </Form.Item>
        <Form.Item label="计划名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写计划名称' }]}>
          <Input aria-label="计划名称" maxLength={120} />
        </Form.Item>
        <Typography.Title level={5}>发货地址（国内发货仓）</Typography.Title>
        <Space wrap align="start">
          <Form.Item label="联系人或公司名" name={['address', 'name']} rules={[{ required: true, whitespace: true, message: '请填写联系人' }]}>
            <Input aria-label="联系人或公司名" style={{ width: 200 }} maxLength={50} />
          </Form.Item>
          <Form.Item label="地址" name={['address', 'addressLine1']} rules={[{ required: true, whitespace: true, message: '请填写地址' }]}>
            <Input aria-label="地址" style={{ width: 300 }} maxLength={180} />
          </Form.Item>
          <Form.Item label="城市" name={['address', 'city']} rules={[{ required: true, whitespace: true, message: '请填写城市' }]}>
            <Input aria-label="城市" style={{ width: 140 }} maxLength={50} />
          </Form.Item>
          <Form.Item label="州或省代码" name={['address', 'stateOrProvinceCode']} rules={[{ required: true, whitespace: true, message: '请填写州或省代码' }]}>
            <Input aria-label="州或省代码" style={{ width: 120 }} maxLength={10} />
          </Form.Item>
          <Form.Item label="邮编" name={['address', 'postalCode']} rules={[{ required: true, whitespace: true, message: '请填写邮编' }]}>
            <Input aria-label="邮编" style={{ width: 120 }} maxLength={20} />
          </Form.Item>
          <Form.Item label="国家代码" name={['address', 'countryCode']} rules={[{ required: true, pattern: /^[A-Za-z]{2}$/, message: '两位字母，例如 CN' }]}>
            <Input aria-label="国家代码" style={{ width: 90 }} maxLength={2} />
          </Form.Item>
          <Form.Item label="电话" name={['address', 'phoneNumber']} rules={[{ required: true, whitespace: true, message: '请填写电话' }]}>
            <Input aria-label="电话" style={{ width: 160 }} maxLength={30} />
          </Form.Item>
        </Space>
        <Typography.Title level={5}>商品（SKU 必须已在商品目录里）</Typography.Title>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map(field => (
                <Space key={field.key} align="start" wrap>
                  <Form.Item name={[field.name, 'sku']} rules={[{ required: true, whitespace: true, message: '请填写 SKU' }]}>
                    <Input aria-label={`SKU ${field.name + 1}`} placeholder="SKU" style={{ width: 240 }} maxLength={120} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'quantity']} rules={[{ required: true, message: '请填写数量' }]}>
                    <InputNumber aria-label={`数量 ${field.name + 1}`} placeholder="数量" min={1} precision={0} style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'expiry']} rules={[{ pattern: /^\d{4}-\d{2}-\d{2}$/, message: '格式 YYYY-MM-DD' }]}>
                    <Input aria-label={`到期日 ${field.name + 1}`} placeholder="到期日（选填）" style={{ width: 160 }} />
                  </Form.Item>
                  {fields.length > 1 ? <Button aria-label={`删除商品 ${field.name + 1}`} type="text" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} /> : null}
                </Space>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({})}>
                添加商品
              </Button>
            </>
          )}
        </Form.List>
      </Form>
      {failure ? (
        <Typography.Paragraph type="danger" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          {failure}
        </Typography.Paragraph>
      ) : null}
    </Drawer>
  )
}
