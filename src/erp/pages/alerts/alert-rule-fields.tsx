import { Checkbox, Form, Input, InputNumber, Select, Space, Switch } from 'antd'
import {
  ALERT_QUIET_PATTERN,
  CUSTOM_METRIC_TYPE,
  ALERT_SEVERITIES,
  ALERT_SEVERITY_LABEL,
  alertParamSpecsOf,
  templateRuleName,
  type AlertParamSpec,
  type AlertTemplateDef,
  type AlertRuleScope,
  type AlertRuleView,
  type AlertRulesResponse,
} from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { Muted } from '../inventory/inventory-ui'
import { ConditionFields, EMPTY_CONDITIONS, NotifyFields, notifyBody, notifyInitialValues } from './alert-rule-notify-fields'
import { paramLines } from './alert-rules-ui'

// 规则的编辑与新建（P5-01，09 章 9.1 规则配置）：阈值按评估器登记的范围校验；作用范围（主体、店铺、品类、SKU）、默认负责人、通知对象、静默时段；
// 改动必须填变更原因，保存后生成新版本（带乐观锁版本号，别人先改了会提示刷新）。页面上的取值范围与服务端校验用的是同一份登记表。

const WRITE = 'alerts.manage'
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000
const names = (items: Array<{ id: string; name: string }>) => items.map(item => ({ value: item.id, label: item.name }))

/** 表单里的阈值字段名：避免与范围字段重名。 */
const field = (key: string) => `p_${key}`

function ParamField({ spec }: { spec: AlertParamSpec }) {
  const name = field(spec.key)
  if (spec.kind === 'choices')
    return (
      <Form.Item label={spec.label} name={name} extra={spec.help} rules={[{ required: true, message: '至少选择一项' }]}>
        <Checkbox.Group options={spec.options.map(option => ({ value: option.value, label: option.label }))} />
      </Form.Item>
    )
  const percent = spec.kind === 'percent'
  const rules = [{ required: !(spec.kind === 'number' && spec.nullable), message: `请填写${spec.label}` }]
  return (
    <Form.Item label={spec.label} name={name} extra={spec.help} rules={rules}>
      <InputNumber
        aria-label={spec.label}
        min={percent ? round(spec.min * 100) : spec.min}
        max={percent ? round(spec.max * 100) : spec.max}
        precision={spec.kind === 'number' && spec.integer ? 0 : undefined}
        addonAfter={percent ? '%' : spec.kind === 'number' ? spec.unit : undefined}
        style={{ width: 220 }}
      />
    </Form.Item>
  )
}

const quietRule = { pattern: ALERT_QUIET_PATTERN, message: '格式 HH:MM，例如 22:00' }

function ScopeFields({
  rule,
  options,
  members,
  categories,
}: {
  rule: Pick<AlertRuleView, 'scopeSupport'>
  options?: ScopeOptions
  members: Array<{ id: string; name: string }>
  categories: string[]
}) {
  const { stores, skus } = rule.scopeSupport
  return (
    <>
      <Form.Item label="限定主体" name="legalEntityIds" extra={stores ? '主体下的全部店铺都纳入，新增的店铺自动包含' : '这条规则是企业级的，没有店铺维度，范围里的主体与店铺不生效'}>
        <Select aria-label="限定主体" mode="multiple" allowClear optionFilterProp="label" disabled={!stores} options={names(options?.entities ?? [])} placeholder="不限制" />
      </Form.Item>
      <Form.Item label="限定店铺" name="sellerAccountIds">
        <Select aria-label="限定店铺" mode="multiple" allowClear optionFilterProp="label" disabled={!stores} options={names(options?.stores ?? [])} placeholder="不限制" />
      </Form.Item>
      <Form.Item label="限定品类" name="categories" extra={skus ? '按商品资料里的品类路径前缀匹配' : '这条规则的预警对象没有 SKU 维度（广告活动、结算单、数据来源等），品类与 SKU 不生效'}>
        <Select aria-label="限定品类" mode="tags" allowClear disabled={!skus} options={categories.map(item => ({ value: item, label: item }))} placeholder="不限制" />
      </Form.Item>
      <Form.Item label="限定 SKU" name="skus">
        <Select aria-label="限定 SKU" mode="tags" allowClear disabled={!skus} tokenSeparators={[',', ' ']} placeholder="不限制，输入后回车" />
      </Form.Item>
      <Form.Item label="默认负责人" name="ownerId" extra="这条规则生成的待办默认指派给谁；不选则交给有“预警管理”权限的成员">
        <Select aria-label="默认负责人" allowClear showSearch optionFilterProp="label" options={names(members)} placeholder="自动" />
      </Form.Item>
      <Form.Item label="站内通知对象" name="notifyUserIds" extra="不选只通知待办负责人">
        <Select aria-label="站内通知对象" mode="multiple" allowClear optionFilterProp="label" options={names(members)} placeholder="仅负责人" />
      </Form.Item>
      <Form.Item label="静默时段（企业时区）" extra="时段内不发站内通知，预警与待办照常生成；严重级别不受静默限制。开始与结束都填才生效。">
        <Space.Compact>
          <Form.Item name="quietStart" noStyle rules={[quietRule]}>
            <Input aria-label="静默开始" placeholder="22:00" maxLength={5} style={{ width: 100 }} />
          </Form.Item>
          <Input readOnly value="至" style={{ width: 40, textAlign: 'center', pointerEvents: 'none' }} />
          <Form.Item name="quietEnd" noStyle rules={[quietRule]}>
            <Input aria-label="静默结束" placeholder="07:00" maxLength={5} style={{ width: 100 }} />
          </Form.Item>
        </Space.Compact>
      </Form.Item>
    </>
  )
}

