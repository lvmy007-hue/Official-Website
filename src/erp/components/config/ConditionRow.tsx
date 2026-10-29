import { Button, InputNumber, Select } from 'antd'
import { RULE_DOMAINS, RULE_DOMAIN_LABEL, RULE_WINDOW_DAYS_MAX, resolveThresholdUnit, type ConditionIssue, type ConditionWindow, type RuleCondition, type RuleMetric } from '@nova/api-contracts'
import { COMPARE_MODE_OPTIONS, COMPARE_OPTIONS, OP_OPTIONS, WINDOW_OPTIONS, aggOptions, changeCompare, changeMetric, changeWindowKind, compareChoiceOf } from './condition-model'

// 一条条件（P6-07）：指标（先选域再选指标）、统计窗口、聚合方式、对比、比较符、阈值。窗口与对比都在同一行，放不下自动换行。

export interface ConditionRowProps {
  condition: RuleCondition
  /** 可选指标的全集（已按字典标记筛过） */
  metrics: readonly RuleMetric[]
  /** 这一条的校验问题 */
  issues: readonly ConditionIssue[]
  onChange: (next: RuleCondition) => void
  onRemove: () => void
  disabled?: boolean
}

function WindowControl({ label, window, onChange, disabled }: { label: string; window: ConditionWindow; onChange: (next: ConditionWindow) => void; disabled?: boolean }) {
  return (
    <>
      <Select
        aria-label={label}
        size="small"
        style={{ width: 104 }}
        disabled={disabled}
        value={window.kind}
        options={[...WINDOW_OPTIONS]}
        onChange={kind => onChange(changeWindowKind(window, kind))}
      />
      {window.kind === 'days' ? (
        <InputNumber
          aria-label={`${label}天数`}
          size="small"
          style={{ width: 64 }}
          min={1}
          max={RULE_WINDOW_DAYS_MAX}
          precision={0}
          disabled={disabled}
          value={window.days ?? null}
          onChange={days => onChange({ kind: 'days', ...(typeof days === 'number' ? { days } : {}) })}
        />
      ) : null}
    </>
  )
}

/** 阈值后面的单位文字：百分比指标写 %（差值对比写“个百分点”），天数写“天”，其余不写。 */
export function thresholdUnitText(condition: RuleCondition, metric: RuleMetric | undefined): string {
  if (!metric) return ''
  if (resolveThresholdUnit(condition, metric) === '%') return condition.compare?.mode === 'abs' ? '个百分点' : '%'
  return metric.unit === 'days' ? '天' : ''
}

export function ConditionRow({ condition, metrics, issues, onChange, onRemove, disabled }: ConditionRowProps) {
  const metric = metrics.find(item => item.id === condition.metric)
  const domains = RULE_DOMAINS.filter(domain => metrics.some(item => item.domain === domain))
  const sameDomain = metric ? metrics.filter(item => item.domain === metric.domain) : []
  const compare = condition.compare
  const choice = compareChoiceOf(compare)
  const pick = (id: string) => {
    const next = metrics.find(item => item.id === id)
    if (next) onChange(changeMetric(condition, next))
  }
  const aggs = aggOptions(metric?.aggs ?? [])
  return (
    <div className="erp-cond-row">
      <div className="erp-cond-line">
        <Select
          aria-label="指标域"
          size="small"
          style={{ width: 76 }}
          disabled={disabled}
          value={metric?.domain}
          options={domains.map(domain => ({ value: domain, label: RULE_DOMAIN_LABEL[domain] }))}
          onChange={domain => {
            const first = metrics.find(item => item.domain === domain)
            if (first) onChange(changeMetric(condition, first))
          }}
        />
        <Select
          aria-label="指标"
          size="small"
          showSearch
          optionFilterProp="label"
          style={{ width: 188 }}
          disabled={disabled}
          placeholder="选择指标"
          value={metric?.id}
          options={sameDomain.map(item => ({ value: item.id, label: item.name }))}
          onChange={pick}
        />
        <WindowControl label="统计窗口" window={condition.window} disabled={disabled} onChange={window => onChange({ ...condition, window })} />
        <Select aria-label="聚合方式" size="small" style={{ width: 92 }} disabled={disabled} value={condition.agg} options={aggs} onChange={agg => onChange({ ...condition, agg })} />
        <Select
          aria-label="对比方式"
          size="small"
          style={{ width: 132 }}
          disabled={disabled}
          value={choice}
          options={[...COMPARE_OPTIONS]}
          onChange={next => onChange(changeCompare(condition, next))}
        />
        <Select aria-label="比较符" size="small" style={{ width: 64 }} disabled={disabled} value={condition.op} options={OP_OPTIONS} onChange={op => onChange({ ...condition, op })} />
        <InputNumber
          aria-label="阈值"
          size="small"
          style={{ width: 104 }}
          disabled={disabled}
          value={Number.isFinite(condition.threshold) ? condition.threshold : null}
          onChange={value => onChange({ ...condition, threshold: typeof value === 'number' ? value : Number.NaN })}
        />
        <span className="erp-cond-unit">{thresholdUnitText(condition, metric)}</span>
        <Button type="link" size="small" danger disabled={disabled} onClick={onRemove} aria-label="删除这条条件">
          删除
        </Button>
      </div>
      {compare ? (
        <div className="erp-cond-line erp-cond-compare">
          <span className="erp-cond-hint">对比</span>
          {choice === 'other' ? <WindowControl label="对比窗口" window={compare.window} disabled={disabled} onChange={window => onChange({ ...condition, compare: { ...compare, window } })} /> : null}
          <Select
            aria-label="对比聚合"
            size="small"
            style={{ width: 92 }}
            disabled={disabled}
            value={compare.agg}
            options={aggs}
            onChange={agg => onChange({ ...condition, compare: { ...compare, agg } })}
          />
          <Select
            aria-label="对比计算"
            size="small"
            style={{ width: 112 }}
            disabled={disabled}
            value={compare.mode}
            options={[...COMPARE_MODE_OPTIONS]}
            onChange={mode => onChange({ ...condition, compare: { ...compare, mode } })}
          />
        </div>
      ) : null}
      {issues.length > 0 ? (
        <ul className="erp-cond-issues" role="alert">
          {issues.map(issue => (
            <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
