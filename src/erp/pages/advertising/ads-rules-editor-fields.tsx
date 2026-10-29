import { useState } from 'react'
import { Button, Form, Input, InputNumber, Radio, Select, Space } from 'antd'
import {
  ADS_RULE_ACTION_LABEL,
  ADS_RULE_ADJUST_MODES,
  ADS_RULE_FILTER_FIELD_LABEL,
  ADS_RULE_FILTER_FIELDS,
  ADS_RULE_FILTER_MODE_LABEL,
  ADS_RULE_FILTER_MODES,
  ADS_RULE_KEYWORD_MATCH_LABEL,
  ADS_RULE_KEYWORD_MATCHES,
  ADS_RULE_LEVEL_ACTIONS,
  ADS_RULE_LIMITS,
  ADS_RULE_METRIC_INFO,
  ADS_RULE_METRICS,
  ADS_RULE_NEGATE_MATCH_LABEL,
  ADS_RULE_NEGATE_MATCHES,
  ADS_RULE_OP_LABEL,
  ADS_RULE_OPS,
  ADS_RULE_WINDOWS,
  type AdsCampaignListResponse,
  type AdsRuleActionType,
  type AdsRuleLevel,
  type AdsRuleMetric,
  type AdsRuleRow,
} from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'

// 自动规则表单的字段组（P3-13）：条件（可多条，全部满足才命中）、对象文本过滤、限定的活动、动作、护栏。

const UNIT_SUFFIX: Record<string, string> = { money: '美元', percent: '%', times: '倍', count: '' }

function ConditionRow({ name, remove }: { name: number; remove: () => void }) {
  const metric = Form.useWatch(['conditions', name, 'metric']) as AdsRuleMetric | undefined
  const unit = metric ? ADS_RULE_METRIC_INFO[metric].unit : 'count'
  return (
    <Space align="start" wrap style={{ display: 'flex', marginBottom: 4 }}>
      <Form.Item name={[name, 'windowDays']} rules={[{ required: true, message: '选窗口' }]} style={{ marginBottom: 0 }}>
        <Select aria-label="时间窗口" style={{ width: 100 }} options={ADS_RULE_WINDOWS.map(value => ({ value, label: `近 ${value} 天` }))} />
      </Form.Item>
      <Form.Item name={[name, 'metric']} rules={[{ required: true, message: '选指标' }]} style={{ marginBottom: 0 }}>
        <Select aria-label="指标" style={{ width: 170 }} options={ADS_RULE_METRICS.map(value => ({ value, label: ADS_RULE_METRIC_INFO[value].label }))} />
      </Form.Item>
      <Form.Item name={[name, 'op']} rules={[{ required: true, message: '选比较方式' }]} style={{ marginBottom: 0 }}>
        <Select aria-label="比较方式" style={{ width: 130 }} options={ADS_RULE_OPS.map(value => ({ value, label: ADS_RULE_OP_LABEL[value] }))} />
      </Form.Item>
      <Form.Item name={[name, 'value']} rules={[{ required: true, type: 'number', message: '填写阈值' }]} style={{ marginBottom: 0 }}>
        <InputNumber aria-label="阈值" min={0} step={unit === 'money' ? 0.5 : 1} addonAfter={UNIT_SUFFIX[unit] || undefined} style={{ width: 150 }} />
      </Form.Item>
      <Button type="link" onClick={remove}>
        删除条件
      </Button>
    </Space>
  )
}

export function ConditionsField() {
  return (
    <Form.Item label={`条件（全部满足才命中，最多 ${ADS_RULE_LIMITS.conditionsMax} 条）`} required>
      <Form.List name="conditions">
        {(fields, { add, remove }) => (
          <>
            {fields.map(field => (
              <ConditionRow key={field.key} name={field.name} remove={() => remove(field.name)} />
            ))}
            <Button disabled={fields.length >= ADS_RULE_LIMITS.conditionsMax} onClick={() => add({ metric: 'acos', windowDays: 7, op: 'gt' })}>
              添加条件
            </Button>
          </>
        )}
      </Form.List>
    </Form.Item>
  )
}

