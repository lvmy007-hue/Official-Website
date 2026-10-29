import { Alert, Checkbox, Form, Input, InputNumber, Radio, Select } from 'antd'
import { BACKFILL_SEGMENT_DAYS, SYNC_SCOPE_DOMAINS, SYNC_SCOPE_LABELS } from '@nova/api-contracts'
import { StepFrame } from './StepFrame'
import type { StepPanelProps } from './onboarding-types'

// 需要填写内容的三个步骤（P1-19）：企业资料、同步范围、汇率与成本口径。
// 每个表单用已保存的草稿或企业现有资料作初始值；“保存草稿”不做必填校验，“完成此步”才校验并提交到服务端。

const timezones: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['America/Los_Angeles', 'Asia/Shanghai']
  } catch {
    return ['America/Los_Angeles', 'Asia/Shanghai']
  }
})()
const tzOptions = timezones.map(zone => ({ value: zone, label: zone }))
const CURRENCIES = ['USD', 'CNY', 'EUR', 'GBP', 'JPY'].map(code => ({ value: code, label: code }))

type ProfileValues = { name: string; timezone: string; localTimezone: string; defaultCurrency: string }

export function ProfileStep({ step, view, busy, onSubmit }: StepPanelProps) {
  const [form] = Form.useForm<ProfileValues>()
  const initial = (step.data as ProfileValues | null) ?? view.tenant
  return (
    <StepFrame step={step} busy={busy} onSave={() => onSubmit('SAVE', form.getFieldsValue())} onComplete={() => form.submit()}>
      <Form<ProfileValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        disabled={busy || step.state === 'COMPLETED'}
        initialValues={initial}
        onFinish={values => onSubmit('COMPLETE', values)}
        style={{ maxWidth: 480 }}
      >
        <Form.Item
          label="企业名称"
          name="name"
          rules={[
            { required: true, message: '请输入企业名称' },
            { min: 2, message: '至少 2 个字' },
          ]}
        >
          <Input maxLength={160} />
        </Form.Item>
        <Form.Item label="数据口径时区" name="timezone" extra="亚马逊美国站按美国太平洋时区切日，默认不建议修改。" rules={[{ required: true, message: '请选择时区' }]}>
          <Select showSearch options={tzOptions} />
        </Form.Item>
        <Form.Item label="企业本地时区" name="localTimezone" extra="用于日报、周报的发送时间。" rules={[{ required: true, message: '请选择时区' }]}>
          <Select showSearch options={tzOptions} />
        </Form.Item>
        <Form.Item label="显示币种" name="defaultCurrency" extra="汇率以美元为基准，页面默认按此币种显示。" rules={[{ required: true, message: '请选择币种' }]}>
          <Select options={CURRENCIES} />
        </Form.Item>
      </Form>
    </StepFrame>
  )
}

type ScopeValues = { domains: Array<(typeof SYNC_SCOPE_DOMAINS)[number]>; backfillDays: number }

export function SyncScopeStep({ step, view, busy, onSubmit }: StepPanelProps) {
  const [form] = Form.useForm<ScopeValues>()
  const quota = view.quotas.find(item => item.key === 'backfillDays')
  const days = Form.useWatch('backfillDays', form)
  const initial = (step.data as ScopeValues | null) ?? { domains: [...SYNC_SCOPE_DOMAINS], backfillDays: Math.min(quota?.limit ?? 365, 365) }
  const over = quota?.limit != null && typeof days === 'number' && days > quota.limit
  return (
    <StepFrame step={step} busy={busy} onSave={() => onSubmit('SAVE', form.getFieldsValue())} onComplete={() => form.submit()}>
      <Form<ScopeValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        disabled={busy || step.state === 'COMPLETED'}
        initialValues={initial}
        onFinish={values => onSubmit('COMPLETE', values)}
        style={{ maxWidth: 520 }}
      >
        <Form.Item label="需要同步的数据" name="domains" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个数据域' }]}>
          <Checkbox.Group options={SYNC_SCOPE_DOMAINS.map(key => ({ value: key, label: SYNC_SCOPE_LABELS[key] }))} />
        </Form.Item>
        <Form.Item
          label="历史回补天数"
          name="backfillDays"
          extra={`向导完成后按由近及远分段回补：订单每段 ${BACKFILL_SEGMENT_DAYS.ORDERS} 天、财务每段 ${BACKFILL_SEGMENT_DAYS.FINANCE} 天、广告每段 ${BACKFILL_SEGMENT_DAYS.ADS} 天，最近的数据最先出现。`}
          rules={[{ required: true, message: '请输入天数' }]}
        >
          <InputNumber min={7} max={730} precision={0} addonAfter="天" style={{ width: 200 }} />
        </Form.Item>
        {quota?.limit != null ? (
          <Alert
            type={over ? 'warning' : 'info'}
            showIcon
            message={over ? `超过了报价约定的 ${quota.limit} 天，仍可提交，但需联系平台运营调整配额。` : `报价约定的历史回补上限为 ${quota.limit} 天。`}
          />
        ) : null}
      </Form>
    </StepFrame>
  )
}

type FxValues = { costMethod: 'WEIGHTED_AVERAGE' | 'FIFO'; fxPolicy: 'AUTO_DAILY' | 'AUTO_WITH_MANUAL_OVERRIDE' }

export function FxCostStep({ step, busy, onSubmit }: StepPanelProps) {
  const [form] = Form.useForm<FxValues>()
  const initial = (step.data as FxValues | null) ?? { costMethod: 'WEIGHTED_AVERAGE', fxPolicy: 'AUTO_DAILY' }
  return (
    <StepFrame step={step} busy={busy} onSave={() => onSubmit('SAVE', form.getFieldsValue())} onComplete={() => form.submit()}>
      <Form<FxValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        disabled={busy || step.state === 'COMPLETED'}
        initialValues={initial}
        onFinish={values => onSubmit('COMPLETE', values)}
        style={{ maxWidth: 520 }}
      >
        <Form.Item label="成本计价方式" name="costMethod" extra="决定利润里商品成本的算法；开账后调整会影响历史利润，请谨慎选择。">
          <Radio.Group
            options={[
              { value: 'WEIGHTED_AVERAGE', label: '加权平均' },
              { value: 'FIFO', label: '先进先出' },
            ]}
          />
        </Form.Item>
        <Form.Item label="汇率策略" name="fxPolicy" extra="汇率每日自动抓取，以美元为基准。">
          <Radio.Group
            options={[
              { value: 'AUTO_DAILY', label: '仅自动抓取' },
              { value: 'AUTO_WITH_MANUAL_OVERRIDE', label: '自动抓取，允许手工覆盖（需再次验证身份）' },
            ]}
          />
        </Form.Item>
      </Form>
    </StepFrame>
  )
}
