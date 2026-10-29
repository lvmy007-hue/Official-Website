import { useState } from 'react'
import { Alert, Button, Drawer, Form, Input, InputNumber, Select, Space, Switch } from 'antd'
import {
  PRICING_RULE_MODES,
  PRICING_RULE_MODE_LABEL,
  PRICING_STRATEGIES,
  PRICING_STRATEGY_LABEL,
  pricingParamsIssue,
  pricingScopeIssue,
  type PricingParams,
  type PricingRuleView,
  type PricingStrategy,
} from '@nova/api-contracts'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { BLANK_MATRIX_VALUES, matrixIssueOf, matrixOfValues, matrixValuesOf, ScenarioMatrixFields, type MatrixFormValues } from './scenario-matrix-fields'

// 新建或修改定价规则（P4-11）。策略建好后不能改（要换策略请新建一条规则）；自动模式需要两个写入开关都打开才会真的执行，
// 没打开时只生成待确认的建议——页面如实写明，不把“已保存”说成“已自动调价”。

interface FormValues extends MatrixFormValues {
  storeId: string
  name: string
  mode: 'MANUAL' | 'AUTO'
  strategy: PricingStrategy
  param: number | null
  all: boolean
  skus: string
  asins: string
  maxChangePct: number
  dailyLimit: number
  failureStreak: number
  conversionDropPct: number | null
  minMarginPct: number | null
  active: boolean
}

const pct = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(value * 10_000) / 100)
const frac = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(value * 100) / 10_000)
const list = (text: string) =>
  text
    .split(/[\s,，;；]+/)
    .map(item => item.trim())
    .filter(Boolean)

/** 参数字段的名字、单位与取值范围（百分比字段在界面里按百分数填）。 */
export const PARAM_FIELD: Record<PricingStrategy, { label: string; unit: string; min: number; max: number }> = {
  FOLLOW_EXPECTED: { label: '相对预期价格的调整', unit: '%（-20 到 20，负数表示更便宜）', min: -20, max: 20 },
  TARGET_MARGIN: { label: '目标利润率', unit: '%（1 到 90）', min: 1, max: 90 },
  MATCH_LOWEST: { label: '与最低竞争价的差额', unit: '美元（-20 到 20，负数表示更便宜）', min: -20, max: 20 },
}

const paramsOf = (strategy: PricingStrategy, value: number | null): PricingParams => {
  if (value === null) return {}
  if (strategy === 'FOLLOW_EXPECTED') return { offsetPct: frac(value) ?? 0 }
  if (strategy === 'TARGET_MARGIN') return { targetMarginPct: frac(value) ?? 0 }
  return { offsetAmount: value }
}
const paramValueOf = (rule: PricingRuleView): number | null => {
  if (rule.strategy === 'FOLLOW_EXPECTED') return pct(rule.params.offsetPct)
  if (rule.strategy === 'TARGET_MARGIN') return pct(rule.params.targetMarginPct)
  return rule.params.offsetAmount ?? null
}

const blank = (storeId: string): FormValues => ({
  storeId,
  name: '',
  mode: 'MANUAL',
  strategy: 'FOLLOW_EXPECTED',
  param: 0,
  all: true,
  skus: '',
  asins: '',
  maxChangePct: 5,
  dailyLimit: 1,
  failureStreak: 3,
  conversionDropPct: 30,
  minMarginPct: null,
  active: false,
  ...BLANK_MATRIX_VALUES,
})
const valuesOf = (rule: PricingRuleView): FormValues => ({
  storeId: rule.storeId,
  name: rule.name,
  mode: rule.mode,
  strategy: rule.strategy,
  param: paramValueOf(rule),
  all: rule.scope.all,
  skus: rule.scope.skus.join('\n'),
  asins: rule.scope.asins.join('\n'),
  maxChangePct: pct(rule.maxChangePct) ?? 5,
  dailyLimit: rule.dailyLimit,
  failureStreak: rule.breaker.failureStreak,
  conversionDropPct: pct(rule.breaker.conversionDropPct),
  minMarginPct: pct(rule.breaker.minMarginPct),
  active: rule.status === 'ACTIVE',
  ...matrixValuesOf(rule.scenarioMatrix),
})

