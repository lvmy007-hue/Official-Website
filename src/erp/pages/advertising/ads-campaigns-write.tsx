import { Space } from 'antd'
import { type AdsWriteOp } from '@nova/api-contracts'
import { AdsWriteAction, type AdsWriteSubmit } from './ads-write-action'
import { useWriteGate } from './ads-write-gate'
import { amountOf, AmountField, opsOfIds, StrategyField } from './ads-write-fields'

// 广告活动列表的写入动作（P3-17）：勾选活动后暂停、启用、调整日预算、调整竞价策略；都先预览再提交，整批全有或全无。

const submitCampaigns = (ops: AdsWriteOp[]): AdsWriteSubmit => ({ method: 'PATCH', path: '/ads/campaigns', body: { ops } })

export function CampaignWrites({ ids, onDone }: { ids: readonly string[]; onDone?: () => void }) {
  const gate = useWriteGate()
  const picked = { ok: ids.length > 0, reason: '请先勾选活动' }
  const common = { onDone, submit: submitCampaigns }
  const stateAction = (label: string, state: 'PAUSED' | 'ENABLED') => (
    <AdsWriteAction
      {...common}
      condition={gate('CAMPAIGN_STATE', picked)}
      label={label}
      title={`${label}（${ids.length} 个活动）`}
      kind="CAMPAIGN_STATE"
      build={() => opsOfIds(ids, entityId => ({ kind: 'CAMPAIGN_STATE', entityId, state }))}
    />
  )
  return (
    <Space wrap>
      {stateAction('暂停', 'PAUSED')}
      {stateAction('启用', 'ENABLED')}
      <AdsWriteAction
        {...common}
        condition={gate('CAMPAIGN_BUDGET', picked)}
        label="调整预算"
        title={`调整日预算（${ids.length} 个活动）`}
        kind="CAMPAIGN_BUDGET"
        fields={<AmountField label="新的日预算（美元）" extra="所选活动的日预算都会改成这个值" />}
        build={values => {
          const amount = amountOf(values)
          return amount === null ? '请填写新的日预算' : opsOfIds(ids, entityId => ({ kind: 'CAMPAIGN_BUDGET', entityId, amount }))
        }}
      />
      <AdsWriteAction
        {...common}
        condition={gate('CAMPAIGN_BID_STRATEGY', picked)}
        label="调整竞价策略"
        title={`调整竞价策略（${ids.length} 个活动）`}
        kind="CAMPAIGN_BID_STRATEGY"
        fields={<StrategyField />}
        build={values => {
          const strategy = values.strategy
          return typeof strategy === 'string' ? opsOfIds(ids, entityId => ({ kind: 'CAMPAIGN_BID_STRATEGY', entityId, strategy: strategy as 'MANUAL' })) : '请选择竞价策略'
        }}
      />
    </Space>
  )
}