export function FiltersField() {
  return (
    <Form.Item label={`对象文本过滤（可不填，全部满足，最多 ${ADS_RULE_LIMITS.filtersMax} 条）`}>
      <Form.List name="textFilters">
        {(fields, { add, remove }) => (
          <>
            {fields.map(field => (
              <Space key={field.key} align="start" wrap style={{ display: 'flex', marginBottom: 4 }}>
                <Form.Item name={[field.name, 'field']} style={{ marginBottom: 0 }}>
                  <Select aria-label="过滤对象" style={{ width: 150 }} options={ADS_RULE_FILTER_FIELDS.map(value => ({ value, label: ADS_RULE_FILTER_FIELD_LABEL[value] }))} />
                </Form.Item>
                <Form.Item name={[field.name, 'mode']} style={{ marginBottom: 0 }}>
                  <Select aria-label="过滤方式" style={{ width: 110 }} options={ADS_RULE_FILTER_MODES.map(value => ({ value, label: ADS_RULE_FILTER_MODE_LABEL[value] }))} />
                </Form.Item>
                <Form.Item name={[field.name, 'text']} rules={[{ required: true, whitespace: true, message: '填写文字' }]} style={{ marginBottom: 0 }}>
                  <Input aria-label="过滤文字" maxLength={ADS_RULE_LIMITS.filterTextMax} style={{ width: 200 }} />
                </Form.Item>
                <Button type="link" onClick={() => remove(field.name)}>
                  删除过滤
                </Button>
              </Space>
            ))}
            <Button disabled={fields.length >= ADS_RULE_LIMITS.filtersMax} onClick={() => add({ field: 'NAME', mode: 'CONTAINS' })}>
              添加过滤
            </Button>
          </>
        )}
      </Form.List>
    </Form.Item>
  )
}

export function CampaignsField({ rule }: { rule?: AdsRuleRow }) {
  const profileId = Form.useWatch('adsProfileId') as string | undefined
  const [q, setQ] = useState('')
  const query = useApiQuery<AdsCampaignListResponse>({
    domain: 'analytics',
    path: '/ads/campaigns',
    params: { q: q || undefined, pageSize: 200, sort: 'name:asc' },
    scoped: false,
    enabled: Boolean(profileId),
  })
  const loaded = (query.data?.items ?? []).filter(item => item.adsProfileId === profileId).map(item => ({ value: item.id, label: item.name }))
  // 已选中的活动即使不在当前搜索结果里也要保留（没有名称就显示编号）
  const selected = (rule?.spec.campaignIds ?? []).map(id => ({ value: id, label: id }))
  const options = new Map<string, string>([...selected.map(item => [item.value, item.label] as const), ...loaded.map(item => [item.value, item.label] as const)])
  return (
    <Form.Item name="campaignIds" label={`限定的活动（不选就是这个广告账户下的全部活动，最多 ${ADS_RULE_LIMITS.campaignsMax} 个）`} extra="只列出所选广告账户下的活动；输入名称可搜索更多">
      <Select
        mode="multiple"
        showSearch
        loading={query.isFetching}
        placeholder={profileId ? '搜索并选择活动，可不选' : '先选择广告账户'}
        filterOption={false}
        onSearch={setQ}
        options={[...options.entries()].map(([value, label]) => ({ value, label }))}
      />
    </Form.Item>
  )
}

const AMOUNT_NOUN: Record<string, string> = { ADJUST_BID: '竞价', ADJUST_BUDGET: '日预算' }

