import { Checkbox, DatePicker, Form, InputNumber, Select, Space, Switch, Typography } from 'antd'
import {
  AGING_FROM_DAYS,
  INBOUND_KINDS,
  INBOUND_KIND_LABEL,
  TRANSPORT_MODES,
  TRANSPORT_LABEL,
  TRANSPORT_PREFERENCES,
  TRANSPORT_PREFERENCE_LABEL,
  type InboundKind,
  type PolicyUpsertBody,
  type ReplenishPolicy,
} from '@nova/api-contracts'

// 补货策略表单（三级：企业、品类、SKU；下级整行覆盖上级）。每次保存都是新版本，旧版本不改。
// 运输方式三选项各填“头程天数、每件到仓成本”：不填天数表示不用这种方式；不填成本表示无法按成本比较（不当 0）。

const w = { width: 200 }
const num = (name: string, label: string, props: { min: number; max: number; step?: number; precision?: number; required?: boolean; extra?: string }) => (
  <Form.Item key={name} label={label} name={name} rules={props.required === false ? [] : [{ required: true, message: `请输入${label}` }]} extra={props.extra}>
    <InputNumber min={props.min} max={props.max} step={props.step} precision={props.precision ?? 0} style={w} />
  </Form.Item>
)

export function PolicyFields() {
  return (
    <>
      {num('leadTimeDays', '总提前期（天，兜底）', { min: 1, max: 365, extra: '没有拆分时效时用它：从下单到可售的总天数' })}
      {num('productionDays', '生产天数', { min: 0, max: 365 })}
      {num('domesticDays', '国内段天数（备货、报关、订舱）', { min: 0, max: 365 })}
      {num('receivingDays', '亚马逊入库上架天数', { min: 0, max: 365 })}
      {num('awdLeadTimeDays', '上游仓储调拨时效（天）', { min: 1, max: 365, required: false, extra: '选填：上游仓储有货时补到 FBA 的天数' })}
      {num('safetyDays', '安全库存（天）', { min: 0, max: 365 })}
      {num('coverageDays', '目标覆盖（天）', { min: 1, max: 730 })}
      {num('redundancyMultiplier', '冗余倍数', { min: 1, max: 10, step: 0.1, precision: 2 })}
      {num('serviceLevel', '服务水平（0.5–0.9999）', { min: 0.5, max: 0.9999, step: 0.01, precision: 4, extra: '例如 0.95：安全库存按这个概率不断货来算' })}
      <Form.Item label="计入可售天数的在途" name="inboundCounted">
        <Checkbox.Group options={INBOUND_KINDS.map(kind => ({ value: kind, label: INBOUND_KIND_LABEL[kind] }))} />
      </Form.Item>
      <Form.Item
        label="建议量计入必断货量"
        name="includeUnavoidableShortage"
        valuePropName="checked"
        extra="必断货量 = 即使今天下单并走最快的运输方式，到仓前仍然补不上的需求。默认不计入建议量（只单独显示），开启后会把它算进建议补货量。"
      >
        <Switch aria-label="建议量计入必断货量" checkedChildren="计入" unCheckedChildren="不计入" />
      </Form.Item>
      <Form.Item label="库龄风险起算（天）" name="agingFromDays" rules={[{ required: true, message: '请选择' }]}>
        <Select style={w} options={AGING_FROM_DAYS.map(days => ({ value: days, label: `${days} 天起` }))} />
      </Form.Item>
      <Typography.Title level={5}>运输方式</Typography.Title>
      {TRANSPORT_MODES.map(mode => (
        <Space key={mode} align="start" wrap>
          <Form.Item label={`${TRANSPORT_LABEL[mode]}头程天数`} name={`transit_${mode}`} extra="不填表示不用这种方式">
            <InputNumber min={1} max={180} precision={0} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label={`${TRANSPORT_LABEL[mode]}每件到仓成本（美元）`} name={`cost_${mode}`} extra="不填则无法按成本比较">
            <InputNumber min={0} max={100000} precision={2} style={{ width: 160 }} />
          </Form.Item>
        </Space>
      ))}
      <Form.Item label="运输偏好" name="transportPreference" rules={[{ required: true, message: '请选择' }]}>
        <Select style={{ width: 320 }} options={TRANSPORT_PREFERENCES.map(item => ({ value: item, label: TRANSPORT_PREFERENCE_LABEL[item] }))} />
      </Form.Item>
      {num('casePackQty', '箱规（每箱件数）', { min: 1, max: 100000, required: false, extra: '不填则不按箱取整' })}
      {num('moq', '起订量（件）', { min: 1, max: 10_000_000, required: false })}
      {num('minOrderValue', '最小订单金额（美元）', { min: 0, max: 100_000_000, precision: 2, required: false })}
      <Form.Item label="生效日期" name="effectiveFrom" extra="不填则今天起生效；不能早于今天">
        <DatePicker allowClear />
      </Form.Item>
    </>
  )
}

