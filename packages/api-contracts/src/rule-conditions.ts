// 规则条件（P6-07，15 章 5.5、16 章第 9 节）：预警规则、调价规则、自动规则共用的“指标条件”数据结构与校验。
// 本文件只放类型、常量与纯函数，**不引入 zod**，前端与 worker 都从这里取；中文描述在 rule-conditions-text.ts，判断在 rule-conditions-eval.ts。
//
// 取数约定（前端预览与 worker 判断必须一致，所以写在这里）：
//   - 百分比类指标（`unit = 'percent'`）一律用“百分数”表示，35 就是 35%，阈值同理；供数方负责把 0.35 换成 35。
//   - `days` 窗口是“截至昨日的最近 N 个完整日”（不含今日，今日数据还没走完，拿去比较会误报）；
//     `today` 与 `yesterday` 是单日；`month_to_date` 是本月 1 日到昨日；`last_month` 是上一个自然月。
//   - 缺数据就是缺数据（供数方返回 null），**不会当成 0**，缺数据的条件不触发。

export const RULE_DOMAINS = ['sales', 'ads', 'inventory', 'profit', 'aftersales'] as const
export type RuleDomain = (typeof RULE_DOMAINS)[number]
export const RULE_DOMAIN_LABEL: Readonly<Record<RuleDomain, string>> = { sales: '销售', ads: '广告', inventory: '库存', profit: '利润', aftersales: '售后' }

/** 指标的值怎么读：金额、百分比（百分数）、件数或次数、天数、倍数（如广告投入产出比）。 */
export const RULE_UNITS = ['money', 'percent', 'count', 'days', 'ratio'] as const
export type RuleUnit = (typeof RULE_UNITS)[number]

export const RULE_AGGS = ['sum', 'avg', 'last', 'min', 'max'] as const
export type RuleAgg = (typeof RULE_AGGS)[number]
export const RULE_AGG_LABEL: Readonly<Record<RuleAgg, string>> = { sum: '合计', avg: '平均值', last: '最新值', min: '最小值', max: '最大值' }

export const RULE_OPS = ['>', '>=', '<', '<=', '=', '!='] as const
export type RuleOp = (typeof RULE_OPS)[number]
export const RULE_OP_LABEL: Readonly<Record<RuleOp, string>> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', '=': '=', '!=': '≠' }

/** 统计窗口；`previous_period` 与 `same_period_last_year` 只能用作对比窗口（相对于主窗口）。 */
export const RULE_WINDOW_KINDS = ['today', 'yesterday', 'days', 'month_to_date', 'last_month'] as const
export const RULE_RELATIVE_WINDOW_KINDS = ['previous_period', 'same_period_last_year'] as const
export type RuleWindowKind = (typeof RULE_WINDOW_KINDS)[number] | (typeof RULE_RELATIVE_WINDOW_KINDS)[number]
export interface ConditionWindow {
  kind: RuleWindowKind
  /** 仅 `days` 用：1 到 365 的整数 */
  days?: number
}

export interface RuleCompare {
  window: ConditionWindow
  agg: RuleAgg
  /** `pct`：（本期 − 对比期）÷ |对比期| × 100；`abs`：本期 − 对比期 */
  mode: 'abs' | 'pct'
}

export interface RuleCondition {
  /** 指标编号（口径字典里的 M-xxx，且标记为“可用于规则”） */
  metric: string
  window: ConditionWindow
  agg: RuleAgg
  compare?: RuleCompare
  op: RuleOp
  threshold: number
  /** 阈值的单位；省略时按指标与对比方式推出（见 `resolveThresholdUnit`），写了就必须一致 */
  unit?: '%' | 'abs'
}

/** 组内“且”，组与组之间“或”。 */
export interface ConditionGroups {
  groups: Array<{ conditions: RuleCondition[] }>
}

