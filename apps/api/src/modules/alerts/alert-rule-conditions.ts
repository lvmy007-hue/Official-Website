import { METRIC_DEFINITIONS, RULE_SUPPORTED_METRICS, buildRuleCatalog, ruleMetricsOf, unsupportedRuleMetrics, validateConditions, type ConditionGroups, type RuleCondition } from '@nova/api-contracts'
import { appError } from '../../platform/http'

// 自定义指标规则的条件校验（P6-16）：规则保存与试算共用。指标必须在口径字典里标记为“可用于规则”，并且已经接入取数层；
// 其余的窗口、聚合、阈值范围由 P6-07 的 validateConditions 逐条检查。通过后只保留已知字段（请求里多余的键不入库）。

export const RULE_CATALOG = buildRuleCatalog(ruleMetricsOf(METRIC_DEFINITIONS))

/** 只留下条件里的已知字段。 */
function pick(condition: RuleCondition): RuleCondition {
  const picked: RuleCondition = {
    metric: condition.metric,
    window: condition.window.kind === 'days' ? { kind: 'days', days: condition.window.days } : { kind: condition.window.kind },
    agg: condition.agg,
    op: condition.op,
    threshold: condition.threshold,
  }
  if (condition.compare) {
    picked.compare = {
      window: condition.compare.window.kind === 'days' ? { kind: 'days', days: condition.compare.window.days } : { kind: condition.compare.window.kind },
      agg: condition.compare.agg,
      mode: condition.compare.mode,
    }
  }
  if (condition.unit !== undefined) picked.unit = condition.unit
  return picked
}

export function checkConditionGroups(raw: unknown): ConditionGroups {
  const groups = raw as ConditionGroups
  const issues = validateConditions(groups, RULE_CATALOG)
  if (issues.length > 0) {
    throw appError('VALIDATION_FAILED', '规则条件有误', {
      fieldErrors: {
        conditionGroups: issues.map(issue =>
          issue.groupIndex === undefined ? issue.message : `第 ${issue.groupIndex + 1} 组${issue.conditionIndex === undefined ? '' : `第 ${issue.conditionIndex + 1} 条`}：${issue.message}`,
        ),
      },
    })
  }
  const unsupported = unsupportedRuleMetrics(groups)
  if (unsupported.length > 0) {
    throw appError('VALIDATION_FAILED', '规则条件有误', {
      fieldErrors: { conditionGroups: [`指标 ${unsupported.join('、')} 暂时取不到数，目前可选：${RULE_SUPPORTED_METRICS.join('、')}`] },
    })
  }
  return { groups: groups.groups.map(group => ({ conditions: group.conditions.map(pick) })) }
}
