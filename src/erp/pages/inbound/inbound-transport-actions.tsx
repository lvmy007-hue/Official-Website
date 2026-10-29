import { Alert, Form, Input, Select } from 'antd'
import { VOID_WINDOW_HOURS, type DeliveryWindowView, type InboundOptionsResponse, type InboundOverview, type TransportOptionView } from '@nova/api-contracts'
import { ActionGuard, FormAction } from '../../components'
import { formatDateTime, formatMoney } from '../../format'
import { guardFor, SWITCH, usePlanWrite, versionOf } from './inbound-actions'

// 运输方案与送达时间窗的动作：生成（不受开关控制）、确认（受 sw.inbound.transport.confirm 控制）。
// 联系人只用于这一次调用，不写入审计；后台任务完成后会从操作记录里清除。

const expired = (at: string | null) => at !== null && new Date(at).getTime() <= Date.now()

function ContactFields() {
  return (
    <>
      <Form.Item label="货件联系人" name="contactName" rules={[{ required: true, whitespace: true, message: '请填写联系人' }]}>
        <Input aria-label="联系人" maxLength={80} />
      </Form.Item>
      <Form.Item label="联系电话" name="contactPhone" rules={[{ required: true, whitespace: true, message: '请填写电话' }]}>
        <Input aria-label="联系电话" maxLength={30} />
      </Form.Item>
      <Form.Item label="联系邮箱" name="contactEmail" rules={[{ required: true, type: 'email', message: '请填写正确的邮箱' }]}>
        <Input aria-label="联系邮箱" maxLength={120} />
      </Form.Item>
    </>
  )
}

const contactOf = (values: Record<string, unknown>) => ({ name: String(values.contactName).trim(), phoneNumber: String(values.contactPhone).trim(), email: String(values.contactEmail).trim() })

export function TransportGenerateAction({ overview, shipments }: { overview: InboundOverview; shipments: InboundOptionsResponse['shipments'] }) {
  const write = usePlanWrite(overview.plan.id)
  if (!overview.actions.GENERATE_TRANSPORT.allowed) return null
  return (
    <FormAction
      label="生成运输方案"
      guard={guardFor(overview, 'GENERATE_TRANSPORT', null)}
      title="生成运输方案"
      description={<Alert type="info" showIcon message={`向亚马逊为 ${shipments.length} 个货件询价（只产生可比较的报价，不会确认任何方案）。报价有有效期，过期要重新生成。`} />}
      okText="开始生成"
      successText="已交给后台任务，报价会出现在“运输方案”页签"
      buttonProps={{ type: 'primary' }}
      onSubmit={values =>
        write.post('/transport-options', {
          action: 'GENERATE',
          ...versionOf(overview.plan),
          shipments: shipments.map(item => ({ shipmentId: item.shipmentId, readyToShipAt: new Date(String(values.readyAt)).toISOString(), contact: contactOf(values) })),
        })
      }
    >
      <Form.Item label="备货完成时间" name="readyAt" rules={[{ required: true, message: '请填写备货完成时间' }]}>
        <Input aria-label="备货完成时间" type="datetime-local" style={{ width: 240 }} />
      </Form.Item>
      <ContactFields />
    </FormAction>
  )
}

const optionLabel = (option: TransportOptionView) =>
  `${option.carrier ?? '承运商未给出'} · ${option.modeLabel ?? option.mode ?? '方式未给出'} · ${option.cost === null ? '费用未给出' : formatMoney(option.cost, option.currency)}`

