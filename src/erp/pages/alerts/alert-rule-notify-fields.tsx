import { useState } from 'react'
import { Alert, Button, Form, InputNumber, Select, Space } from 'antd'
import {
  ALERT_ESCALATION_MAX_LEVELS,
  ALERT_ESCALATION_MAX_MINUTES,
  ALERT_ESCALATION_MIN_MINUTES,
  ALERT_ESCALATION_TARGET_LABEL,
  ALERT_NOTIFY_FREQUENCIES,
  ALERT_NOTIFY_FREQUENCY_LABEL,
  RULE_SUPPORTED_METRICS,
  validateConditions,
  type AlertEscalationLevel,
  type AlertNotifyFrequency,
  type AlertRulePreviewResponse,
  type AlertRuleView,
  type ConditionGroups,
} from '@nova/api-contracts'
import { ConditionBuilder } from '../../components/config/ConditionBuilder'
import { useRuleMetrics } from '../../components/config/use-rule-metrics'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'

// 规则配置里的通知设置与指标条件（P6-16）：通知频率、多级升级（三级，逐级通知待办负责人、规则的通知对象、预警管理员）、自定义指标规则的条件构造器与“试算最近 7 天”。
// 条件构造器用 P6-07 的 ConditionBuilder；可选指标 = 口径字典里“可用于规则”的指标 ∩ 已接入取数层的指标（服务端保存时同样会拒绝没接入的指标）。

const levelField = (index: number) => `escalation${index + 1}`

export const DEFAULT_FREQUENCY: AlertNotifyFrequency = 'IMMEDIATE'
export const EMPTY_CONDITIONS: ConditionGroups = { groups: [] }

/** 表单里通知设置的初始值。 */
export function notifyInitialValues(rule: Pick<AlertRuleView, 'notifyFrequency' | 'escalation' | 'conditionGroups'>): Record<string, unknown> {
  const values: Record<string, unknown> = { notifyFrequency: rule.notifyFrequency, conditionGroups: rule.conditionGroups ?? EMPTY_CONDITIONS }
  for (let index = 0; index < ALERT_ESCALATION_MAX_LEVELS; index += 1) values[levelField(index)] = rule.escalation[index]?.afterMinutes ?? null
  return values
}

/** 把表单里三个时限拼成升级设置：留空的级别不要，前面空着后面填的按顺序顶上（服务端要求越来越长）。 */
export function escalationBody(values: Record<string, unknown>): AlertEscalationLevel[] {
  const levels: AlertEscalationLevel[] = []
  for (let index = 0; index < ALERT_ESCALATION_MAX_LEVELS; index += 1) {
    const value = values[levelField(index)]
    if (typeof value === 'number') levels.push({ afterMinutes: value })
  }
  return levels
}

export const notifyBody = (values: Record<string, unknown>) => ({ notifyFrequency: values.notifyFrequency ?? DEFAULT_FREQUENCY, escalation: escalationBody(values) })

export function NotifyFields() {
  return (
    <>
      <Form.Item
        label="通知频率"
        name="notifyFrequency"
        extra="汇总时一条通知列出 N 个对象，并链接到预警中心的筛选结果；严重级别的预警不受影响，始终立即通知。静默时段内产生的预警，会在静默结束后补发一条汇总。"
      >
        <Select aria-label="通知频率" style={{ width: 200 }} options={ALERT_NOTIFY_FREQUENCIES.map(value => ({ value, label: ALERT_NOTIFY_FREQUENCY_LABEL[value] }))} />
      </Form.Item>
      <Form.Item
        label="多级升级（预警一直没人确认时）"
        extra={`从预警首次触发起算，仍是“新预警”就按时限逐级通知，时限要越来越长（${ALERT_ESCALATION_MIN_MINUTES} 到 ${ALERT_ESCALATION_MAX_MINUTES} 分钟）；留空不升级。升级通知按“严重”级别发送，不受个人免打扰限制。`}
      >
        <Space direction="vertical" size={6}>
          {ALERT_ESCALATION_TARGET_LABEL.map((target, index) => (
            <Space key={target} size={8}>
              <span style={{ width: 150, display: 'inline-block' }}>
                第 {index + 1} 级：通知{target}，超过
              </span>
              <Form.Item name={levelField(index)} noStyle>
                <InputNumber
                  aria-label={`第 ${index + 1} 级时限（分钟）`}
                  min={ALERT_ESCALATION_MIN_MINUTES}
                  max={ALERT_ESCALATION_MAX_MINUTES}
                  precision={0}
                  addonAfter="分钟"
                  style={{ width: 170 }}
                  placeholder="不设置"
                />
              </Form.Item>
            </Space>
          ))}
        </Space>
      </Form.Item>
    </>
  )
}

