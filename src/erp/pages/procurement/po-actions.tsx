import { Alert, Form, Input, InputNumber, Select } from 'antd'
import { INSPECTION_RESULT_LABEL, INSPECTION_RESULTS, PAYMENT_KIND_LABEL, PAYMENT_KINDS, type PoActionResult, type PurchaseOrderDetail } from '@nova/api-contracts'
import { ActionGuard, FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { optional } from './procurement-ui'

// 采购单详情上的动作。可用的动作由服务端按订单状态算出（detail.actions），页面只负责显示；
// 提交后以服务端结果为准，成功才提示。每个写入都带着页面看到的版本号：别人先改了会提示刷新，不会覆盖。

type Call = { suffix: string; body: Record<string, unknown> }

export function usePoCall(id: string) {
  return useApiMutation<Call, PoActionResult>({
    method: 'POST',
    path: call => `/purchase-orders/${encodeURIComponent(id)}/${call.suffix}`,
    body: call => call.body,
    invalidate: ['list'],
    silent: true,
  })
}

const today = () => new Date().toISOString().slice(0, 10)
const need = (permission: string) => ({ permission })
const dateField = (name: string, label: string, required: boolean) => (
  <Form.Item label={label} name={name} rules={required ? [{ required: true, message: `请填写${label}` }] : undefined}>
    <Input type="date" aria-label={label} style={{ width: 180 }} />
  </Form.Item>
)
const number = (name: string, label: string, props: { min?: number; max?: number; precision?: number; required?: boolean } = {}) => (
  <Form.Item label={label} name={name} rules={props.required ? [{ required: true, message: `请填写${label}` }] : undefined}>
    <InputNumber aria-label={label} min={props.min ?? 0} max={props.max} precision={props.precision} style={{ width: 180 }} />
  </Form.Item>
)

/** 每个商品行一个数量输入（收货看“未收数量”，退货看“已收数量”）。 */
function LineQuantities({ detail, mode }: { detail: PurchaseOrderDetail; mode: 'receive' | 'return' }) {
  return (
    <>
      {detail.lines.map(line => {
        const max = mode === 'receive' ? line.quantity - line.receivedQuantity : line.receivedQuantity
        if (max <= 0) return null
        return (
          <Form.Item key={line.id} label={`${line.sellerSku}（${mode === 'receive' ? `订购 ${line.quantity}，已收 ${line.receivedQuantity}，未收` : '已收'} ${max}）`} name={`qty_${line.id}`}>
            <InputNumber aria-label={`${line.sellerSku} ${mode === 'receive' ? '本次收货' : '退货'}数量`} min={0} max={max} precision={0} style={{ width: 180 }} />
          </Form.Item>
        )
      })}
    </>
  )
}

function pickLines(detail: PurchaseOrderDetail, values: Record<string, unknown>) {
  const lines = detail.lines.flatMap(line => (Number(values[`qty_${line.id}`]) > 0 ? [{ lineId: line.id, quantity: Number(values[`qty_${line.id}`]) }] : []))
  if (!lines.length) throw new Error('请至少为一行填写数量')
  return lines
}

export function PoActions({ detail, onEdit }: { detail: PurchaseOrderDetail; onEdit: () => void }) {
  const { order } = detail
  const call = usePoCall(order.id)
  const version = order.version
  const has = (action: PurchaseOrderDetail['actions'][number]) => detail.actions.includes(action)
  const run = (suffix: string, body: Record<string, unknown> = {}) => call.mutateAsync({ suffix, body: { version, ...body } })
  const status = (action: string, reason?: string, extra: Record<string, unknown> = {}) => run('status', { action, ...(reason ? { reason } : {}), ...extra })

  return (
    <>
      {has('EDIT') ? <ActionGuard label="编辑" guard={need('purchase.order.write')} onExecute={async () => onEdit()} /> : null}
      {has('SUBMIT') ? (
        <FormAction
          label="提交审批"
          guard={need('purchase.order.write')}
          title="提交审批"
          description={<Alert type="info" showIcon message="提交后订单进入“待审批”，不能再编辑；每一行都要有单价。创建或提交的人不能审批自己的单。" />}
          okText="提交审批"
          successText="已提交审批"
          buttonProps={{ type: 'primary' }}
          onSubmit={() => run('submit')}
        />
      ) : null}
      {has('APPROVE') ? (
        <>
          <FormAction
            label="审批通过"
            guard={{ ...need('purchase.order.approve'), condition: { ok: detail.canApprove, reason: '创建或提交这张采购单的人不能审批它，请换一位有审批权限的成员' } }}
            title="审批通过"
            description="通过后订单进入“已下单”，开始计交期。"
            okText="通过"
            successText="已审批通过"
            buttonProps={{ type: 'primary' }}
            onSubmit={values => run('approve', { decision: 'APPROVED', ...(optional(values.comment) ? { comment: optional(values.comment) } : {}) })}
          >
            <Form.Item label="审批意见（选填）" name="comment">
              <Input.TextArea rows={2} maxLength={500} aria-label="审批意见" />
            </Form.Item>
          </FormAction>
          <FormAction
            label="驳回"
            danger
            guard={{ ...need('purchase.order.approve'), condition: { ok: detail.canApprove, reason: '创建或提交这张采购单的人不能审批它，请换一位有审批权限的成员' } }}
            title="驳回采购单"
            description="驳回后订单退回草稿，提交人修改后可重新提交。"
            reason={{ label: '驳回意见', placeholder: '例如：价格偏高，请重新询价' }}
            okText="驳回"
            successText="已驳回"
            onSubmit={values => run('approve', { decision: 'REJECTED', comment: values.reason })}
          />
        </>
      ) : null}
      {has('START_PRODUCTION') ? <ActionGuard label="开始生产" guard={need('purchase.order.write')} onExecute={() => status('START_PRODUCTION')} successText="已标记为生产中" /> : null}
      {has('RECEIVE') ? (
        <FormAction
          label="登记收货"
          guard={need('purchase.receive')}
          title="登记收货"
          description="可以分批收货；收货会在国内仓记入库流水，全部到货后自动生成成本版本草稿。数量不能超过未收数量。"
          initialValues={{ receivedAt: today() }}
          okText="登记"
          successText="收货已登记"
          buttonProps={{ type: 'primary' }}
          onSubmit={values => run('receipts', { receivedAt: values.receivedAt, lines: pickLines(detail, values), ...(optional(values.note) ? { note: optional(values.note) } : {}) })}
        >
          {dateField('receivedAt', '收货日期', true)}
          <LineQuantities detail={detail} mode="receive" />
          <Form.Item label="备注（选填）" name="note">
            <Input aria-label="收货备注" maxLength={500} />
          </Form.Item>
        </FormAction>
      ) : null}
      {has('INSPECT') ? (
        <FormAction
          label="登记质检"
          guard={need('purchase.receive')}
          title="登记质检"
          initialValues={{ result: 'PASS' }}
          okText="登记"
          successText="质检已登记"
          onSubmit={values =>
            run('inspections', {
              result: values.result,
              lotQty: values.lotQty,
              sampleQty: values.sampleQty,
              defectQty: values.defectQty ?? 0,
              ...(optional(values.handling) ? { handling: optional(values.handling) } : {}),
              ...(values.receiptId ? { receiptId: values.receiptId } : {}),
            })
          }
        >
          <Form.Item label="质检结果" name="result">
            <Select aria-label="质检结果" options={INSPECTION_RESULTS.map(value => ({ value, label: INSPECTION_RESULT_LABEL[value] }))} style={{ width: 180 }} />
          </Form.Item>
          <Form.Item label="对应收货单（选填）" name="receiptId">
            <Select allowClear aria-label="对应收货单" options={detail.receipts.map(row => ({ value: row.id, label: row.receiptNo }))} style={{ width: 260 }} />
          </Form.Item>
          {number('lotQty', '批量（件）', { min: 1, precision: 0, required: true })}
          {number('sampleQty', '抽检数（件）', { min: 1, precision: 0, required: true })}
          {number('defectQty', '不良数（件）', { precision: 0 })}
          <Form.Item label="处理方式（选填）" name="handling">
            <Input aria-label="处理方式" maxLength={300} placeholder="例如：让步接收、退货、返工" />
          </Form.Item>
        </FormAction>
      ) : null}
      {has('PAY') ? (
        <FormAction
          label="登记付款"
          guard={need('purchase.pay')}
          title="登记付款"
          description="填了付款日是“已付”；不填付款日只是“计划付款”，之后可以在“付款”页签标记已付。已付与计划合计不能超过订单合计。"
          initialValues={{ kind: 'DEPOSIT' }}
          okText="登记"
          successText="付款已登记"
          onSubmit={values =>
            run('payments', {
              kind: values.kind,
              amount: values.amount,
              ...(optional(values.paidAt) ? { paidAt: optional(values.paidAt) } : {}),
              ...(optional(values.plannedAt) ? { plannedAt: optional(values.plannedAt) } : {}),
              ...(optional(values.method) ? { method: optional(values.method) } : {}),
            })
          }
        >
          <Form.Item label="款项类型" name="kind">
            <Select aria-label="款项类型" options={PAYMENT_KINDS.map(value => ({ value, label: PAYMENT_KIND_LABEL[value] }))} style={{ width: 180 }} />
          </Form.Item>
          {number('amount', `金额（${order.currency}）`, { min: 0.01, required: true })}
          {dateField('paidAt', '付款日（已付才填）', false)}
          {dateField('plannedAt', '计划付款日（选填）', false)}
          <Form.Item label="付款方式（选填）" name="method">
            <Input aria-label="付款方式" maxLength={60} />
          </Form.Item>
        </FormAction>
      ) : null}
      {has('RETURN') ? (
        <FormAction
          label="退货给供应商"
          danger
          guard={need('purchase.order.write')}
          title="退货给供应商"
          description={<Alert type="warning" showIcon message="退货会从国内仓扣减库存，订单变为“退货给供应商”，不能撤销。库存不够退（已出库或被占用）时会被拒绝。" />}
          reason={{ label: '退货原因', placeholder: '例如：质检不合格' }}
          okText="确认退货"
          successText="已退货"
          onSubmit={values => status('RETURN', String(values.reason), { lines: pickLines(detail, values) })}
        >
          <LineQuantities detail={detail} mode="return" />
        </FormAction>
      ) : null}
      {has('CLOSE') ? (
        <FormAction
          label="关闭订单"
          guard={need('purchase.order.write')}
          title="关闭采购单"
          description={<Alert type="info" showIcon message="全部到货的订单要付清款项才能关闭；部分到货时关闭表示“短交结案”，剩余数量不再收货，关闭后仍可登记剩余付款。" />}
          reason={{ label: '关闭原因', placeholder: '例如：已付清结案、供应商短交' }}
          okText="关闭"
          successText="订单已关闭"
          onSubmit={values => status('CLOSE', String(values.reason))}
        />
      ) : null}
      {has('CANCEL') ? (
        <FormAction
          label="取消订单"
          danger
          guard={need('purchase.order.write')}
          title="取消采购单"
          description="取消后不能恢复。已付过款的订单不能直接取消。"
          reason={{ label: '取消原因', placeholder: '例如：客户取消、重复下单' }}
          okText="取消订单"
          successText="订单已取消"
          onSubmit={values => status('CANCEL', String(values.reason))}
        />
      ) : null}
    </>
  )
}