export function RuleFields({ rule, data }: { rule: AlertRuleView; data: AlertRulesResponse }) {
  const scope = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const form = Form.useFormInstance()
  const specs = alertParamSpecsOf(rule.type)
  return (
    <>
      <Form.Item label="启用" name="enabled" valuePropName="checked">
        <Switch aria-label="启用" />
      </Form.Item>
      <Form.Item label="严重度" name="severity">
        <Select aria-label="严重度" style={{ width: 160 }} options={ALERT_SEVERITIES.map(value => ({ value, label: ALERT_SEVERITY_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="冷却分钟数" name="cooldownMinutes" extra="处理或忽略后，同一对象在这段时间内再次命中不重复提醒（0 到 10080）">
        <InputNumber aria-label="冷却分钟数" min={0} max={10_080} precision={0} style={{ width: 160 }} />
      </Form.Item>
      {rule.type === CUSTOM_METRIC_TYPE ? <ConditionFields scope={() => scopeBody(form.getFieldsValue(true) as Record<string, unknown>)} /> : null}
      {rule.type === CUSTOM_METRIC_TYPE ? null : specs.length === 0 ? <Muted>这条规则没有可调的阈值</Muted> : specs.map(spec => <ParamField key={spec.key} spec={spec} />)}
      <NotifyFields />
      <ScopeFields rule={rule} options={scope.data} members={data.members} categories={data.categories} />
    </>
  )
}

export function initialValues(rule: AlertRuleView): Record<string, unknown> {
  const values: Record<string, unknown> = {
    enabled: rule.enabled,
    severity: rule.severity,
    cooldownMinutes: rule.cooldownMinutes,
    legalEntityIds: rule.scope.legalEntityIds ?? [],
    sellerAccountIds: rule.scope.sellerAccountIds ?? [],
    categories: rule.scope.categories ?? [],
    skus: rule.scope.skus ?? [],
    ownerId: rule.scope.ownerId ?? undefined,
    notifyUserIds: rule.scope.notifyUserIds ?? [],
    quietStart: rule.scope.quiet?.start,
    quietEnd: rule.scope.quiet?.end,
    ...notifyInitialValues(rule),
  }
  for (const spec of alertParamSpecsOf(rule.type)) {
    const value = rule.params[spec.key]
    values[field(spec.key)] = spec.kind === 'percent' && typeof value === 'number' ? round(value * 100) : value
  }
  return values
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

export function scopeBody(values: Record<string, unknown>): AlertRuleScope {
  const scope: AlertRuleScope = {}
  for (const key of ['legalEntityIds', 'sellerAccountIds', 'categories', 'skus', 'notifyUserIds'] as const) if (list(values[key]).length > 0) scope[key] = list(values[key])
  if (text(values.ownerId)) scope.ownerId = text(values.ownerId)
  const start = text(values.quietStart)
  const end = text(values.quietEnd)
  if (start && end) scope.quiet = { start, end }
  return scope
}

export function paramsBody(type: string, values: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const spec of alertParamSpecsOf(type)) {
    const value = values[field(spec.key)]
    params[spec.key] = spec.kind === 'percent' && typeof value === 'number' ? round(value / 100) : (value ?? null)
  }
  return params
}

export function RuleEditAction({ rule, data, onChanged }: { rule: AlertRuleView; data: AlertRulesResponse; onChanged: () => void }) {
  const patch = useApiMutation<Record<string, unknown>>({ method: 'PATCH', path: `/alerts/rules/${encodeURIComponent(rule.id)}`, invalidate: ['config', 'list'] })
  return (
    <FormAction
      label="编辑"
      buttonProps={{ size: 'small' }}
      guard={{ permission: WRITE, condition: { ok: data.can.manage, reason: '没有预警管理权限' } }}
      title={`编辑规则：${rule.name}`}
      description="保存后生成新版本；已有预警不受影响，下一轮评估起按新设置生效。"
      reason={{ label: '变更原因', placeholder: '例如：大促期间放宽花费下限' }}
      initialValues={initialValues(rule)}
      okText="保存为新版本"
      successText="规则已保存"
      onDone={onChanged}
      onSubmit={values =>
        patch.mutateAsync({
          version: rule.version,
          changeReason: values.reason,
          enabled: values.enabled,
          severity: values.severity,
          cooldownMinutes: values.cooldownMinutes,
          params: paramsBody(rule.type, values),
          scope: scopeBody(values),
          ...notifyBody(values),
          ...(rule.type === CUSTOM_METRIC_TYPE ? { conditionGroups: values.conditionGroups } : {}),
        })
      }
    >
      <RuleFields rule={rule} data={data} />
    </FormAction>
  )
}

/**
 * 新建自定义规则。从规则模板页跳过来时（template 不为空）自动打开，并带入模板的评估逻辑、名称、严重度、冷却与默认阈值（P6-15）；
 * 关闭或创建成功后调用 onClose，由页面清掉地址里的 template 参数。
 */
export function RuleCreateAction({ data, onChanged, template, onClose }: { data: AlertRulesResponse; onChanged: () => void; template?: AlertTemplateDef; onClose?: () => void }) {
  const create = useApiMutation<Record<string, unknown>>({ method: 'POST', path: '/alerts/rules', invalidate: ['config', 'list'] })
  const types = new Map<string, string>()
  for (const item of data.items) if (!item.custom && !types.has(item.type)) types.set(item.type, item.name)
  // 自定义指标条件不在系统预置的评估逻辑里，单独列在最前面
  const options = [{ value: CUSTOM_METRIC_TYPE, label: '自定义指标条件（按店铺判断）' }, ...[...types].map(([value, label]) => ({ value, label }))]
  const lines = template ? paramLines(template.type, template.params) : []
  return (
    <FormAction
      key={template?.code ?? 'blank'}
      label="新建自定义规则"
      buttonProps={{ type: 'primary' }}
      guard={{ permission: WRITE, condition: { ok: data.can.manage, reason: '没有预警管理权限' } }}
      title={template ? `从模板新建：${template.name}` : '新建自定义规则'}
      description={
        template ? (
          <div data-testid="template-hint">
            <div>
              {template.condition}（适用维度：{template.dimension}）。
            </div>
            <div>{lines.length > 0 ? `带入模板的默认阈值：${lines.map(line => `${line.label} ${line.value}`).join('；')}。` : '这条模板没有可调的阈值。'}创建后可在列表里继续编辑阈值与作用范围。</div>
          </div>
        ) : (
          '自定义规则沿用系统已有的评估逻辑，名称、严重度、冷却时间自己定；阈值取预置默认值，创建后可在列表里编辑阈值与作用范围。'
        )
      }
      defaultOpen={Boolean(template) && data.can.manage}
      onClose={onClose}
      initialValues={{
        ...notifyInitialValues({ notifyFrequency: 'IMMEDIATE', escalation: [], conditionGroups: null }),
        ...(template ? { type: template.type, name: templateRuleName(template.name), severity: template.severity, cooldownMinutes: template.cooldownMinutes } : {}),
      }}
      okText="创建"
      successText="规则已创建"
      onDone={onChanged}
      onSubmit={values =>
        create.mutateAsync({
          type: values.type,
          name: text(values.name),
          severity: values.severity,
          cooldownMinutes: values.cooldownMinutes,
          ...(template && values.type === template.type ? { params: template.params } : {}),
          ...notifyBody(values),
          ...(values.type === CUSTOM_METRIC_TYPE ? { conditionGroups: values.conditionGroups ?? EMPTY_CONDITIONS } : {}),
        })
      }
    >
      <Form.Item label="评估逻辑" name="type" rules={[{ required: true, message: '请选择评估逻辑' }]}>
        <Select aria-label="评估逻辑" showSearch optionFilterProp="label" options={options} />
      </Form.Item>
      <Form.Item noStyle dependencies={['type']}>
        {({ getFieldValue }) => (getFieldValue('type') === CUSTOM_METRIC_TYPE ? <ConditionFields scope={() => ({})} /> : null)}
      </Form.Item>
      <Form.Item label="规则名称" name="name" rules={[{ required: true, min: 2, max: 60, message: '请填写 2 到 60 字的名称' }]}>
        <Input aria-label="规则名称" maxLength={60} />
      </Form.Item>
      <Form.Item label="严重度（不选沿用预置）" name="severity">
        <Select aria-label="严重度" allowClear style={{ width: 160 }} options={ALERT_SEVERITIES.map(value => ({ value, label: ALERT_SEVERITY_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="冷却分钟数（不填沿用预置）" name="cooldownMinutes">
        <InputNumber aria-label="冷却分钟数" min={0} max={10_080} precision={0} style={{ width: 160 }} />
      </Form.Item>
      <NotifyFields />
    </FormAction>
  )
}