/** 作为 Form.Item 的受控控件：指标清单取自口径字典，只留下已接入取数层的指标。 */
function ConditionControl({ value, onChange }: { value?: ConditionGroups; onChange?: (next: ConditionGroups) => void }) {
  const { metrics, isLoading, isError } = useRuleMetrics()
  const usable = metrics.filter(metric => RULE_SUPPORTED_METRICS.includes(metric.id))
  if (isError) return <Alert type="error" showIcon message="指标清单读取失败，请刷新页面重试" />
  if (isLoading) return <Muted>正在读取可用指标…</Muted>
  return <ConditionBuilder value={value ?? EMPTY_CONDITIONS} onChange={next => onChange?.(next)} metrics={usable} />
}

/** 自定义指标规则的条件区：条件构造器加“试算最近 7 天”。 */
export function ConditionFields({ scope }: { scope: () => Record<string, unknown> }) {
  const form = Form.useFormInstance()
  const [result, setResult] = useState<AlertRulePreviewResponse | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const { catalog } = useRuleMetrics()
  const preview = useApiMutation<Record<string, unknown>, AlertRulePreviewResponse>({ method: 'POST', path: '/alerts/rules/preview', silent: true })
  const run = async () => {
    const groups = (form.getFieldValue('conditionGroups') ?? EMPTY_CONDITIONS) as ConditionGroups
    setResult(null)
    setFailure(null)
    const issues = validateConditions(groups, catalog)
    if (issues.length > 0) return setFailure(issues[0].message)
    try {
      setResult(await preview.mutateAsync({ conditionGroups: groups, scope: scope() }))
    } catch (error) {
      const info = describeError(error)
      setFailure(info.fieldErrors?.conditionGroups?.[0] ?? info.message)
    }
  }
  return (
    <>
      <Form.Item
        label="触发条件"
        name="conditionGroups"
        extra="按店铺逐个判断：组内条件同时满足，组与组之间满足任一组即触发。统计窗口以企业时区的“今天”为准，近 N 天指截至昨日的最近 N 个完整日；缺数据的条件不触发，不当作 0。"
      >
        <ConditionControl />
      </Form.Item>
      <Form.Item label="试算" extra="用最近 7 天的数据，把这份条件按每天各判断一遍，看会触发多少个店铺（最多判断 100 个店铺，超过 8 秒会提示超时）。">
        <Button onClick={() => void run()} loading={preview.isPending}>
          试算最近 7 天
        </Button>
        {failure ? <Alert style={{ marginTop: 8 }} type="warning" showIcon message={failure} /> : null}
        {result ? (
          <Alert
            style={{ marginTop: 8 }}
            type={result.triggeredStores > 0 ? 'info' : 'success'}
            showIcon
            data-testid="preview-result"
            message={`最近 ${result.days} 天里有 ${result.triggeredStores} 个店铺会触发（共判断 ${result.evaluatedStores} 个店铺）`}
            description={
              <div>
                <div>{result.perDay.map(item => `${item.date.slice(5)}：${item.triggered}`).join('；')}</div>
                {result.samples.length > 0 ? <div>触发最多的店铺：{result.samples.map(item => `${item.storeName}（${item.days} 天）`).join('、')}</div> : null}
                {result.noDataStores > 0 ? <div>{result.noDataStores} 个店铺这 7 天没有可用数据（缺数据不触发）。</div> : null}
                {result.truncated ? <div>店铺太多，只判断了前 {result.evaluatedStores} 个。</div> : null}
              </div>
            }
          />
        ) : null}
      </Form.Item>
    </>
  )
}
