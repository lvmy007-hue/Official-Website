import { conditionQueries, type ConditionGroups, type ConditionQuery, type RuleCondition, type RuleOp } from './rule-conditions.js'

// 条件判断（P6-07）：给定指标取值，判断是否触发。前端“试算预览”和 worker 用同一份代码，保证两边结论一致。
// 取数由调用方负责（`ConditionValues`），这里不碰数据库；调用方先用 `requiredQueries` 一次取全，再逐条判断，不要在循环里打数据库。

/** 取值函数：返回 null 或 undefined 表示这个窗口还没有数据（不是 0）。 */
export type ConditionValues = (query: ConditionQuery) => number | null | undefined

/** 没有触发的原因之一：缺数据，或对比基数为零（百分比无法计算）。 */
export type ConditionMissing = 'no-data' | 'no-compare-data' | 'zero-base'

export interface ConditionResult {
  triggered: boolean
  /** 参与比较的值：直接比较时是本期值，对比时是差值或百分比变化；算不出来是 null */
  value: number | null
  current: number | null
  previous: number | null
  missing: ConditionMissing | null
}

export interface GroupResult {
  triggered: boolean
  conditions: ConditionResult[]
}

export interface ConditionEvaluation {
  /** 任一组全部条件都触发就算触发 */
  triggered: boolean
  groups: GroupResult[]
}

/** 浮点比较的容差：相等与不等按它判断，避免 0.1 + 0.2 之类的误差。 */
export const COMPARE_EPSILON = 1e-9

export function compareValues(value: number, op: RuleOp, threshold: number): boolean {
  switch (op) {
    case '>':
      return value > threshold
    case '>=':
      return value >= threshold
    case '<':
      return value < threshold
    case '<=':
      return value <= threshold
    case '=':
      return Math.abs(value - threshold) < COMPARE_EPSILON
    case '!=':
      return Math.abs(value - threshold) >= COMPARE_EPSILON
  }
}

const finite = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const notTriggered = (over: Partial<ConditionResult>): ConditionResult => ({ triggered: false, value: null, current: null, previous: null, missing: null, ...over })

export function evaluateCondition(condition: RuleCondition, values: ConditionValues): ConditionResult {
  const { current: currentQuery, previous: previousQuery } = conditionQueries(condition)
  const current = finite(values(currentQuery))
  if (current === null) return notTriggered({ missing: 'no-data' })
  if (!condition.compare || !previousQuery) return { triggered: compareValues(current, condition.op, condition.threshold), value: current, current, previous: null, missing: null }
  const previous = finite(values(previousQuery))
  if (previous === null) return notTriggered({ current, missing: 'no-compare-data' })
  if (condition.compare.mode === 'abs') {
    const delta = current - previous
    return { triggered: compareValues(delta, condition.op, condition.threshold), value: delta, current, previous, missing: null }
  }
  // 对比期为零，百分比没有意义（不拿 0 或无穷去比），按缺数据处理
  if (previous === 0) return notTriggered({ current, previous, missing: 'zero-base' })
  const change = ((current - previous) / Math.abs(previous)) * 100
  return { triggered: compareValues(change, condition.op, condition.threshold), value: change, current, previous, missing: null }
}

/** 判断整份条件：组内全部条件都触发该组才触发（空组不触发），任一组触发整体触发；缺数据的条件不触发，也不会被当成 0。 */
export function evaluateConditions(value: ConditionGroups, values: ConditionValues): ConditionEvaluation {
  const groups = value.groups.map<GroupResult>(group => {
    const conditions = group.conditions.map(condition => evaluateCondition(condition, values))
    return { triggered: conditions.length > 0 && conditions.every(item => item.triggered), conditions }
  })
  return { triggered: groups.some(group => group.triggered), groups }
}
