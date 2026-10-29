import { Alert, Form, Input, Radio, Select } from 'antd'
import {
  ADS_RULE_FREQUENCIES,
  ADS_RULE_FREQUENCY_LABEL,
  ADS_RULE_LEVEL_LABEL,
  ADS_RULE_LEVELS,
  ADS_RULE_LIMITS,
  ADS_RULE_MODE_LABEL,
  ADS_RULE_MODES,
  ADS_RULE_STATUS_LABEL,
  ADS_RULE_STATUSES,
  ADS_RULE_WRITE,
  type AdsRuleAutoStatus,
  type AdsRuleLevel,
  type AdsRuleProfileOption,
  type AdsRuleRow,
  type AdsRuleWriteResult,
} from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { ActionFields, CampaignsField, ConditionsField, FiltersField } from './ads-rules-editor-fields'
import { createBodyOf, defaultRuleValues, firstActionOf, updateBodyOf, valuesOfRule } from './ads-rules-form'

// 创建与修改自动规则（P3-13）：只改本系统里的规则，不写亚马逊。修改时广告账户与对象层级不可改（改了等于另一条规则），其余可改，带版本号，别人先改了会提示刷新。
// 自动执行模式要写入开关“自动规则执行”已开启；没开时这个选项禁用并写明原因，不会悄悄降级成建议模式。

function ModeField({ auto, current }: { auto: AdsRuleAutoStatus; current?: AdsRuleRow }) {
  return (
    <Form.Item name="mode" label="模式" extra={auto.allowed ? '自动执行模式的执行器随“广告写入接入”提供，接入前命中同样只生成待办' : `自动执行模式暂不可选：${auto.reason ?? '写入开关未开启'}`}>
      <Radio.Group options={ADS_RULE_MODES.map(value => ({ value, label: ADS_RULE_MODE_LABEL[value], disabled: value === 'AUTO' && !auto.allowed && current?.mode !== 'AUTO' }))} />
    </Form.Item>
  )
}

export function RuleEditor({ rule, profiles, auto, onDone }: { rule?: AdsRuleRow; profiles: readonly AdsRuleProfileOption[]; auto: AdsRuleAutoStatus; onDone?: () => void }) {
  const editing = rule !== undefined
  const mutation = useApiMutation<{ id?: string; body: Record<string, unknown> }, AdsRuleWriteResult>({
    method: editing ? 'PATCH' : 'POST',
    path: variables => (variables.id ? `/ads/rules/${variables.id}` : '/ads/rules'),
    body: variables => variables.body,
    invalidate: ['analytics', 'list'],
    silent: true,
  })
  return (
    <FormAction
      label={editing ? '编辑' : '新建规则'}
      title={editing ? `编辑自动规则：${rule.name}` : '新建自动规则'}
      guard={{ permission: ADS_RULE_WRITE }}
      description="规则保存在本系统里；建议模式命中只生成待办，自动执行模式命中活动或投放词时会写入亚马逊。保存后可以先试运行，看按现有数据会命中哪些对象。"
      initialValues={rule ? valuesOfRule(rule) : defaultRuleValues()}
      okText="保存"
      successText="已保存"
      onDone={onDone}
      buttonProps={editing ? { type: 'link', size: 'small' } : { type: 'primary' }}
      onSubmit={async values => {
        if (editing) return mutation.mutateAsync({ id: rule.id, body: updateBodyOf(values, rule.version) })
        return mutation.mutateAsync({ body: createBodyOf(values) })
      }}
    >
      <Form.Item
        name="name"
        label="规则名称"
        rules={[
          { required: true, whitespace: true, message: '请填写名称' },
          { max: ADS_RULE_LIMITS.nameMax, message: `最多 ${ADS_RULE_LIMITS.nameMax} 个字` },
        ]}
      >
        <Input maxLength={ADS_RULE_LIMITS.nameMax + 20} placeholder="例如：高 ACoS 活动暂停" />
      </Form.Item>
      <Form.Item name="adsProfileId" label="广告账户" rules={[{ required: true, message: '请选择广告账户' }]}>
        <Select
          disabled={editing}
          placeholder="选择广告账户"
          options={profiles.map(profile => ({ value: profile.id, label: profile.storeName ? `${profile.name}（${profile.storeName}）` : profile.name }))}
        />
      </Form.Item>
      {editing ? (
        <Form.Item label="对象层级">
          <span>{ADS_RULE_LEVEL_LABEL[rule.spec.level]}</span>
        </Form.Item>
      ) : (
        <LevelField />
      )}
      <ModeField auto={auto} current={rule} />
      <ConditionsField />
      <FiltersField />
      <CampaignsField rule={rule} />
      <ActionFields fixedLevel={rule?.spec.level} />
      <Form.Item name="frequency" label="执行频率" extra="评估只用日级指标，最短每天一次">
        <Select options={ADS_RULE_FREQUENCIES.map(value => ({ value, label: ADS_RULE_FREQUENCY_LABEL[value] }))} />
      </Form.Item>
      <Form.Item name="status" label="状态" extra="已暂停的规则不会被定时评估，但仍可以试运行">
        <Radio.Group options={ADS_RULE_STATUSES.map(value => ({ value, label: ADS_RULE_STATUS_LABEL[value] }))} />
      </Form.Item>
      {!auto.allowed ? <Alert type="info" showIcon message={`自动执行模式暂不可用：${auto.reason ?? '写入开关未开启'}`} /> : null}
    </FormAction>
  )
}

function LevelField() {
  const form = Form.useFormInstance()
  return (
    <Form.Item name="level" label="对象层级">
      <Radio.Group
        options={ADS_RULE_LEVELS.map(value => ({ value, label: ADS_RULE_LEVEL_LABEL[value] }))}
        onChange={event => form.setFieldValue('actionType', firstActionOf(event.target.value as AdsRuleLevel))}
      />
    </Form.Item>
  )
}