/** 当前版本 → 表单初值（新建时给一组不含数值的空白，必填项由使用者填写，不预设默认值）。 */
export function initialOf(policy: ReplenishPolicy | null): Record<string, unknown> {
  const transit = Object.fromEntries(
    (policy?.transportOptions ?? []).flatMap(option => [
      [`transit_${option.mode}`, option.transitDays],
      [`cost_${option.mode}`, option.unitCost ?? undefined],
    ]),
  )
  if (!policy) return { inboundCounted: [] as InboundKind[], transportPreference: 'AUTO', includeUnavoidableShortage: false, ...transit }
  return {
    leadTimeDays: policy.leadTimeDays,
    productionDays: policy.productionDays ?? undefined,
    domesticDays: policy.domesticDays ?? undefined,
    receivingDays: policy.receivingDays ?? undefined,
    awdLeadTimeDays: policy.awdLeadTimeDays ?? undefined,
    safetyDays: policy.safetyDays,
    coverageDays: policy.coverageDays,
    redundancyMultiplier: policy.redundancyMultiplier,
    serviceLevel: policy.serviceLevel ?? undefined,
    inboundCounted: policy.inboundCounted,
    agingFromDays: policy.agingFromDays,
    includeUnavoidableShortage: policy.includeUnavoidableShortage,
    transportPreference: policy.transportPreference ?? 'AUTO',
    casePackQty: policy.casePackQty ?? undefined,
    moq: policy.moq ?? undefined,
    minOrderValue: policy.minOrderValue ?? undefined,
    ...transit,
  }
}

const orNull = (value: unknown) => (value === undefined || value === null || value === '' ? null : Number(value))

/** 表单值 → 提交体。 */
export function toBody(values: Record<string, unknown> & { reason?: string }, target: { level: PolicyUpsertBody['level']; levelRef: string }, expectedVersionNo: number): PolicyUpsertBody {
  const transportOptions = TRANSPORT_MODES.flatMap(mode => {
    const transitDays = orNull(values[`transit_${mode}`])
    return transitDays === null ? [] : [{ mode, transitDays, unitCost: orNull(values[`cost_${mode}`]) }]
  })
  const effective = values.effectiveFrom as { format?: (pattern: string) => string } | undefined | null
  return {
    expectedVersionNo,
    level: target.level,
    levelRef: target.levelRef,
    leadTimeDays: Number(values.leadTimeDays),
    productionDays: Number(values.productionDays),
    domesticDays: Number(values.domesticDays),
    receivingDays: Number(values.receivingDays),
    awdLeadTimeDays: orNull(values.awdLeadTimeDays),
    safetyDays: Number(values.safetyDays),
    coverageDays: Number(values.coverageDays),
    redundancyMultiplier: Number(values.redundancyMultiplier),
    serviceLevel: Number(values.serviceLevel),
    inboundCounted: (values.inboundCounted ?? []) as PolicyUpsertBody['inboundCounted'],
    agingFromDays: values.agingFromDays as PolicyUpsertBody['agingFromDays'],
    includeUnavoidableShortage: values.includeUnavoidableShortage === true,
    transportPreference: values.transportPreference as PolicyUpsertBody['transportPreference'],
    transportOptions,
    casePackQty: orNull(values.casePackQty),
    moq: orNull(values.moq),
    minOrderValue: orNull(values.minOrderValue),
    effectiveFrom: effective?.format ? effective.format('YYYY-MM-DD') : undefined,
    changeReason: String(values.reason ?? ''),
  }
}