export function ActionFields({ fixedLevel }: { fixedLevel?: AdsRuleLevel }) {
  const watchedLevel = Form.useWatch('level') as AdsRuleLevel | undefined
  const level = fixedLevel ?? watchedLevel ?? 'CAMPAIGN'
  const type = (Form.useWatch('actionType') as AdsRuleActionType | undefined) ?? ADS_RULE_LEVEL_ACTIONS[level][0]!
  const adjusting = type === 'ADJUST_BID' || type === 'ADJUST_BUDGET'
  const bounded = adjusting || type === 'ADD_KEYWORD'
  const mode = Form.useWatch('adjustMode') as string | undefined
  return (
    <>
      <Form.Item name="actionType" label="动作（命中后建议做什么）" rules={[{ required: true, message: '请选择动作' }]}>
        <Select aria-label="动作" options={ADS_RULE_LEVEL_ACTIONS[level].map(value => ({ value, label: ADS_RULE_ACTION_LABEL[value] }))} />
      </Form.Item>
      {adjusting ? (
        <Space align="start" wrap>
          <Form.Item name="adjustMode" label="调整方式">
            <Radio.Group options={ADS_RULE_ADJUST_MODES.map(value => ({ value, label: value === 'PERCENT' ? '按百分比' : '按金额' }))} />
          </Form.Item>
          <Form.Item
            name="adjustValue"
            label={`${AMOUNT_NOUN[type]}调整幅度（正数提高，负数降低）`}
            rules={[
              { required: true, type: 'number', message: '填写调整幅度' },
              { type: 'number', validator: async (_rule, value: number | undefined) => (value === 0 ? Promise.reject(new Error('调整幅度不能是 0')) : Promise.resolve()) },
            ]}
          >
            <InputNumber aria-label="调整幅度" step={mode === 'AMOUNT' ? 0.1 : 5} addonAfter={mode === 'AMOUNT' ? '美元' : '%'} style={{ width: 160 }} />
          </Form.Item>
        </Space>
      ) : null}
      {type === 'NEGATE' ? (
        <Form.Item name="negateMatch" label="否定方式">
          <Radio.Group options={ADS_RULE_NEGATE_MATCHES.map(value => ({ value, label: ADS_RULE_NEGATE_MATCH_LABEL[value] }))} />
        </Form.Item>
      ) : null}
      {type === 'ADD_KEYWORD' ? (
        <Space align="start" wrap>
          <Form.Item name="keywordMatch" label="匹配方式">
            <Radio.Group options={ADS_RULE_KEYWORD_MATCHES.map(value => ({ value, label: ADS_RULE_KEYWORD_MATCH_LABEL[value] }))} />
          </Form.Item>
          <Form.Item name="keywordBid" label="新关键词出价（美元）" rules={[{ required: true, type: 'number', message: '填写出价' }]}>
            <InputNumber aria-label="新关键词出价" min={ADS_RULE_LIMITS.valueFloor} step={0.05} precision={2} style={{ width: 140 }} />
          </Form.Item>
        </Space>
      ) : null}
      <Space align="start" wrap>
        {bounded ? (
          <>
            <Form.Item name="minValue" label="最低值（美元，可不填）">
              <InputNumber aria-label="最低值" min={ADS_RULE_LIMITS.valueFloor} step={0.05} precision={2} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="maxValue" label="最高值（美元，可不填）">
              <InputNumber aria-label="最高值" min={ADS_RULE_LIMITS.valueFloor} step={0.05} precision={2} style={{ width: 140 }} />
            </Form.Item>
          </>
        ) : null}
        {adjusting ? (
          <Form.Item name="maxChangePercent" label="单次调整幅度上限（%，必填）" rules={[{ required: true, type: 'number', message: '调整竞价或预算必须设置幅度上限' }]}>
            <InputNumber aria-label="单次调整幅度上限" min={1} max={100} precision={0} style={{ width: 160 }} />
          </Form.Item>
        ) : null}
        <Form.Item name="dailyLimit" label="每日最多处理对象数" rules={[{ required: true, type: 'number', message: '填写每日上限' }]} extra="24 小时内超出的对象按近 30 天花费从高到低取舍">
          <InputNumber aria-label="每日最多处理对象数" min={1} max={ADS_RULE_LIMITS.dailyLimitMax} precision={0} style={{ width: 160 }} />
        </Form.Item>
      </Space>
    </>
  )
}