/** 一个可用于规则的指标（来自口径字典的 `ruleUse` 标记）。 */
export interface RuleMetric {
  id: string
  name: string
  domain: RuleDomain
  unit: RuleUnit
  /** 允许的聚合方式；比率类指标不能求和 */
  aggs: readonly RuleAgg[]
}
/** 口径字典里的“可用于规则”标记（metrics.md 10.8）；null 表示不能用于规则。 */
export type RuleUse = Pick<RuleMetric, 'domain' | 'unit' | 'aggs'>
export type RuleMetricCatalog = ReadonlyMap<string, RuleMetric>

/** 从口径字典条目取出可用于规则的指标；没有标记的条目丢掉。 */
export function ruleMetricsOf(definitions: ReadonlyArray<{ id: string; name: string; ruleUse?: RuleUse | null }>): RuleMetric[] {
  return definitions.flatMap(item => (item.ruleUse ? [{ id: item.id, name: item.name, ...item.ruleUse }] : []))
}

export const buildRuleCatalog = (metrics: readonly RuleMetric[]): RuleMetricCatalog => new Map(metrics.map(metric => [metric.id, metric]))

/** 规则模板：系统模板随产品发布，自定义模板由企业自己存（两类在界面上分开显示）。 */
export interface RuleTemplate {
  id: string
  name: string
  /** 模板分组，如“广告效率”“库存风险” */
  group: string
  source: 'SYSTEM' | 'CUSTOM'
  /** 适用维度，如“广告活动”“商品”“店铺” */
  dimension: string
  conditions: ConditionGroups
}

export const RULE_MAX_GROUPS = 5
export const RULE_MAX_CONDITIONS_PER_GROUP = 10
export const RULE_WINDOW_DAYS_MAX = 365
export const RULE_THRESHOLD_MAX = 1_000_000_000
export const RULE_PERCENT_THRESHOLD_MAX = 1_000_000

export type ConditionIssueField = 'groups' | 'metric' | 'window' | 'agg' | 'compare' | 'op' | 'threshold' | 'unit'
export interface ConditionIssue {
  /** 第几组、第几条（从 0 开始）；整体问题两者都省略，空组只有 groupIndex */
  groupIndex?: number
  conditionIndex?: number
  field: ConditionIssueField
  message: string
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)

/** 阈值的单位：百分比对比固定是 %；直接比较百分比类指标也是 %；其余是绝对值。 */
export function resolveThresholdUnit(condition: Pick<RuleCondition, 'compare'>, metric: Pick<RuleMetric, 'unit'>): '%' | 'abs' {
  if (condition.compare) return condition.compare.mode === 'pct' ? '%' : metric.unit === 'percent' ? '%' : 'abs'
  return metric.unit === 'percent' ? '%' : 'abs'
}

function windowIssue(window: ConditionWindow | undefined, allowRelative: boolean): string | null {
  if (!window || typeof window !== 'object') return '没有选择统计窗口'
  const allowed: readonly string[] = allowRelative ? [...RULE_WINDOW_KINDS, ...RULE_RELATIVE_WINDOW_KINDS] : RULE_WINDOW_KINDS
  if (!allowed.includes(window.kind)) return allowRelative ? '统计窗口不合法' : '统计窗口不合法（环比、同比只能用在对比窗口）'
  if (window.kind === 'days') {
    const days = window.days
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > RULE_WINDOW_DAYS_MAX) return `天数要在 1 到 ${RULE_WINDOW_DAYS_MAX} 之间的整数`
  } else if (window.days !== undefined) {
    return '只有“近 N 天”需要天数'
  }
  return null
}

