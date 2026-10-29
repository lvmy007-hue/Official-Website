import { useState } from 'react'
import { Alert, App, Button, Drawer, Form, Input, Select, Space, Tooltip, Typography } from 'antd'
import { AWD_REGION_LABEL, type AwdActionResponse, type AwdOrderDetail, type AwdWriteStatus } from '@nova/api-contracts'
import { evaluateGuard } from '../../components'
import { describeError } from '../../query/errors'
import { useApiMutation } from '../../query/api-query'
import { useOptionalSession } from '../../session/session'
import { PackagesField } from './awd-package-fields'
import { awdGuard } from './awd-ui'

// 新建与编辑入库订单（本地草稿或亚马逊草稿）。
// - 保存草稿：只存在我们这里，不调用亚马逊，不受写入开关限制；
// - 提交亚马逊 / 更新到亚马逊：依次判断权限、店铺连接、写入开关；通过后交给后台任务，页面上订单显示“处理中”，结果以订单状态为准；
// - 提交前每个包装都要填长宽高，缺失时服务端返回具体原因，这里原样显示。

type FormValues = {
  sellerAccountId?: string
  originAddress?: Record<string, unknown>
  packages?: Array<Record<string, unknown>>
  preferredRegion?: string
  note?: string
}

export type AwdDrawerProps = {
  open: boolean
  onClose: () => void
  stores: Array<{ id: string; name: string }>
  write: AwdWriteStatus | undefined
  /** 编辑已有订单；不传表示新建。 */
  order?: AwdOrderDetail
  onSaved?: (result: AwdActionResponse) => void
}

const clean = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => [key, clean(inner)] as const)
      .filter(([, inner]) => inner !== '' && inner !== undefined && inner !== null)
    return Object.fromEntries(entries)
  }
  return value
}

/** 长宽高一个都没填时不带尺寸（草稿允许；提交亚马逊前由服务端要求必填）。 */
function withoutEmptyDimensions(pack: Record<string, unknown>): Record<string, unknown> {
  const measurements = pack.measurements as { dimensions?: { length?: number; width?: number; height?: number } } | undefined
  const dims = measurements?.dimensions
  const next: Record<string, unknown> = { ...pack }
  if (measurements && dims && dims.length === undefined && dims.width === undefined && dims.height === undefined) next.measurements = { ...measurements, dimensions: undefined }
  if (Array.isArray(pack.packages)) next.packages = pack.packages.map(inner => withoutEmptyDimensions(inner as Record<string, unknown>))
  return next
}

