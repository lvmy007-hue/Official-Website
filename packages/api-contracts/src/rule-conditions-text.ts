import { RULE_AGG_LABEL, RULE_OP_LABEL, resolveThresholdUnit, type ConditionGroups, type RuleCompare, type RuleCondition, type RuleMetricCatalog, type ConditionWindow } from './rule-conditions.js'

// 规则描述生成器（P6-07）：把条件翻成一句人话，例如
// “近 7 天 ACoS 平均值 > 35%，且近 7 天 广告销售额 合计 环比下降超过 20%”。
// 规则编辑页右侧实时显示，规则列表的“条件摘要”也用它，所以只放纯函数。

/** 窗口的中文名：近 7 天、今日、昨日、本月累计、上月。 */
export function describeWindow(window: ConditionWindow): string {
  switch (window.kind) {
    case 'today':
      return '今日'
    case 'yesterday':
      return '昨日'
    case 'days':
      return `近 ${window.days ?? '?'} 天`
    case 'month_to_date':
      return '本月累计'
    case 'last_month':
      return '上月'
    case 'previous_period':
      return '环比'
    case 'same_period_last_year':
      return '同比'
  }
}

/** 数字去掉多余的小数（浮点误差与结尾的 0），最多保留 4 位小数。 */
export const formatThreshold = (value: number): string => String(Number(value.toFixed(4)))

const isRelative = (compare: RuleCompare) => compare.window.kind === 'previous_period' || compare.window.kind === 'same_period_last_year'

/** 对比的说法：“环比”“同比”或“较近 30 天平均值”；聚合方式与本期不同时写明对比期用的聚合。 */
function compareBase(condition: RuleCondition, compare: RuleCompare): string {
  const aggText = RULE_AGG_LABEL[compare.agg]
  if (isRelative(compare)) return compare.agg === condition.agg ? describeWindow(compare.window) : `${describeWindow(compare.window)}（对比期${aggText}）`
  return `较${describeWindow(compare.window)}${aggText}`
}

function describeCompare(condition: RuleCondition, compare: RuleCompare, unitText: string): string {
  const base = compareBase(condition, compare)
  const { op, threshold } = condition
  const amount = `${formatThreshold(Math.abs(threshold))}${unitText}`
  // 方向清楚的写成“下降超过 20%”，方向与符号对不上（例如“下降超过 -5%”）时老老实实写比较符
  if ((op === '<' || op === '<=') && threshold < 0) return `${base}${compare.mode === 'pct' ? '下降' : '减少'}${op === '<' ? '超过' : '至少'} ${amount}`
  if ((op === '>' || op === '>=') && threshold > 0) return `${base}${compare.mode === 'pct' ? '上升' : '增加'}${op === '>' ? '超过' : '至少'} ${amount}`
  return `${base}变化 ${RULE_OP_LABEL[op]} ${formatThreshold(threshold)}${unitText}`
}

/** 一条条件的中文描述；指标不在目录里时写出编号，不编造名称。 */
export function describeRuleCondition(condition: RuleCondition, catalog: RuleMetricCatalog): string {
  const metric = catalog.get(condition.metric)
  const name = metric?.name ?? condition.metric
  const head = `${describeWindow(condition.window)} ${name} ${RULE_AGG_LABEL[condition.agg]}`
  const unit = metric ? resolveThresholdUnit(condition, metric) : (condition.unit ?? 'abs')
  const unitText = unit === '%' ? (condition.compare?.mode === 'abs' ? ' 个百分点' : '%') : metric?.unit === 'days' ? ' 天' : ''
  if (condition.compare) return `${head} ${describeCompare(condition, condition.compare, unitText)}`
  return `${head} ${RULE_OP_LABEL[condition.op]} ${formatThreshold(condition.threshold)}${unitText}`
}

export const EMPTY_CONDITIONS_TEXT = '尚未设置条件'

/** 整份条件的中文描述：组内用“，且”连接，多组时每组加括号并用“或”连接。 */
export function describeConditions(value: ConditionGroups, catalog: RuleMetricCatalog): string {
  const groups = (value.groups ?? []).map(group => (group.conditions ?? []).map(condition => describeRuleCondition(condition, catalog)).join('，且')).filter(text => text !== '')
  if (groups.length === 0) return EMPTY_CONDITIONS_TEXT
  if (groups.length === 1) return groups[0]!
  return groups.map(text => `（${text}）`).join('或')
}
