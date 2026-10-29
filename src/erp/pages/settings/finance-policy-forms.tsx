import { Form, Input, Select, Typography } from 'antd'
import {
  FINANCE_POLICY_STEP_UP,
  FINANCE_POLICY_WRITE,
  describePolicyChanges,
  policyValuesOf,
  type FinancePolicyResponse,
  type PolicyDecisionResult,
  type PolicyKey,
  type PolicySubmitResult,
  type PolicyValues,
  type PolicyVersionView,
} from '@nova/api-contracts'
import { FormAction, type GuardInput } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 财务口径的写入动作（P2b-15）：提交修改、审批通过、驳回或撤回。三个动作都要再次验证身份；
// 能不能点以服务端给的 actions 为准（含不能点的原因），提交只调服务端，结果以服务端为准。

const PATH = '/settings/finance-policy'
const EDITABLE: readonly PolicyKey[] = ['revenueRecognition', 'inventoryCostMethod', 'adsAllocationMode', 'storeFeeAllocation']

const guardOf = (action: { allowed: boolean; reason: string | null }): GuardInput => ({
  permission: FINANCE_POLICY_WRITE,
  condition: { ok: action.allowed, reason: action.reason ?? undefined },
})

export function SubmitAction({ data }: { data: FinancePolicyResponse }) {
  const mutation = useApiMutation<Record<string, unknown>, PolicySubmitResult>({ method: 'PUT', path: PATH, invalidate: ['config'], silent: true })
  return (
    <FormAction
      label="修改口径"
      title="提交财务口径修改"
      okText="提交审批"
      guard={guardOf(data.actions.submit)}
      stepUp={FINANCE_POLICY_STEP_UP}
      reason={{ label: '修改原因', placeholder: '例如：与会计师确认，存货改用月末加权平均核算' }}
      description="提交后进入待审批，另一位有“修改财务口径”权限的成员审批通过才生效；生效日不能落在关账中或已关账的期间里。"
      initialValues={{ effectiveFrom: data.today, ...data.current.values }}
      successText="已提交，等待另一位成员审批"
      onSubmit={values => mutation.mutateAsync({ ...values, version: data.latestVersionNo })}
    >
      <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: '请选择生效日期' }]} extra={`不晚于今天（${data.today}）；已关账与关账中的期间不受影响`}>
        <Input type="date" aria-label="生效日期" max={data.today} />
      </Form.Item>
      {data.fields
        .filter(field => EDITABLE.includes(field.key))
        .map(field => (
          <Form.Item key={field.key} label={field.label} name={field.key} extra={field.description} rules={[{ required: true, message: `请选择${field.label}` }]}>
            <Select aria-label={field.label} options={field.options} />
          </Form.Item>
        ))}
    </FormAction>
  )
}

const changesOf = (current: PolicyValues, pending: PolicyVersionView) => describePolicyChanges(current, policyValuesOf(pending))

export function ChangeList({ current, pending }: { current: PolicyValues; pending: PolicyVersionView }) {
  const changes = changesOf(current, pending)
  if (changes.length === 0) return <Typography.Text type="secondary">与当前口径相同（用于把默认口径正式登记）</Typography.Text>
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {changes.map(text => (
        <li key={text}>{text}</li>
      ))}
    </ul>
  )
}

export function DecisionActions({ data, pending }: { data: FinancePolicyResponse; pending: PolicyVersionView }) {
  const decide = useApiMutation<{ body: Record<string, unknown> }, PolicyDecisionResult>({
    method: 'POST',
    path: `${PATH}/${pending.versionNo}/approve`,
    body: v => v.body,
    invalidate: ['config'],
    silent: true,
  })
  const send = (decision: 'APPROVED' | 'REJECTED', comment: unknown) => decide.mutateAsync({ body: { decision, comment: String(comment ?? '').trim(), version: pending.version } })
  const withdraw = pending.mine
  return (
    <>
      <FormAction
        label="审批通过"
        title={`审批通过第 ${pending.versionNo} 版口径`}
        okText="通过并生效"
        guard={guardOf(data.actions.approve)}
        stepUp={FINANCE_POLICY_STEP_UP}
        description={
          <div>
            <div>通过后立即生效，利润日表按新口径重算（最长 6 小时）；已关账与关账中的期间不重算。</div>
            <ChangeList current={data.current.values} pending={pending} />
          </div>
        }
        successText="口径已生效"
        buttonProps={{ type: 'primary' }}
        onSubmit={values => send('APPROVED', values.comment)}
      >
        <Form.Item label="审批意见（选填）" name="comment">
          <Input.TextArea aria-label="审批意见" rows={2} maxLength={500} showCount />
        </Form.Item>
      </FormAction>
      <FormAction
        label={withdraw ? '撤回修改' : '驳回'}
        title={withdraw ? `撤回第 ${pending.versionNo} 版口径修改` : `驳回第 ${pending.versionNo} 版口径修改`}
        okText={withdraw ? '确认撤回' : '确认驳回'}
        danger
        guard={guardOf(data.actions.reject)}
        stepUp={FINANCE_POLICY_STEP_UP}
        reason={{ label: withdraw ? '撤回原因' : '驳回原因' }}
        successText={withdraw ? '已撤回' : '已驳回'}
        onSubmit={values => send('REJECTED', values.reason)}
      />
    </>
  )
}