export function RuleFormDrawer({ editing, stores, onClose }: { editing: PricingRuleView | 'new' | null; stores: Array<{ id: string; name: string }>; onClose: () => void }) {
  const [form] = Form.useForm<FormValues>()
  const [error, setError] = useState<string | null>(null)
  const create = useApiMutation<Record<string, unknown>>({ method: 'POST', path: '/pricing/rules', invalidate: ['list', 'config', 'realtime'], silent: true })
  const update = useApiMutation<{ id: string; body: Record<string, unknown> }>({
    method: 'PATCH',
    path: ({ id }) => `/pricing/rules/${encodeURIComponent(id)}`,
    body: ({ body }) => body,
    invalidate: ['list', 'config', 'realtime'],
    silent: true,
  })
  const pending = create.isPending || update.isPending
  const isNew = editing === 'new'
  const rule = editing && editing !== 'new' ? editing : null
  const strategy = Form.useWatch('strategy', form) ?? rule?.strategy ?? 'FOLLOW_EXPECTED'
  const mode = Form.useWatch('mode', form) ?? rule?.mode ?? 'MANUAL'
  const all = Form.useWatch('all', form) ?? true
  const useMatrix = Form.useWatch('useMatrix', form) ?? (rule?.scenarioMatrix ? true : false)
  const matrixActions = Form.useWatch('matrixAction', form)
  const field = PARAM_FIELD[strategy]

  const submit = async () => {
    setError(null)
    const values = form.getFieldsValue(true) as FormValues
    const params = paramsOf(values.strategy, values.param)
    const scope = { all: values.all, skus: values.all ? [] : list(values.skus ?? ''), asins: values.all ? [] : list(values.asins ?? '').map(item => item.toUpperCase()) }
    const issue = (values.name ?? '').trim() ? (pricingParamsIssue(values.strategy, params) ?? pricingScopeIssue(scope) ?? matrixIssueOf(values)) : '请填写规则名称'
    if (issue) {
      setError(issue)
      return
    }
    const breaker = { failureStreak: values.failureStreak, conversionDropPct: frac(values.conversionDropPct), minMarginPct: frac(values.minMarginPct) }
    const shared = {
      name: values.name.trim(),
      mode: values.mode,
      params,
      scope,
      maxChangePct: frac(values.maxChangePct),
      dailyLimit: values.dailyLimit,
      breaker,
      scenarioMatrix: matrixOfValues(values),
    }
    try {
      if (rule) {
        // 熔断中的规则不能在这里直接恢复成别的状态以外的值：状态只在“恢复”按钮里改
        await update.mutateAsync({ id: rule.id, body: { ...shared, expectedVersion: rule.version, ...(rule.status === 'BREAKER' ? {} : { status: values.active ? 'ACTIVE' : 'PAUSED' }) } })
      } else await create.mutateAsync({ ...shared, storeId: values.storeId, strategy: values.strategy, status: values.active ? 'ACTIVE' : 'PAUSED' })
      onClose()
    } catch (failure) {
      const info = describeError(failure)
      setError(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  return (
    <Drawer
      open={editing !== null}
      onClose={onClose}
      width={560}
      destroyOnClose
      title={isNew ? '新建定价规则' : '修改定价规则'}
      data-testid="pricing-rule-drawer"
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={() => void submit()} loading={pending}>
            保存
          </Button>
        </Space>
      }
    >
      <Form<FormValues> form={form} layout="vertical" requiredMark={false} preserve={false} initialValues={rule ? valuesOf(rule) : blank(stores[0]?.id ?? '')}>
        <Form.Item label="店铺" name="storeId">
          <Select aria-label="店铺" disabled={!isNew} options={stores.map(store => ({ value: store.id, label: store.name }))} />
        </Form.Item>
        <Form.Item label="规则名称" name="name">
          <Input aria-label="规则名称" maxLength={80} />
        </Form.Item>
        <Form.Item label="执行方式" name="mode">
          <Select aria-label="执行方式" options={PRICING_RULE_MODES.map(value => ({ value, label: PRICING_RULE_MODE_LABEL[value] }))} />
        </Form.Item>
        {mode === 'AUTO' ? (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="自动执行需要同时打开“自动调价”与“改价”两个开关；没打开时，这条规则只生成待确认的建议，不会改价。" />
        ) : null}
        <Form.Item label="定价策略" name="strategy">
          <Select aria-label="定价策略" disabled={!isNew} options={PRICING_STRATEGIES.map(value => ({ value, label: PRICING_STRATEGY_LABEL[value] }))} />
        </Form.Item>
        <Form.Item label={`${field.label}${field.unit}`} name="param">
          <InputNumber aria-label={field.label} min={field.min} max={field.max} step={strategy === 'MATCH_LOWEST' ? 0.01 : 0.5} style={{ width: 200 }} />
        </Form.Item>
        <ScenarioMatrixFields enabled={useMatrix} actions={matrixActions} />
        <Form.Item label="适用全部商品" name="all" valuePropName="checked">
          <Switch aria-label="适用全部商品" />
        </Form.Item>
        {all ? null : (
          <>
            <Form.Item label="指定 SKU（空格、逗号或换行分隔，最多 200 个）" name="skus">
              <Input.TextArea aria-label="指定 SKU" rows={2} />
            </Form.Item>
            <Form.Item label="指定 ASIN（10 位）" name="asins">
              <Input.TextArea aria-label="指定 ASIN" rows={2} />
            </Form.Item>
          </>
        )}
        <Space wrap align="start">
          <Form.Item label="单次调幅上限（%）" name="maxChangePct">
            <InputNumber aria-label="单次调幅上限" min={0.1} max={50} step={0.5} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="每个 SKU 每天最多（次）" name="dailyLimit">
            <InputNumber aria-label="每天最多次数" min={1} max={10} precision={0} style={{ width: 150 }} />
          </Form.Item>
        </Space>
        <div style={{ margin: '4px 0 8px', fontWeight: 500 }}>熔断（出问题时自动暂停这条规则）</div>
        <Space wrap align="start">
          <Form.Item label="连续失败次数" name="failureStreak">
            <InputNumber aria-label="连续失败次数" min={1} max={10} precision={0} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="调价后转化率下降超过（%）" name="conversionDropPct">
            <InputNumber aria-label="转化率下降阈值" min={5} max={90} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="调价后利润率低于（%）" name="minMarginPct">
            <InputNumber aria-label="利润率下限" min={0} max={90} style={{ width: 150 }} />
          </Form.Item>
        </Space>
        <Form.Item label={rule?.status === 'BREAKER' ? '启用（熔断中，请用“恢复”按钮）' : '创建后立即启用'} name="active" valuePropName="checked">
          <Switch aria-label="启用" disabled={rule?.status === 'BREAKER'} />
        </Form.Item>
        {error ? <Alert type="error" showIcon role="alert" message={error} /> : null}
      </Form>
    </Drawer>
  )
}
