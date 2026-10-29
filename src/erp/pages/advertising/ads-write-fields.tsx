import { Form, Input, InputNumber, Select } from 'antd'
import { ADS_BID_STRATEGIES, ADS_BID_STRATEGY_LABEL, ADS_WRITE_STATES, ADS_WRITE_STATE_LABEL, type AdsWriteOp } from '@nova/api-contracts'

// 广告写入动作的表单项与取值读取（P3-17）：金额、状态、竞价策略、词与匹配方式。取值不完整时返回提示文字，由写入动作显示在“预览修改”旁边。

export const amountOf = (values: Record<string, unknown>): number | null => (typeof values.amount === 'number' && Number.isFinite(values.amount) ? values.amount : null)

export function AmountField({ label, name = 'amount', extra }: { label: string; name?: string; extra?: string }) {
  return (
    <Form.Item name={name} label={label} extra={extra}>
      <InputNumber min={0} step={0.01} precision={2} style={{ width: 160 }} aria-label={label} />
    </Form.Item>
  )
}

export function StateField() {
  return (
    <Form.Item name="state" label="目标状态">
      <Select aria-label="目标状态" style={{ width: 160 }} options={ADS_WRITE_STATES.map(value => ({ value, label: ADS_WRITE_STATE_LABEL[value] }))} />
    </Form.Item>
  )
}

export function StrategyField() {
  return (
    <Form.Item name="strategy" label="竞价策略">
      <Select aria-label="竞价策略" style={{ width: 220 }} options={ADS_BID_STRATEGIES.map(value => ({ value, label: ADS_BID_STRATEGY_LABEL[value] }))} />
    </Form.Item>
  )
}

export function TextField({ label, name = 'text' }: { label: string; name?: string }) {
  return (
    <Form.Item name={name} label={label}>
      <Input aria-label={label} maxLength={80} style={{ width: 280 }} />
    </Form.Item>
  )
}

export function MatchField({ options }: { options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <Form.Item name="matchType" label="匹配方式">
      <Select aria-label="匹配方式" style={{ width: 200 }} options={[...options]} />
    </Form.Item>
  )
}

/** 同一个值写给多个对象：状态、金额、策略。 */
export function opsOfIds(ids: readonly string[], make: (entityId: string) => AdsWriteOp): AdsWriteOp[] {
  return ids.map(make)
}
