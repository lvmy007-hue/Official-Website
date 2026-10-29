import { useState } from 'react'
import { permissionDeniedMessage } from '@nova/api-contracts'
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Select, Space, Tooltip, Typography } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import {
  CUSTOMS_STATUS_LABEL,
  CUSTOMS_STATUSES,
  FIRST_MILE_MODE_LABEL,
  FIRST_MILE_MODES,
  type FirstMileActionResult,
  type CarrierListResponse,
  type FirstMileDetail,
  type FirstMileListResponse,
} from '@nova/api-contracts'
import { useAppNavigate } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { dateOrNull } from './first-mile-ui'

// 新建与编辑头程运单。明细（SKU、数量、箱数、体积、重量、货值）是后面按体积、重量、货值分摊费用的依据，缺了某一项就不能按那个口径分摊。
// 金额类输入（预估费用、货值）需要字段权限 field.cost，没有权限的人看不到也不会提交。分摊或出库之后明细不能改，页面把它锁住并说明原因。

type Item = { sku?: string; quantity?: number; cartons?: number | null; volumeCbm?: number | null; weightKg?: number | null; goodsValue?: number | null }
type Values = Record<string, unknown> & { items?: Item[] }

const WRITE = 'firstmile.write'
const modeOptions = FIRST_MILE_MODES.map(value => ({ value, label: FIRST_MILE_MODE_LABEL[value] }))
const customsOptions = CUSTOMS_STATUSES.map(value => ({ value, label: CUSTOMS_STATUS_LABEL[value] }))
const num = (value: unknown) => (typeof value === 'number' ? value : null)

function initialOf(detail: FirstMileDetail | undefined): Values {
  if (!detail) return { mode: 'SEA', customsStatus: 'NOT_STARTED', currency: 'USD', linkedInboundShipmentIds: [], items: [{}] }
  const s = detail.shipment
  return {
    forwarderId: s.forwarderId,
    waybillNo: s.waybillNo,
    mode: s.mode,
    containerNo: s.containerNo ?? '',
    shipDate: s.shipDate ?? '',
    etaPort: s.etaPort ?? '',
    ataPort: s.ataPort ?? '',
    customsStatus: s.customsStatus,
    etaDelivery: s.etaDelivery ?? '',
    ataDelivery: s.ataDelivery ?? '',
    estimatedCost: s.estimatedCost ? Number(s.estimatedCost) : null,
    currency: s.currency,
    warehouseId: s.warehouseId ?? undefined,
    carrierChannelId: s.carrierChannelId ?? undefined,
    linkedInboundShipmentIds: s.linkedInboundShipmentIds,
    note: s.note ?? '',
    items: detail.items.map(item => ({
      sku: item.sku,
      quantity: item.quantity,
      cartons: item.cartons,
      volumeCbm: item.volumeCbm,
      weightKg: item.weightKg,
      goodsValue: item.goodsValue ? Number(item.goodsValue) : null,
    })),
  }
}

