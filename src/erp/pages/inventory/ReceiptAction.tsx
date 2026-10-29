import { Form, Input, InputNumber, Select } from 'antd'
import type { RemovalDetailResponse, RemovalReceiptResponse } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 登记退回件收货（权限 inventory.removal.receive）：逐 SKU 登记实收、良品、损坏数量。
// 同一天同一 SKU 再次登记视为更正当天的登记；服务端校验 SKU 属于该订单、良品与损坏之和不超过实收，错误原样回填到表单。

export const RECEIVE_PERMISSION = 'inventory.removal.receive'

type Values = { sku: string; receivedQty: number; sellableQty: number; damagedQty: number; receivedAt?: string; note?: string }

export function ReceiptAction({ id, detail }: { id: string; detail: RemovalDetailResponse }) {
  const mutation = useApiMutation<Values, RemovalReceiptResponse>({ method: 'POST', path: `/inventory/removals/${encodeURIComponent(id)}/receipt`, invalidate: ['list'], silent: true })
  const options = detail.reconciliation.map(row => ({ value: row.sku, label: `${row.sku}（应收 ${row.expectedQty}）` }))
  return (
    <FormAction
      label="登记收货"
      title="登记退回件收货"
      okText="保存登记"
      successText="已登记收货"
      guard={{ permission: RECEIVE_PERMISSION, condition: { ok: detail.canReceive.allowed, reason: detail.canReceive.reason ?? undefined } }}
      description="按实际收到的件数登记；同一天同一 SKU 再次登记会更正当天的记录，历史更正留有审计。应收数量取订单上的已发货数量。"
      buttonProps={{ type: 'primary' }}
      initialValues={{ sku: options.length === 1 ? options[0]?.value : undefined, damagedQty: 0 }}
      onSubmit={async values => {
        const body = values as unknown as Values
        const note = typeof body.note === 'string' ? body.note.trim() : ''
        await mutation.mutateAsync({
          sku: body.sku,
          receivedQty: body.receivedQty,
          sellableQty: body.sellableQty,
          damagedQty: body.damagedQty ?? 0,
          ...(body.receivedAt ? { receivedAt: body.receivedAt } : {}),
          ...(note ? { note } : {}),
        })
      }}
    >
      <Form.Item label="SKU" name="sku" rules={[{ required: true, message: '请选择 SKU' }]}>
        <Select aria-label="收货 SKU" placeholder="选择 SKU" options={options} />
      </Form.Item>
      <Form.Item label="实收数量" name="receivedQty" rules={[{ required: true, message: '请填写实收数量' }]}>
        <InputNumber aria-label="实收数量" min={0} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item label="其中良品" name="sellableQty" rules={[{ required: true, message: '请填写良品数量' }]}>
        <InputNumber aria-label="良品数量" min={0} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item label="其中损坏" name="damagedQty">
        <InputNumber aria-label="损坏数量" min={0} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item label="收货日期（不填为今天）" name="receivedAt">
        <Input aria-label="收货日期" type="date" />
      </Form.Item>
      <Form.Item label="备注" name="note">
        <Input.TextArea aria-label="收货备注" rows={2} maxLength={500} />
      </Form.Item>
    </FormAction>
  )
}
