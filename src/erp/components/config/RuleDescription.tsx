import { useMemo } from 'react'
import { EMPTY_CONDITIONS_TEXT, buildRuleCatalog, describeConditions, validateConditions, type ConditionGroups, type RuleMetric } from '@nova/api-contracts'

// 规则描述（P6-07）：条件一改，这里立刻换成一句人话；规则编辑页右侧、规则列表的“条件摘要”都用这套文字。
// 文字由契约里的 describeConditions 生成，和后端日志、通知里的描述同源，不要在页面里另拼。

export interface RuleDescriptionProps {
  value: ConditionGroups
  metrics: readonly RuleMetric[]
  title?: string
}

export function RuleDescription({ value, metrics, title = '规则描述' }: RuleDescriptionProps) {
  const catalog = useMemo(() => buildRuleCatalog(metrics), [metrics])
  const text = describeConditions(value, catalog)
  const problems = value.groups.length === 0 ? 0 : validateConditions(value, catalog).length
  return (
    <section className="erp-rule-desc" aria-label={title}>
      <h4 className="erp-rule-desc-title">{title}</h4>
      <p className="erp-rule-desc-text" data-testid="rule-description" aria-live="polite">
        {text === EMPTY_CONDITIONS_TEXT ? <span className="erp-rule-desc-empty">{text}</span> : `当${text}时触发。`}
      </p>
      {problems > 0 ? <p className="erp-rule-desc-warn">还有 {problems} 处条件需要修改，改完才能保存。</p> : null}
    </section>
  )
}