/** 校验一份条件：指标是否存在且可用于规则、聚合方式、窗口、对比、阈值范围；返回全部问题，空数组表示合法。 */
export function validateConditions(value: ConditionGroups | null | undefined, catalog: RuleMetricCatalog): ConditionIssue[] {
  const issues: ConditionIssue[] = []
  const groups = value?.groups
  if (!Array.isArray(groups) || groups.length === 0) return [{ field: 'groups', message: '至少要有一个条件组' }]
  if (groups.length > RULE_MAX_GROUPS) issues.push({ field: 'groups', message: `条件组最多 ${RULE_MAX_GROUPS} 个` })
  groups.forEach((group, groupIndex) => {
    const conditions = group?.conditions
    if (!Array.isArray(conditions) || conditions.length === 0) {
      issues.push({ groupIndex, field: 'groups', message: `第 ${groupIndex + 1} 组没有条件` })
      return
    }
    if (conditions.length > RULE_MAX_CONDITIONS_PER_GROUP) issues.push({ groupIndex, field: 'groups', message: `每组条件最多 ${RULE_MAX_CONDITIONS_PER_GROUP} 条` })
    conditions.forEach((condition, conditionIndex) => {
      const add = (field: ConditionIssueField, message: string) => issues.push({ groupIndex, conditionIndex, field, message })
      const metric = catalog.get(condition?.metric)
      if (!metric) {
        add('metric', condition?.metric ? `指标 ${condition.metric} 不存在或不能用于规则` : '没有选择指标')
        return
      }
      if (!isOneOf(RULE_AGGS, condition.agg) || !metric.aggs.includes(condition.agg)) add('agg', `${metric.name}不支持这种聚合方式`)
      const mainIssue = windowIssue(condition.window, false)
      if (mainIssue) add('window', mainIssue)
      if (condition.compare) {
        const compare = condition.compare
        const compareIssue = windowIssue(compare.window, true)
        if (compareIssue) add('compare', `对比：${compareIssue}`)
        else if (!isOneOf(RULE_AGGS, compare.agg) || !metric.aggs.includes(compare.agg)) add('compare', `对比：${metric.name}不支持这种聚合方式`)
        if (compare.mode !== 'abs' && compare.mode !== 'pct') add('compare', '对比方式要选“差值”或“百分比”')
      }
      if (!isOneOf(RULE_OPS, condition.op)) add('op', '比较符不合法')
      const unit = resolveThresholdUnit(condition, metric)
      if (condition.unit !== undefined && condition.unit !== unit) add('unit', `这条条件的阈值单位应为 ${unit === '%' ? '%' : '绝对值'}`)
      if (typeof condition.threshold !== 'number' || !Number.isFinite(condition.threshold)) add('threshold', '阈值要填数字')
      else if (Math.abs(condition.threshold) > (unit === '%' ? RULE_PERCENT_THRESHOLD_MAX : RULE_THRESHOLD_MAX)) add('threshold', '阈值超出允许范围')
    })
  })
  return issues
}

/** 一条查询：“哪个指标、什么窗口、怎么聚合”；对比窗口是相对窗口时带上基准窗口 `base`。 */
export interface ConditionQuery {
  metric: string
  window: ConditionWindow
  agg: RuleAgg
  base?: ConditionWindow
}

const windowKey = (window: ConditionWindow) => (window.kind === 'days' ? `days:${window.days}` : window.kind)
export const queryKey = (query: ConditionQuery) => `${query.metric}|${windowKey(query.window)}|${query.agg}|${query.base ? windowKey(query.base) : ''}`

/** 一条条件需要取的数：当前值，加上对比值（如果有）。 */
export function conditionQueries(condition: RuleCondition): { current: ConditionQuery; previous: ConditionQuery | null } {
  const current: ConditionQuery = { metric: condition.metric, window: condition.window, agg: condition.agg }
  if (!condition.compare) return { current, previous: null }
  const relative = (RULE_RELATIVE_WINDOW_KINDS as readonly string[]).includes(condition.compare.window.kind)
  return { current, previous: { metric: condition.metric, window: condition.compare.window, agg: condition.compare.agg, ...(relative ? { base: condition.window } : {}) } }
}

/** 一份条件要取的全部不重复的数：worker 一次批量取回，不要一条条件打一次数据库。 */
export function requiredQueries(value: ConditionGroups): ConditionQuery[] {
  const byKey = new Map<string, ConditionQuery>()
  for (const group of value.groups) {
    for (const condition of group.conditions) {
      const { current, previous } = conditionQueries(condition)
      byKey.set(queryKey(current), current)
      if (previous) byKey.set(queryKey(previous), previous)
    }
  }
  return [...byKey.values()]
}
