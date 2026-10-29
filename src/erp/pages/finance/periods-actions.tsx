import { Form, Input } from 'antd'
import { PERIOD_NOTE_MAX, PERIOD_CLOSE, PERIOD_REOPEN, type CheckItem, type PeriodActionState, type PeriodActions, type PeriodDetail } from '@nova/api-contracts'
import { ActionGuard, FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 期间关账的写动作（P2b-13）：检查、确认放行、审批通过/驳回、锁定、重新开账。
// 能不能点、为什么不能点以服务端给的 actions 为准（含权限、状态、审批人不能是检查人等条件）；锁定与重新开账需要再次验证身份。
// 带版本号提交：别人先改了会被服务端拒绝并提示刷新，不覆盖。

type Ack = { key: CheckItem['key']; note: string }
const condition = (state: PeriodActionState) => ({ condition: { ok: state.allowed, reason: state.reason ?? undefined } })

function useAction<V>(id: string, action: string) {
  return useApiMutation<V, unknown>({ method: 'POST', path: `/finance/periods/${encodeURIComponent(id)}/${action}`, invalidate: ['list'], silent: true })
}

export function CheckAction({ period, actions }: { period: PeriodDetail; actions: PeriodActions }) {
  const check = useAction<{ acknowledgements?: Ack[] }>(period.id, 'check')
  return <ActionGuard label="运行完整性检查" buttonProps={{ type: 'primary' }} guard={condition(actions.check)} onExecute={() => check.mutateAsync({})} />
}

/** 检查清单里“广告分摊完成”“对账异常”两项可以确认放行：写明原因，留痕；数字变了确认就失效。 */
export function AcknowledgeAction({ period, item, actions }: { period: PeriodDetail; item: CheckItem; actions: PeriodActions }) {
  const check = useAction<{ acknowledgements: Ack[] }>(period.id, 'check')
  return (
    <FormAction
      label="确认放行"
      buttonProps={{ size: 'small', type: 'link' }}
      guard={{ permission: PERIOD_CLOSE, ...condition(actions.check) }}
      title={`确认放行：${item.label}`}
      description={`这一项${item.baseState === 'NOT_CONNECTED' ? '的数据来源尚未接入' : '没有通过'}：${item.summary}。确认放行表示你已知晓并接受，原因会留在审计记录里；这一项的数字之后变了，确认就失效，需要重新确认。`}
      reason={{ label: '放行原因', placeholder: '例如：广告分摊功能上线前，本月广告费按店铺口径核对过' }}
      okText="确认放行并重新检查"
      onSubmit={values => check.mutateAsync({ acknowledgements: [{ key: item.key, note: String(values.reason ?? '').trim() }] })}
    />
  )
}

export function ApproveActions({ period, actions }: { period: PeriodDetail; actions: PeriodActions }) {
  const approve = useAction<{ version: number; decision: 'APPROVED' | 'REJECTED'; comment?: string }>(period.id, 'approve')
  const guard = { permission: PERIOD_CLOSE, ...condition(actions.approve) }
  return (
    <>
      <FormAction
        label="审批通过"
        guard={guard}
        title="审批通过"
        description="审批人必须不是运行检查的人。审批后即可锁定关账；这期间利润日表对该店铺该期间继续保持停止重算。"
        okText="通过"
        successText="已审批通过"
        onSubmit={values => {
          const comment = String(values.comment ?? '').trim()
          return approve.mutateAsync({ version: period.version, decision: 'APPROVED', ...(comment ? { comment } : {}) })
        }}
      >
        <Form.Item label="审批意见（可选）" name="comment">
          <Input.TextArea aria-label="审批意见" rows={2} maxLength={PERIOD_NOTE_MAX} showCount />
        </Form.Item>
      </FormAction>
      <FormAction
        label="驳回"
        danger
        guard={guard}
        title="驳回关账"
        description="驳回后期间回到“开放”（重新开账过的回到“重新开账”），利润日表恢复重算；修正数据后需要重新检查。"
        reason={{ label: '驳回意见', placeholder: '写明需要修正什么' }}
        okText="驳回"
        successText="已驳回"
        onSubmit={values => approve.mutateAsync({ version: period.version, decision: 'REJECTED', comment: String(values.reason ?? '').trim() })}
      />
    </>
  )
}

export function CloseAction({ period, actions }: { period: PeriodDetail; actions: PeriodActions }) {
  const close = useAction<{ version: number }>(period.id, 'close')
  return (
    <FormAction
      label="锁定关账"
      buttonProps={{ type: 'primary' }}
      guard={{ permission: PERIOD_CLOSE, ...condition(actions.close) }}
      title={`锁定关账：${period.storeName} ${period.month}`}
      description="锁定前会再检查一遍；通过后保存利润快照（三种收入确认口径）、期间内汇率与生效中的成本版本，并锁定期间内的汇率。"
      stepUp={PERIOD_CLOSE}
      confirmText="我已核对关账报表预览，知道锁定后该期间的利润日表不再重算、汇率不能修改"
      okText="锁定"
      successText="已锁定关账"
      onSubmit={() => close.mutateAsync({ version: period.version })}
    />
  )
}

export function ReopenAction({ period, actions }: { period: PeriodDetail; actions: PeriodActions }) {
  const reopen = useAction<{ version: number; reason: string }>(period.id, 'reopen')
  return (
    <FormAction
      label="重新开账"
      danger
      guard={{ permission: PERIOD_REOPEN, ...condition(actions.reopen) }}
      title={`重新开账：${period.storeName} ${period.month}`}
      description="重新开账后该期间的利润日表恢复重算，汇率解锁；已有快照保留。修正后需要重新检查、审批、锁定，锁定时会生成与上一份快照的差异报告。"
      reason={{ label: '重新开账原因', placeholder: '写明为什么要改已关账的期间' }}
      stepUp={PERIOD_REOPEN}
      okText="重新开账"
      successText="已重新开账"
      onSubmit={values => reopen.mutateAsync({ version: period.version, reason: String(values.reason ?? '').trim() })}
    />
  )
}
