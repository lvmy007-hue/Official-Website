import { useState } from 'react'
import { permissionDeniedMessage } from '@nova/api-contracts'
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Select, Space, Tooltip, Typography } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import type { PoActionResult, PoLineView, SupplierListResponse } from '@nova/api-contracts'
import { useAppNavigate } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { optional } from './procurement-ui'

// 新建采购单与编辑草稿。草稿可以先不填单价（提交审批前必须填）；SKU 在一张单里不能重复。
// 币种默认取所选供应商的币种。保存成功后新建的单直接打开详情。

type Line = { sellerSku?: string; title?: string; quantity?: number; unitCost?: number | null }
type Values = { supplierId?: string; expectedDate?: string; notes?: string; lines?: Line[] }

export type PoDrawerOrder = { id: string; version: number; supplierName: string; expectedDate: string | null; notes: string | null; lines: PoLineView[] }

const WRITE = 'purchase.order.write'

export function PoDrawer({ open, onClose, order }: { open: boolean; onClose: () => void; order?: PoDrawerOrder }) {
  const { message } = App.useApp()
  const { canPermission } = useSession()
  const navigate = useAppNavigate()
  const [form] = Form.useForm<Values>()
  const [failure, setFailure] = useState<string | null>(null)
  const suppliers = useApiQuery<SupplierListResponse>({
    domain: 'reference',
    path: '/suppliers',
    params: { status: 'ACTIVE', pageSize: 200 },
    scoped: false,
    enabled: open && !order && canPermission('supplier.read'),
  })
  const create = useApiMutation<Record<string, unknown>, PoActionResult>({ method: 'POST', path: '/purchase-orders', invalidate: ['list'], silent: true })
  const update = useApiMutation<Record<string, unknown>, PoActionResult>({ method: 'PATCH', path: `/purchase-orders/${encodeURIComponent(order?.id ?? 'new')}`, invalidate: ['list'], silent: true })
  const busy = create.isPending || update.isPending
  const canWrite = canPermission(WRITE)

  const save = async () => {
    setFailure(null)
    try {
      const values = await form.validateFields()
      const lines = (values.lines ?? []).map(line => ({
        sellerSku: String(line.sellerSku ?? '').trim(),
        quantity: Number(line.quantity),
        ...(optional(line.title) ? { title: optional(line.title) } : {}),
        ...(typeof line.unitCost === 'number' ? { unitCost: line.unitCost } : {}),
      }))
      if (order) {
        await update.mutateAsync({ version: order.version, expectedDate: optional(values.expectedDate) ?? null, notes: optional(values.notes) ?? null, lines })
        void message.success('草稿已保存')
        onClose()
      } else {
        const created = await create.mutateAsync({ supplierId: values.supplierId, expectedDate: optional(values.expectedDate), notes: optional(values.notes), lines })
        void message.success('采购单草稿已创建')
        form.resetFields()
        onClose()
        navigate(`/app/purchase-orders/${encodeURIComponent(created.id)}`)
      }
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return
      const info = describeError(error)
      if (info.fieldErrors) form.setFields(Object.entries(info.fieldErrors).map(([name, errors]) => ({ name: (name.split('.')[0] ?? name) as keyof Values, errors })))
      setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  const initial: Values = order
    ? {
        expectedDate: order.expectedDate ?? undefined,
        notes: order.notes ?? undefined,
        lines: order.lines.map(line => ({ sellerSku: line.sellerSku, title: line.title ?? undefined, quantity: line.quantity, unitCost: line.unitCost ? Number(line.unitCost) : null })),
      }
    : { lines: [{}] }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      title={order ? '编辑采购单草稿' : '新建采购单'}
      destroyOnClose
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Tooltip title={canWrite ? undefined : permissionDeniedMessage(WRITE)}>
            <span>
              <Button type="primary" disabled={!canWrite} loading={busy} onClick={() => void save()}>
                {order ? '保存草稿' : '创建草稿'}
              </Button>
            </span>
          </Tooltip>
        </Space>
      }
    >
      <Form<Values> form={form} layout="vertical" requiredMark={false} initialValues={initial} disabled={busy}>
        {order ? (
          <Typography.Paragraph>供应商：{order.supplierName}（创建后不能更换）</Typography.Paragraph>
        ) : (
          <Form.Item label="供应商" name="supplierId" rules={[{ required: true, message: '请选择供应商' }]}>
            <Select
              aria-label="供应商"
              showSearch
              optionFilterProp="label"
              placeholder="选择合作中的供应商"
              loading={suppliers.isFetching}
              options={(suppliers.data?.items ?? []).map(item => ({ value: item.id, label: `${item.name}（${item.code}，${item.currency}）` }))}
            />
          </Form.Item>
        )}
        <Space size={16} wrap align="start">
          <Form.Item label="预计到货日（选填）" name="expectedDate">
            <Input type="date" aria-label="预计到货日" />
          </Form.Item>
        </Space>
        <Form.Item label="备注" name="notes">
          <Input.TextArea rows={2} maxLength={1000} showCount />
        </Form.Item>
        <Typography.Text strong>商品行</Typography.Text>
        <Form.List name="lines">
          {(fields, { add, remove }) => (
            <>
              {fields.map(field => (
                <Space key={field.key} align="start" wrap style={{ display: 'flex', marginTop: 8 }}>
                  <Form.Item name={[field.name, 'sellerSku']} rules={[{ required: true, whitespace: true, message: '请填写 SKU' }]} style={{ marginBottom: 0 }}>
                    <Input aria-label="SKU" placeholder="SKU" maxLength={120} style={{ width: 170 }} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'title']} style={{ marginBottom: 0 }}>
                    <Input aria-label="商品名称" placeholder="商品名称（选填）" maxLength={300} style={{ width: 200 }} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'quantity']} rules={[{ required: true, message: '请填写数量' }]} style={{ marginBottom: 0 }}>
                    <InputNumber aria-label="数量" placeholder="数量" min={1} precision={0} style={{ width: 100 }} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'unitCost']} style={{ marginBottom: 0 }}>
                    <InputNumber aria-label="单价" placeholder="单价" min={0} style={{ width: 110 }} />
                  </Form.Item>
                  {fields.length > 1 ? <Button type="text" aria-label="删除这一行" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} /> : null}
                </Space>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => add({})}>
                添加一行
              </Button>
            </>
          )}
        </Form.List>
      </Form>
      {failure ? <Alert type="error" showIcon role="alert" style={{ marginTop: 12 }} message={failure} /> : null}
    </Drawer>
  )
}
