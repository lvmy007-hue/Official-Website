import { Fragment, useMemo } from 'react'
import { Button } from 'antd'
import { RULE_MAX_CONDITIONS_PER_GROUP, RULE_MAX_GROUPS, buildRuleCatalog, validateConditions, type ConditionGroups, type ConditionIssue, type RuleMetric } from '@nova/api-contracts'
import { ConditionRow } from './ConditionRow'
import { RuleDescription } from './RuleDescription'
import { addCondition, addGroup, newCondition, removeCondition, updateCondition } from './condition-model'
import './config.css'

// 条件构造器（P6-07，15 章 5.5）：一条条件 = 指标 + 统计窗口 + 聚合 + 对比（可选）+ 比较符 + 阈值；组内“且”，组与组之间“或”；右侧实时显示规则描述。
// 本组件只管编辑，受控：数据由页面持有（`value`/`onChange`）；指标清单由页面传入（`useRuleMetrics()` 取自口径字典里标记为“可用于规则”的指标）。
// 保存前页面自己再调一次 `validateConditions`，后端也会校验，本组件的提示只是帮使用者尽早发现问题。

export interface ConditionBuilderProps {
  value: ConditionGroups
  onChange: (next: ConditionGroups) => void
  metrics: readonly RuleMetric[]
  disabled?: boolean
  /** 右侧的规则描述；页面自己在别处显示时关掉 */
  showDescription?: boolean
}

const issuesAt = (issues: readonly ConditionIssue[], groupIndex: number, conditionIndex: number) => issues.filter(issue => issue.groupIndex === groupIndex && issue.conditionIndex === conditionIndex)

export function ConditionBuilder({ value, onChange, metrics, disabled, showDescription = true }: ConditionBuilderProps) {
  const catalog = useMemo(() => buildRuleCatalog(metrics), [metrics])
  const issues = useMemo(() => (value.groups.length === 0 ? [] : validateConditions(value, catalog)), [value, catalog])
  const first = metrics[0]
  const wholeIssues = issues.filter(issue => issue.conditionIndex === undefined)
  const canAddGroup = !disabled && first !== undefined && value.groups.length < RULE_MAX_GROUPS
  return (
    <div className="erp-cond-builder">
      <div className="erp-cond-main">
        {first === undefined ? <p className="erp-cond-note">口径字典里还没有可用于规则的指标，暂时不能设置条件。</p> : null}
        {value.groups.length === 0 ? <p className="erp-cond-note">还没有条件。点“添加条件”开始设置。</p> : null}
        {value.groups.map((group, groupIndex) => (
          <Fragment key={groupIndex}>
            {groupIndex > 0 ? (
              <div className="erp-cond-or" aria-hidden="true">
                或
              </div>
            ) : null}
            <section className="erp-cond-group" role="group" aria-label={`条件组 ${groupIndex + 1}`}>
              <header className="erp-cond-group-head">
                <strong>条件组 {groupIndex + 1}</strong>
                <span className="erp-cond-hint">组内条件需要同时满足</span>
                <Button type="link" size="small" danger disabled={disabled} onClick={() => onChange({ groups: value.groups.filter((_, index) => index !== groupIndex) })}>
                  删除本组
                </Button>
              </header>
              {group.conditions.map((condition, conditionIndex) => (
                <Fragment key={conditionIndex}>
                  {conditionIndex > 0 ? <div className="erp-cond-and">且</div> : null}
                  <div role="group" aria-label={`条件 ${conditionIndex + 1}`}>
                    <ConditionRow
                      condition={condition}
                      metrics={metrics}
                      issues={issuesAt(issues, groupIndex, conditionIndex)}
                      disabled={disabled}
                      onChange={next => onChange(updateCondition(value, groupIndex, conditionIndex, next))}
                      onRemove={() => onChange(removeCondition(value, groupIndex, conditionIndex))}
                    />
                  </div>
                </Fragment>
              ))}
              <Button
                type="link"
                size="small"
                disabled={disabled || first === undefined || group.conditions.length >= RULE_MAX_CONDITIONS_PER_GROUP}
                onClick={() => first && onChange(addCondition(value, groupIndex, newCondition(first)))}
              >
                添加条件
              </Button>
            </section>
          </Fragment>
        ))}
        {wholeIssues.length > 0 ? (
          <ul className="erp-cond-issues" role="alert">
            {wholeIssues.map(issue => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        ) : null}
        <div>
          <Button size="small" disabled={!canAddGroup} onClick={() => first && onChange(addGroup(value, newCondition(first)))}>
            {value.groups.length === 0 ? '添加条件' : '添加条件组（或）'}
          </Button>
        </div>
      </div>
      {showDescription ? (
        <aside className="erp-cond-side">
          <RuleDescription value={value} metrics={metrics} />
        </aside>
      ) : null}
    </div>
  )
}