export function ShipmentDrawer({ open, onClose, detail }: { open: boolean; onClose: () => void; detail?: FirstMileDetail }) {
  const { message } = App.useApp()
  const { canPermission } = useSession()
  const navigate = useAppNavigate()
  const [form] = Form.useForm<Values>()
  const [failure, setFailure] = useState<string | null>(null)
  const refs = useApiQuery<FirstMileListResponse>({ domain: 'reference', path: '/first-mile', params: { pageSize: 1 }, scoped: false, enabled: open })
  const channels = useApiQuery<CarrierListResponse>({ domain: 'reference', path: '/first-mile/carriers', params: { pageSize: 100 }, scoped: false, enabled: open })
  const id = detail?.shipment.id
  const create = useApiMutation<Record<string, unknown>, FirstMileActionResult>({ method: 'POST', path: '/first-mile', invalidate: ['list'], silent: true })
  const update = useApiMutation<Record<string, unknown>, FirstMileActionResult>({ method: 'PATCH', path: `/first-mile/${encodeURIComponent(id ?? 'new')}`, invalidate: ['list'], silent: true })
  const busy = create.isPending || update.isPending
  const canWrite = canPermission(WRITE)
  const withCost = canPermission('field.cost')
  const allocated = detail?.actions.includes('UNALLOCATE') ?? false
  const outbound = Boolean(detail?.shipment.outboundAt)
  const itemsLocked = allocated || outbound
  const hasCosts = (detail?.costs?.length ?? 0) > 0

  const save = async () => {
    setFailure(null)
    try {
      const values = await form.validateFields()
      const body: Record<string, unknown> = {
        forwarderId: values.forwarderId,
        waybillNo: String(values.waybillNo ?? '').trim(),
        mode: values.mode,
        containerNo: dateOrNull(values.containerNo),
        shipDate: dateOrNull(values.shipDate),
        etaPort: dateOrNull(values.etaPort),
        ataPort: dateOrNull(values.ataPort),
        customsStatus: values.customsStatus,
        etaDelivery: dateOrNull(values.etaDelivery),
        ataDelivery: dateOrNull(values.ataDelivery),
        currency: String(values.currency ?? 'USD').toUpperCase(),
        warehouseId: dateOrNull(values.warehouseId),
        carrierChannelId: dateOrNull(values.carrierChannelId),
        linkedInboundShipmentIds: values.linkedInboundShipmentIds ?? [],
        note: dateOrNull(values.note),
      }
      if (withCost) body.estimatedCost = num(values.estimatedCost)
      if (!itemsLocked) {
        body.items = (values.items ?? []).map(item => ({
          sku: String(item.sku ?? '').trim(),
          quantity: Number(item.quantity),
          cartons: num(item.cartons),
          volumeCbm: num(item.volumeCbm),
          weightKg: num(item.weightKg),
          ...(withCost ? { goodsValue: num(item.goodsValue) } : {}),
        }))
      }
      if (detail) {
        await update.mutateAsync({ ...body, version: detail.shipment.version })
        void message.success('运单已保存')
        onClose()
      } else {
        const created = await create.mutateAsync(body)
        void message.success('运单已创建')
        form.resetFields()
        onClose()
        navigate(`/app/first-mile/${encodeURIComponent(created.id)}`)
      }
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return
      const info = describeError(error)
      if (info.fieldErrors) form.setFields(Object.entries(info.fieldErrors).map(([name, errors]) => ({ name: name.split('.')[0] ?? name, errors })))
      setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  const channelOptions = (channels.data?.items ?? []).flatMap(carrier =>
    carrier.channels
      .filter(channel => channel.status === 'ACTIVE' || channel.id === detail?.shipment.carrierChannelId)
      .map(channel => ({ value: channel.id, label: `${carrier.name} · ${channel.name}` })),
  )
  const forwarders = (refs.data?.forwarders ?? []).filter(row => row.status === 'ACTIVE' || row.id === detail?.shipment.forwarderId)

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={820}
      title={detail ? `编辑运单 ${detail.shipment.waybillNo}` : '新建头程运单'}
      destroyOnClose
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Tooltip title={canWrite ? undefined : permissionDeniedMessage(WRITE)}>
            <span>
              <Button type="primary" disabled={!canWrite} loading={busy} onClick={() => void save()}>
                {detail ? '保存' : '创建运单'}
              </Button>
            </span>
          </Tooltip>
        </Space>
      }
    >
      <Form<Values> form={form} layout="vertical" requiredMark={false} initialValues={initialOf(detail)} disabled={busy}>
        <Space size={16} wrap align="start">
          <Form.Item label="货代" name="forwarderId" rules={[{ required: true, message: '请选择货代' }]}>
            <Select
              aria-label="货代"
              style={{ width: 220 }}
              showSearch
              optionFilterProp="label"
              loading={refs.isFetching}
              placeholder="选择合作中的货代"
              options={forwarders.map(row => ({ value: row.id, label: row.name }))}
            />
          </Form.Item>
          <Form.Item label="运单号" name="waybillNo" rules={[{ required: true, whitespace: true, message: '请填写运单号' }]}>
            <Input aria-label="运单号" maxLength={80} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item label="运输方式" name="mode">
            <Select aria-label="运输方式" style={{ width: 120 }} options={modeOptions} />
          </Form.Item>
          <Form.Item label="柜号" name="containerNo">
            <Input aria-label="柜号" maxLength={40} style={{ width: 160 }} />
          </Form.Item>
        </Space>
        <Space size={16} wrap align="start">
          <Form.Item label="发货日" name="shipDate">
            <Input type="date" aria-label="发货日" />
          </Form.Item>
          <Form.Item label="预计到港" name="etaPort">
            <Input type="date" aria-label="预计到港" />
          </Form.Item>
          <Form.Item label="实际到港" name="ataPort">
            <Input type="date" aria-label="实际到港" />
          </Form.Item>
          <Form.Item label="预计交付" name="etaDelivery">
            <Input type="date" aria-label="预计交付" />
          </Form.Item>
          <Form.Item label="实际交付" name="ataDelivery">
            <Input type="date" aria-label="实际交付" />
          </Form.Item>
        </Space>
        <Space size={16} wrap align="start">
          <Form.Item label="清关状态" name="customsStatus">
            <Select aria-label="清关状态" style={{ width: 140 }} options={customsOptions} />
          </Form.Item>
          <Form.Item
            label="币种"
            name="currency"
            rules={[{ required: true, pattern: /^[A-Za-z]{3}$/, message: '3 位字母币种代码，例如 USD' }]}
            extra={hasCosts ? '已录入费用，不能再改币种' : undefined}
          >
            <Input aria-label="币种" maxLength={3} style={{ width: 90 }} disabled={hasCosts} />
          </Form.Item>
          {withCost ? (
            <Form.Item label="预估费用（选填）" name="estimatedCost">
              <InputNumber aria-label="预估费用" min={0} style={{ width: 150 }} />
            </Form.Item>
          ) : null}
          <Form.Item label="出库国内仓（选填）" name="warehouseId">
            <Select aria-label="国内仓" allowClear style={{ width: 200 }} placeholder="不选则不能出库" options={(refs.data?.warehouses ?? []).map(row => ({ value: row.id, label: row.name }))} />
          </Form.Item>
        </Space>
        <Form.Item label="物流渠道（选填）" name="carrierChannelId" extra="选了渠道后，详情页的“费用与分摊”里可以按重量与体积预估头程费用">
          <Select aria-label="物流渠道" allowClear showSearch optionFilterProp="label" loading={channels.isFetching} style={{ width: 320 }} placeholder="不选则不能预估" options={channelOptions} />
        </Form.Item>
        <Form.Item label="关联入仓货件（选填）" name="linkedInboundShipmentIds" extra="填亚马逊入仓货件编号（FBA…）；只能关联已同步到系统里的货件">
          <Select aria-label="关联入仓货件" mode="tags" tokenSeparators={[',', ' ']} open={false} placeholder="输入货件编号后回车" />
        </Form.Item>
        <Form.Item label="备注" name="note">
          <Input.TextArea aria-label="备注" rows={2} maxLength={1000} showCount />
        </Form.Item>
        <Typography.Text strong>明细</Typography.Text>
        {itemsLocked ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message={outbound ? '已出库，明细不能再修改' : '费用已分摊，明细不能修改；要改请先在“费用与分摊”里撤销分摊'} /> : null}
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map(field => (
                <Space key={field.key} align="start" wrap style={{ display: 'flex', marginTop: 8 }}>
                  <Form.Item name={[field.name, 'sku']} rules={[{ required: true, whitespace: true, message: '请填写 SKU' }]} style={{ marginBottom: 0 }}>
                    <Input aria-label="SKU" placeholder="SKU" maxLength={120} style={{ width: 160 }} disabled={itemsLocked} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'quantity']} rules={[{ required: true, message: '请填写数量' }]} style={{ marginBottom: 0 }}>
                    <InputNumber aria-label="数量" placeholder="数量" min={1} precision={0} style={{ width: 90 }} disabled={itemsLocked} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'cartons']} style={{ marginBottom: 0 }}>
                    <InputNumber aria-label="箱数" placeholder="箱数" min={0} precision={0} style={{ width: 80 }} disabled={itemsLocked} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'volumeCbm']} style={{ marginBottom: 0 }}>
                    <InputNumber aria-label="体积（立方米）" placeholder="体积 m³" min={0} style={{ width: 100 }} disabled={itemsLocked} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'weightKg']} style={{ marginBottom: 0 }}>
                    <InputNumber aria-label="重量（千克）" placeholder="重量 kg" min={0} style={{ width: 100 }} disabled={itemsLocked} />
                  </Form.Item>
                  {withCost ? (
                    <Form.Item name={[field.name, 'goodsValue']} style={{ marginBottom: 0 }}>
                      <InputNumber aria-label="货值" placeholder="货值" min={0} style={{ width: 110 }} disabled={itemsLocked} />
                    </Form.Item>
                  ) : null}
                  {fields.length > 1 && !itemsLocked ? <Button type="text" aria-label="删除这一行" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} /> : null}
                </Space>
              ))}
              {itemsLocked ? null : (
                <Button type="dashed" icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => add({})}>
                  添加一行
                </Button>
              )}
            </>
          )}
        </Form.List>
      </Form>
      {failure ? <Alert type="error" showIcon role="alert" style={{ marginTop: 12 }} message={failure} /> : null}
    </Drawer>
  )
}
