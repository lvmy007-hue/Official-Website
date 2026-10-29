import {
  RULE_AGGS,
  RULE_AGG_LABEL,
  RULE_OPS,
  RULE_OP_LABEL,
  type ConditionGroups,
  type ConditionWindow,
  type RuleAgg,
  type RuleCompare,
  type RuleCondition,
  type RuleMetric,
} from '@nova/api-contracts'

// 条件构造器的纯逻辑（P6-07）：新建条件、换指标时修正聚合方式、对比方式与下拉选项。界面只调这里，不自己拼条件。

export const WINDOW_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: 'yesterday', label: '昨日' },
  { value: 'days', label: '近 N 天' },
  { value: 'month_to_date', label: '本月累计' },
  { value: 'last_month', label: '上月' },
] as const

/** 对比方式：不对比、环比、同比，或与另一个窗口比。 */
export const COMPARE_OPTIONS = [
  { value: 'none', label: '不对比' },
  { value: 'previous_period', label: '环比（上一期）' },
  { value: 'same_period_last_year', label: '同比（去年同期）' },
  { value: 'other', label: '与其他窗口比' },
] as const
export type CompareChoice = (typeof COMPARE_OPTIONS)[number]['value']

export const COMPARE_MODE_OPTIONS = [
  { value: 'pct', label: '百分比变化' },
  { value: 'abs', label: '差值' },
] as const

export const OP_OPTIONS = RULE_OPS.map(op => ({ value: op, label: RULE_OP_LABEL[op] }))
export const aggOptions = (aggs: readonly RuleAgg[]) => RULE_AGGS.filter(agg => aggs.includes(agg)).map(agg => ({ value: agg, label: RULE_AGG_LABEL[agg] }))

export const DEFAULT_WINDOW_DAYS = 7

export function newCondition(metric: RuleMetric): RuleCondition {
  const agg: RuleAgg = metric.aggs.includes('avg') ? 'avg' : (metric.aggs[0] ?? 'avg')
  return { metric: metric.id, window: { kind: 'days', days: DEFAULT_WINDOW_DAYS }, agg, op: '>', threshold: 0 }
}

/** 换指标：聚合方式不被新指标支持时改成它的第一个选项，对比的聚合同理；其余设置保留。 */
export function changeMetric(condition: RuleCondition, metric: RuleMetric): RuleCondition {
  const fit = (agg: RuleAgg): RuleAgg => (metric.aggs.includes(agg) ? agg : (metric.aggs.find(item => item === 'avg') ?? metric.aggs[0] ?? agg))
  const next: RuleCondition = { ...condition, metric: metric.id, agg: fit(condition.agg) }
  if (condition.compare) next.compare = { ...condition.compare, agg: fit(condition.compare.agg) }
  delete next.unit
  return next
}

/** 窗口换种类：只有“近 N 天”带天数，其余去掉天数。 */
export function changeWindowKind(window: ConditionWindow, kind: ConditionWindow['kind']): ConditionWindow {
  return kind === 'days' ? { kind, days: window.days ?? DEFAULT_WINDOW_DAYS } : { kind }
}

export function compareChoiceOf(compare: RuleCompare | undefined): CompareChoice {
  if (!compare) return 'none'
  return compare.window.kind === 'previous_period' || compare.window.kind === 'same_period_last_year' ? compare.window.kind : 'other'
}

/** 选对比方式：切换时尽量保留已填的聚合与计算方式；对比后阈值多半从“绝对值”变成“变化量”，所以不动阈值，由使用者改。 */
export function changeCompare(condition: RuleCondition, choice: CompareChoice): RuleCondition {
  const { compare: previous, ...rest } = condition
  delete rest.unit // 对比前后阈值单位可能不同，写死的单位作废，由校验按指标与对比方式重新推出
  if (choice === 'none') return rest
  const window: ConditionWindow = choice === 'other' ? (previous && compareChoiceOf(previous) === 'other' ? previous.window : { kind: 'days', days: DEFAULT_WINDOW_DAYS }) : { kind: choice }
  return { ...rest, compare: { window, agg: previous?.agg ?? condition.agg, mode: previous?.mode ?? 'pct' } }
}

export const cloneConditions = (value: ConditionGroups): ConditionGroups => JSON.parse(JSON.stringify(value)) as ConditionGroups

export function updateCondition(value: ConditionGroups, groupIndex: number, conditionIndex: number, next: RuleCondition): ConditionGroups {
  return { groups: value.groups.map((group, gi) => (gi === groupIndex ? { conditions: group.conditions.map((item, ci) => (ci === conditionIndex ? next : item)) } : group)) }
}

/** 删除一条条件；组里没有条件了就把整组去掉（不留空组）。 */
export function removeCondition(value: ConditionGroups, groupIndex: number, conditionIndex: number): ConditionGroups {
  return {
    groups: value.groups.flatMap((group, gi) => {
      if (gi !== groupIndex) return [group]
      const conditions = group.conditions.filter((_, ci) => ci !== conditionIndex)
      return conditions.length === 0 ? [] : [{ conditions }]
    }),
  }
}

export const addCondition = (value: ConditionGroups, groupIndex: number, condition: RuleCondition): ConditionGroups => ({
  groups: value.groups.map((group, gi) => (gi === groupIndex ? { conditions: [...group.conditions, condition] } : group)),
})

export const addGroup = (value: ConditionGroups, condition: RuleCondition): ConditionGroups => ({ groups: [...value.groups, { conditions: [condition] }] })