export function TransportConfirmAction({ overview, shipments, transport }: { overview: InboundOverview; shipments: InboundOptionsResponse['shipments']; transport: TransportOptionView[] }) {
  const write = usePlanWrite(overview.plan.id)
  if (!overview.actions.CONFIRM_TRANSPORT.allowed) return null
  const offered = (shipmentId: string) => transport.filter(option => option.shipmentId === shipmentId && option.status === 'OFFERED' && !expired(option.expiresAt))
  const blocked = shipments.some(item => offered(item.shipmentId).length === 0)
  const guard = guardFor(overview, 'CONFIRM_TRANSPORT', SWITCH.transport)
  return (
    <FormAction
      label="确认运输方案"
      guard={blocked ? { ...guard, condition: { ok: false, reason: '有货件没有可选的运输方案（还没生成，或报价已过期）' } } : guard}
      title="确认运输方案"
      description={
        <Alert
          type="warning"
          showIcon
          message="确认后不能改选其他运输方案，只能在作废窗口内取消。"
          description={`作废窗口：小包裹 ${VOID_WINDOW_HOURS.SPD} 小时，零担与整车 ${VOID_WINDOW_HOURS.LTL} 小时（以亚马逊返回的截止时间为准）。每个货件都要选一个方案。`}
        />
      }
      confirmText="我已核对每个货件的承运商与费用，确认运输方案"
      okText="确认"
      successText="已交给后台任务确认运输方案"
      buttonProps={{ type: 'primary' }}
      onSubmit={values =>
        write.post('/transport-options', {
          action: 'CONFIRM',
          ...versionOf(overview.plan),
          selections: shipments.map(item => ({ shipmentId: item.shipmentId, transportOptionId: String(values[`option-${item.shipmentId}`]), contact: contactOf(values) })),
        })
      }
    >
      {shipments.map(item => (
        <Form.Item
          key={item.shipmentId}
          label={`货件 ${item.shipmentId}${item.destinationFc ? `（${item.destinationFc}）` : ''}`}
          name={`option-${item.shipmentId}`}
          rules={[{ required: true, message: '请选择运输方案' }]}
        >
          <Select aria-label={`运输方案 ${item.shipmentId}`} options={offered(item.shipmentId).map(option => ({ value: option.transportOptionId, label: optionLabel(option) }))} />
        </Form.Item>
      ))}
      <ContactFields />
    </FormAction>
  )
}

export function WindowGenerateAction({ overview, shipmentId }: { overview: InboundOverview; shipmentId: string }) {
  const write = usePlanWrite(overview.plan.id)
  if (!overview.actions.GENERATE_WINDOWS.allowed) return null
  return (
    <ActionGuard
      label="生成送达时间窗"
      guard={guardFor(overview, 'GENERATE_WINDOWS', null)}
      preview={{ title: `生成送达时间窗：${shipmentId}`, content: <Alert type="info" showIcon message="向亚马逊查询这个货件可预约的送达时间窗，不会确认任何时间窗。" />, confirmText: '开始生成' }}
      successText="已交给后台任务"
      onExecute={() => write.post('/delivery-windows', { action: 'GENERATE', shipmentId, ...versionOf(overview.plan) })}
    />
  )
}

export function WindowConfirmAction({ overview, window }: { overview: InboundOverview; window: DeliveryWindowView }) {
  const write = usePlanWrite(overview.plan.id)
  if (!overview.actions.CONFIRM_WINDOW.allowed || window.confirmed) return null
  const guard = guardFor(overview, 'CONFIRM_WINDOW', SWITCH.transport)
  return (
    <ActionGuard
      label="确认时间窗"
      guard={expired(window.availabilityExpiresAt) ? { ...guard, condition: { ok: false, reason: '这个时间窗已过期，请重新生成' } } : guard}
      preview={{
        title: '确认送达时间窗',
        content: (
          <Alert type="warning" showIcon message={`${window.shipmentId}：${formatDateTime(window.windowStart)} 至 ${formatDateTime(window.windowEnd)}`} description="确认后由后台任务提交亚马逊。" />
        ),
        confirmText: '确认',
      }}
      successText="已交给后台任务确认时间窗"
      onExecute={() => write.post('/delivery-windows', { action: 'CONFIRM', shipmentId: window.shipmentId, optionId: window.deliveryWindowOptionId, ...versionOf(overview.plan) })}
    />
  )
}
