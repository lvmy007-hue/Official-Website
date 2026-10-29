import { Form, Input, Select } from 'antd'
import { ALERTS_HANDLE, ALERT_CLOSE_CONCLUSIONS, ALERT_CONCLUSION_LABEL, type AlertActionResponse, type AlertDetailResponse } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 预警详情上的处理动作（09 章 9.1）：确认、分派、忽略（必须写原因）、关闭（必须选结论）。
// 都由服务端在同一个事务里更新预警与关联待办、写时间线与审计；已被别人处理过会提示刷新。预警已结束（已处理、已忽略、已恢复）后按钮禁用并说明。

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

export function AlertActions({ detail, onChanged }: { detail: AlertDetailResponse; onChanged: () => void }) {
  const alert = detail.alert
  const base = `/alerts/${encodeURIComponent(alert.id)}`
  const useAction = (action: string) => useApiMutation<Record<string, unknown>, AlertActionResponse>({ method: 'POST', path: `${base}/${action}`, invalidate: ['list'] })
  const ack = useAction('ack')
  const assign = useAction('assign')
  const ignore = useAction('ignore')
  const close = useAction('close')
  const isOpen = alert.status === 'NEW' || alert.status === 'ACKED'
  const ended = `这条预警已经是“${alert.statusLabel}”`
  const guard = (ok: boolean, reason: string) => ({ permission: ALERTS_HANDLE, condition: { ok, reason } })

  return (
    <>
      <FormAction
        label="确认并开始处理"
        buttonProps={{ type: 'primary' }}
        guard={guard(alert.status === 'NEW', alert.status === 'ACKED' ? '已经确认过' : ended)}
        title="确认这条预警"
        description="确认后预警变为“处理中”，关联待办同步变为处理中。"
        okText="确认"
        successText="已确认"
        onDone={onChanged}
        onSubmit={values => ack.mutateAsync({ note: text(values.note) })}
      >
        <Form.Item label="备注（可选）" name="note">
          <Input.TextArea aria-label="确认备注" rows={2} maxLength={500} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="分派"
        guard={guard(isOpen, ended)}
        title="分派给成员"
        description="会改变关联待办的负责人并通知对方；预警没有待办时自动新建一条。"
        okText="分派"
        successText="已分派"
        onDone={onChanged}
        onSubmit={values => assign.mutateAsync({ assigneeId: values.assigneeId, note: text(values.note) })}
      >
        <Form.Item label="分派给" name="assigneeId" rules={[{ required: true, message: '请选择成员' }]}>
          <Select aria-label="分派给" showSearch optionFilterProp="label" style={{ width: 240 }} options={detail.assignees.map(item => ({ value: item.id, label: item.name }))} />
        </Form.Item>
        <Form.Item label="备注（可选）" name="note">
          <Input.TextArea aria-label="分派备注" rows={2} maxLength={500} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="忽略"
        guard={guard(isOpen, ended)}
        title="忽略这条预警"
        description="忽略后关联待办一并关闭；冷却期内同一对象再次命中不会重复提醒。"
        reason={{ label: '忽略原因', placeholder: '例如：促销期间的预期花费' }}
        okText="忽略"
        successText="已忽略"
        onDone={onChanged}
        onSubmit={values => ignore.mutateAsync({ reason: values.reason })}
      />
      <FormAction
        label="关闭"
        guard={guard(isOpen, ended)}
        title="关闭这条预警"
        description="结论会计入规则的质量统计：标为“误报”的预警会提高该规则的误报率。"
        okText="关闭"
        successText="已关闭"
        onDone={onChanged}
        onSubmit={values => close.mutateAsync({ conclusion: values.conclusion, note: text(values.note) })}
      >
        <Form.Item label="结论" name="conclusion" rules={[{ required: true, message: '请选择结论' }]}>
          <Select aria-label="结论" style={{ width: 200 }} options={ALERT_CLOSE_CONCLUSIONS.map(value => ({ value, label: ALERT_CONCLUSION_LABEL[value] }))} />
        </Form.Item>
        <Form.Item label="备注（可选）" name="note">
          <Input.TextArea aria-label="关闭备注" rows={2} maxLength={1000} />
        </Form.Item>
      </FormAction>
    </>
  )
}
