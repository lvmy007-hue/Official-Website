import { Alert, Form, InputNumber, Select, Space, Typography } from 'antd'
import type { DecisionResponse, DraftResponse, RecommendationRow } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { InboundDraftsAction } from './InboundDraftsAction'

// 批量动作栏：对勾选的建议采纳、调整、忽略，或生成草稿。
// 采购单草稿是真实单据（状态草稿，商品成本尚未接入所以单价为空）；上游仓储入库订单草稿是真实的本地草稿（不调用亚马逊，包装与地址要到上游仓储页补全后才能提交）；入仓计划草稿是真实的本地草稿（P6-08）：先预览分组、数量与发货地址，确认后按“店铺 + 地址”各生成一份，不调用亚马逊。

const PLAN = 'replenishment.plan.create'

type Supplier = { id: string; name: string; status: string }

function SupplierField() {
  const suppliers = useApiQuery<Supplier[]>({ domain: 'reference', path: '/procurement/suppliers', scoped: false })
  const options = (suppliers.data ?? []).filter(item => item.status === 'ACTIVE').map(item => ({ value: item.id, label: item.name }))
  return (
    <Form.Item
      label="供应商"
      name="supplierId"
      rules={[{ required: true, message: '请选择供应商' }]}
      extra={suppliers.error ? '读取供应商失败，请确认有“供应商查看”权限' : '采购单挂在这个供应商名下，状态为草稿，不会发给供应商'}
    >
      <Select showSearch optionFilterProp="label" loading={suppliers.isPending} options={options} placeholder="选择供应商" style={{ width: 280 }} />
    </Form.Item>
  )
}

export function ActionBar({ batchId, selected, onDone }: { batchId: string; selected: RecommendationRow[]; onDone: () => void }) {
  const decide = useApiMutation<{ items: Array<Record<string, unknown>> }, DecisionResponse>({
    method: 'POST',
    path: `/replenishment/batches/${encodeURIComponent(batchId)}/decisions`,
    invalidate: ['list', 'analytics'],
    silent: true,
  })
  const purchase = useApiMutation<Record<string, unknown>, DraftResponse>({ method: 'POST', path: '/replenishment/to-purchase-draft', invalidate: ['list', 'analytics'], silent: true })
  const awd = useApiMutation<Record<string, unknown>, DraftResponse>({ method: 'POST', path: '/replenishment/to-awd-draft', invalidate: ['list'], silent: true })

  const none = selected.length === 0
  const guard = { permission: PLAN, condition: { ok: !none, reason: '请先在列表里勾选建议' } }
  const items = selected.map(row => ({ recommendationId: row.id }))
  const withQty = selected.map(row => ({ recommendationId: row.id, qty: row.purchaseQty > 0 ? row.purchaseQty : row.recommendedQty }))
  const awdGuard = { permission: 'awd.order.write', condition: { ok: !none, reason: '请先在列表里勾选建议' } }
  const awdItems = selected.map(row => ({ recommendationId: row.id, qty: row.recommendedQty }))
  const one = selected.length === 1 ? selected[0] : null

  return (
    <Space direction="vertical" size={4} style={{ width: '100%', margin: '8px 0' }}>
      <Space wrap>
        <Typography.Text type="secondary">已选 {selected.length} 条</Typography.Text>
        <FormAction
          label="采纳"
          guard={guard}
          title={`采纳 ${selected.length} 条建议`}
          description="按建议量采纳；之后可以再生成草稿。采纳只记录决策，不会对外发出任何单据。"
          okText="采纳"
          successText="已采纳"
          onSubmit={() => decide.mutateAsync({ items: selected.map(row => ({ recommendationId: row.id, action: 'ADOPT' })) })}
          onDone={onDone}
        />
        <FormAction
          label="调整数量"
          guard={{ permission: PLAN, condition: { ok: one !== null, reason: '调整数量一次只能选一条建议' } }}
          title="调整建议量"
          initialValues={{ qty: one?.recommendedQty }}
          okText="保存调整"
          successText="已按调整后的数量记录"
          onSubmit={values => decide.mutateAsync({ items: [{ recommendationId: one?.id, action: 'ADJUST', qty: Number(values.qty) }] })}
          onDone={onDone}
        >
          <Form.Item label="调整后数量（件）" name="qty" rules={[{ required: true, message: '请输入数量' }]}>
            <InputNumber min={0} max={10_000_000} precision={0} style={{ width: 200 }} />
          </Form.Item>
        </FormAction>
        <FormAction
          label="忽略"
          guard={guard}
          title={`忽略 ${selected.length} 条建议`}
          reason={{ label: '忽略原因', placeholder: '例如：已有在途采购单覆盖' }}
          okText="忽略"
          successText="已忽略"
          onSubmit={values => decide.mutateAsync({ items: selected.map(row => ({ recommendationId: row.id, action: 'IGNORE', reason: values.reason })) })}
          onDone={onDone}
        />
        <FormAction
          label="生成采购单草稿"
          guard={guard}
          title="生成采购单草稿"
          description={<Alert type="info" showIcon message="草稿里每个 SKU 一行，数量取建议采购量；商品成本尚未接入，单价与总额留空。同一条建议不能重复生成。" />}
          okText="生成草稿"
          successText="已生成采购单草稿"
          onSubmit={values => purchase.mutateAsync({ batchId, items: withQty, supplierId: values.supplierId })}
          onDone={onDone}
        >
          <SupplierField />
        </FormAction>
        <InboundDraftsAction batchId={batchId} targets={items} onDone={onDone} />
        <FormAction
          label="生成上游仓储入库订单草稿"
          guard={awdGuard}
          title="生成上游仓储入库订单草稿"
          description={
            <Alert
              type="info"
              showIcon
              message="同一店铺的建议合成一张本地草稿订单，数量取建议补货量；只在本地保存，不会调用亚马逊。包装（箱或托盘）、尺寸重量与发货地址要到“上游仓储”页补全后才能提交。同一条建议不能重复生成。"
            />
          }
          okText="生成草稿"
          successText="已生成上游仓储入库订单草稿"
          onSubmit={() => awd.mutateAsync({ batchId, items: awdItems })}
          onDone={onDone}
        />
      </Space>
    </Space>
  )
}