export function AwdOrderDrawer({ open, onClose, stores, write, order, onSaved }: AwdDrawerProps) {
  const session = useOptionalSession()
  const { message } = App.useApp()
  const [form] = Form.useForm<FormValues>()
  const [failure, setFailure] = useState<string | null>(null)
  const create = useApiMutation<Record<string, unknown>, AwdActionResponse>({ method: 'POST', path: '/awd/orders', invalidate: ['list'], silent: true })
  const update = useApiMutation<Record<string, unknown>, AwdActionResponse>({ method: 'PATCH', path: `/awd/orders/${encodeURIComponent(order?.id ?? 'new')}`, invalidate: ['list'], silent: true })
  const busy = create.isPending || update.isPending
  const local = !order || order.status === 'LOCAL_DRAFT' || order.status === 'CREATE_FAILED'
  const canWrite = session?.canPermission('awd.order.write') ?? false
  const verdict = evaluateGuard(awdGuard(write, { amazon: true }), permission => session?.canPermission(permission) ?? false)

  const save = async (submit: boolean) => {
    setFailure(null)
    try {
      const values = await form.validateFields()
      const packages = values.packages?.length ? (clean(values.packages) as Array<Record<string, unknown>>).map(withoutEmptyDimensions) : undefined
      // 只有国家代码（默认值）时视为没填地址：草稿允许先不填，提交亚马逊前由服务端要求完整
      const address = clean(values.originAddress) as Record<string, unknown> | undefined
      const filled = address && Object.keys(address).some(key => key !== 'countryCode')
      const body = { originAddress: filled ? address : undefined, preferredRegion: values.preferredRegion, note: values.note?.trim() || undefined }
      const result = order
        ? await update.mutateAsync({ ...body, ...(packages ? { packages } : {}), version: order.version, ...(local && submit ? { submit: true } : {}) })
        : await create.mutateAsync({ ...body, sellerAccountId: values.sellerAccountId, packages: packages ?? [], submit })
      void message.success(result.state === 'QUEUED' ? '已交给后台任务提交亚马逊，订单显示“处理中”，结果以订单状态为准' : '已保存')
      onSaved?.(result)
      form.resetFields()
      onClose()
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return
      const info = describeError(error)
      if (info.fieldErrors) form.setFields(Object.entries(info.fieldErrors).map(([name, errors]) => ({ name: name.split('.')[0] ?? name, errors })))
      setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  const amazonButton = (label: string) => (
    <Tooltip title={verdict.allowed ? undefined : verdict.reason}>
      <span>
        <Button type="primary" loading={busy} disabled={!verdict.allowed} onClick={() => void save(true)}>
          {label}
        </Button>
      </span>
    </Tooltip>
  )

  return (
    <Drawer
      open={open}
      onClose={() => !busy && onClose()}
      width={780}
      destroyOnClose
      maskClosable={false}
      title={order ? `编辑入库订单 ${order.orderId ?? order.externalReferenceId ?? ''}` : '新建入库订单'}
      footer={
        <Space>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          {local ? (
            <>
              <Button loading={busy} disabled={!canWrite} onClick={() => void save(false)}>
                保存草稿
              </Button>
              {amazonButton('保存并提交亚马逊')}
            </>
          ) : (
            amazonButton('保存并更新到亚马逊')
          )}
        </Space>
      }
    >
      <Form<FormValues>
        key={order ? `${order.id}-${order.version}` : 'new'}
        form={form}
        layout="vertical"
        requiredMark={false}
        disabled={busy}
        initialValues={
          order
            ? { originAddress: order.originAddress ?? { countryCode: 'CN' }, packages: order.packages, preferredRegion: order.preferredRegion ?? undefined, note: order.note ?? undefined }
            : { originAddress: { countryCode: 'CN' } }
        }
      >
        {order?.draft ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="这是补货建议生成的草稿"
            description={`建议补货：${order.draft.items.map(item => `${item.sku} × ${item.qty}`).join('、') || '无'}。请按实际装箱情况填写包装，每个包装里的商品件数合计要与计划一致。`}
          />
        ) : null}
        {!order ? (
          <Form.Item label="店铺" name="sellerAccountId" rules={[{ required: true, message: '请选择店铺' }]}>
            <Select aria-label="店铺" showSearch optionFilterProp="label" placeholder="选择店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} />
          </Form.Item>
        ) : null}
        <Typography.Title level={5}>发货地址（国内发货仓）</Typography.Title>
        <Space wrap align="start">
          <Form.Item label="联系人或公司名" name={['originAddress', 'name']}>
            <Input aria-label="联系人或公司名" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label="地址" name={['originAddress', 'addressLine1']}>
            <Input aria-label="地址" style={{ width: 320 }} />
          </Form.Item>
          <Form.Item label="地址第二行" name={['originAddress', 'addressLine2']}>
            <Input aria-label="地址第二行" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label="城市" name={['originAddress', 'city']}>
            <Input aria-label="城市" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="州或地区" name={['originAddress', 'stateOrRegion']}>
            <Input aria-label="州或地区" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="邮编" name={['originAddress', 'postalCode']}>
            <Input aria-label="邮编" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item label="国家代码" name={['originAddress', 'countryCode']} rules={[{ pattern: /^[A-Za-z]{2}$/, message: '两位字母，例如 CN' }]}>
            <Input aria-label="国家代码" maxLength={2} style={{ width: 90 }} />
          </Form.Item>
          <Form.Item label="电话" name={['originAddress', 'phoneNumber']}>
            <Input aria-label="电话" style={{ width: 160 }} />
          </Form.Item>
        </Space>
        <Form.Item label="期望入库区域（选填）" name="preferredRegion" extra="亚马逊会综合库容与时效确定实际入库的仓，这里只是偏好">
          <Select allowClear aria-label="期望入库区域" style={{ width: 200 }} options={Object.entries(AWD_REGION_LABEL).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <Typography.Title level={5}>包装</Typography.Title>
        <PackagesField />
        <Form.Item label="备注（只在我们这里保存）" name="note" style={{ marginTop: 16 }}>
          <Input.TextArea rows={2} maxLength={500} showCount aria-label="备注" />
        </Form.Item>
      </Form>
      {failure ? (
        <Typography.Paragraph type="danger" role="alert" style={{ marginBottom: 0 }}>
          {failure}
        </Typography.Paragraph>
      ) : null}
    </Drawer>
  )
}
