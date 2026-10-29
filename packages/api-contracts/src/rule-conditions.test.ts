import { describe, expect, it } from 'vitest'
import {
  METRIC_DEFINITIONS,
  MetricSearchQuerySchema,
  RULE_DOMAINS,
  RULE_MAX_CONDITIONS_PER_GROUP,
  RULE_MAX_GROUPS,
  buildRuleCatalog,
  compareValues,
  conditionQueries,
  describeConditions,
  describeRuleCondition,
  evaluateCondition,
  evaluateConditions,
  queryKey,
  requiredQueries,
  resolveThresholdUnit,
  ruleMetricsOf,
  searchMetrics,
  validateConditions,
  type ConditionGroups,
  type ConditionQuery,
  type RuleCondition,
  type RuleMetric,
} from './index.js'

const METRICS: RuleMetric[] = [
  { id: 'M-501', name: 'ACoS', domain: 'ads', unit: 'percent', aggs: ['avg', 'last', 'min', 'max'] },
  { id: 'M-500', name: '广告销售额', domain: 'ads', unit: 'money', aggs: ['sum', 'avg', 'min', 'max'] },
  { id: 'M-206', name: '我方可售天数', domain: 'inventory', unit: 'days', aggs: ['avg', 'last', 'min', 'max'] },
]
const CATALOG = buildRuleCatalog(METRICS)
const days = (n: number) => ({ kind: 'days' as const, days: n })
const acos = (over: Partial<RuleCondition> = {}): RuleCondition => ({ metric: 'M-501', window: days(7), agg: 'avg', op: '>', threshold: 35, ...over })
const sales = (over: Partial<RuleCondition> = {}): RuleCondition => ({
  metric: 'M-500',
  window: days(7),
  agg: 'sum',
  compare: { window: { kind: 'previous_period' }, agg: 'sum', mode: 'pct' },
  op: '<',
  threshold: -20,
  ...over,
})
const one = (...conditions: RuleCondition[]): ConditionGroups => ({ groups: [{ conditions }] })
const fields = (value: ConditionGroups) => validateConditions(value, CATALOG).map(issue => issue.field)

describe('口径字典里的“可用于规则”标记', () => {
  const usable = ruleMetricsOf(METRIC_DEFINITIONS)

  it('五个域都有指标；登记的指标都在字典里；百分比、天数、倍数与库存存量不能合计', () => {
    expect(new Set(usable.map(metric => metric.domain))).toEqual(new Set(RULE_DOMAINS))
    expect(usable.length).toBe(20)
    for (const metric of usable) {
      expect(metric.aggs.length).toBeGreaterThan(0)
      if (['percent', 'days', 'ratio'].includes(metric.unit) || metric.domain === 'inventory') expect(metric.aggs).not.toContain('sum')
    }
  })

  it('没有登记的指标 ruleUse 是 null；按“可用于规则”过滤只返回登记过的', () => {
    expect(METRIC_DEFINITIONS.every(item => item.ruleUse === null || typeof item.ruleUse.domain === 'string')).toBe(true)
    const query = MetricSearchQuerySchema.parse({ ruleUsable: 'true', pageSize: '100' })
    const found = searchMetrics(query)
    expect(found.total).toBe(usable.length)
    expect(found.items.every(item => item.ruleUse !== null)).toBe(true)
    expect(MetricSearchQuerySchema.safeParse({ ruleUsable: 'false' }).success).toBe(false)
  })

  it('字典里的真实指标能直接过校验与描述', () => {
    const catalog = buildRuleCatalog(usable)
    const value = one({ metric: 'M-501', window: days(7), agg: 'avg', op: '>', threshold: 35 })
    expect(validateConditions(value, catalog)).toEqual([])
    expect(describeConditions(value, catalog)).toBe('近 7 天 广告成本销售比（ACoS） 平均值 > 35%')
  })
})

describe('validateConditions', () => {
  it('合法条件没有问题；对比、多组也合法', () => {
    expect(validateConditions(one(acos()), CATALOG)).toEqual([])
    expect(validateConditions({ groups: [{ conditions: [acos(), sales()] }, { conditions: [acos({ window: { kind: 'yesterday' }, agg: 'last' })] }] }, CATALOG)).toEqual([])
  })

  it('空数据：没有组、空组、空列表都报错，且指出第几组', () => {
    expect(validateConditions({ groups: [] }, CATALOG)).toEqual([{ field: 'groups', message: '至少要有一个条件组' }])
    expect(validateConditions(null, CATALOG)).toHaveLength(1)
    expect(validateConditions({ groups: [{ conditions: [] }] }, CATALOG)).toEqual([{ groupIndex: 0, field: 'groups', message: '第 1 组没有条件' }])
  })

  it('组数与每组条数有上限', () => {
    const many = { groups: Array.from({ length: RULE_MAX_GROUPS + 1 }, () => ({ conditions: [acos()] })) }
    expect(fields(many)).toEqual(['groups'])
    const long = one(...Array.from({ length: RULE_MAX_CONDITIONS_PER_GROUP + 1 }, () => acos()))
    expect(fields(long)).toEqual(['groups'])
  })

  it('指标不存在或没有选：报指标问题，位置带组号与条号', () => {
    const issues = validateConditions({ groups: [{ conditions: [acos(), acos({ metric: 'M-999' }), acos({ metric: '' })] }] }, CATALOG)
    expect(issues.map(issue => [issue.groupIndex, issue.conditionIndex, issue.field])).toEqual([
      [0, 1, 'metric'],
      [0, 2, 'metric'],
    ])
    expect(issues[0]!.message).toContain('M-999')
  })

  it('聚合方式必须是该指标允许的：比率不能合计', () => {
    expect(fields(one(acos({ agg: 'sum' })))).toEqual(['agg'])
    expect(fields(one(sales({ agg: 'last' })))).toEqual(['agg'])
    expect(fields(one(sales({ compare: { window: { kind: 'previous_period' }, agg: 'last', mode: 'pct' } })))).toEqual(['compare'])
  })

  it('窗口：天数 1 到 365 的整数；其他窗口不带天数；环比同比不能当主窗口', () => {
    for (const bad of [0, 366, 1.5, -1, Number.NaN]) expect(fields(one(acos({ window: days(bad) })))).toEqual(['window'])
    expect(fields(one(acos({ window: { kind: 'days' } })))).toEqual(['window'])
    expect(fields(one(acos({ window: { kind: 'today', days: 7 } })))).toEqual(['window'])
    expect(fields(one(acos({ window: { kind: 'previous_period' } })))).toEqual(['window'])
    expect(fields(one(acos({ window: days(1) })))).toEqual([])
    expect(fields(one(acos({ window: days(365) })))).toEqual([])
    expect(fields(one(acos({ window: { kind: 'bogus' as never } })))).toEqual(['window'])
  })

  it('对比窗口可以是环比、同比或另一个普通窗口，窗口与方式不合法时报对比问题', () => {
    expect(fields(one(sales({ compare: { window: { kind: 'same_period_last_year' }, agg: 'sum', mode: 'abs' } })))).toEqual([])
    expect(fields(one(sales({ compare: { window: days(30), agg: 'avg', mode: 'pct' } })))).toEqual([])
    expect(fields(one(sales({ compare: { window: days(0), agg: 'sum', mode: 'pct' } })))).toEqual(['compare'])
    expect(fields(one(sales({ compare: { window: { kind: 'previous_period' }, agg: 'sum', mode: 'ratio' as never } })))).toEqual(['compare'])
  })

  it('比较符、阈值：非数字、无穷、超出范围都拒绝；百分比阈值的范围比绝对值窄', () => {
    expect(fields(one(acos({ op: '=>' as never })))).toEqual(['op'])
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '35' as never, null as never]) expect(fields(one(acos({ threshold: bad })))).toEqual(['threshold'])
    expect(fields(one(sales({ compare: undefined, op: '>', threshold: 2_000_000_000 })))).toEqual(['threshold'])
    expect(fields(one(acos({ threshold: 1_000_001 })))).toEqual(['threshold'])
    expect(fields(one(sales({ compare: undefined, threshold: 1_500_000 })))).toEqual([])
    expect(fields(one(acos({ threshold: 0 })))).toEqual([])
    expect(fields(one(acos({ threshold: -5, op: '<' })))).toEqual([])
  })

  it('阈值单位：省略时自动推出，写了必须与推出的一致', () => {
    expect(resolveThresholdUnit(acos(), METRICS[0]!)).toBe('%')
    expect(resolveThresholdUnit(sales(), METRICS[1]!)).toBe('%')
    expect(resolveThresholdUnit(sales({ compare: { window: { kind: 'previous_period' }, agg: 'sum', mode: 'abs' } }), METRICS[1]!)).toBe('abs')
    expect(resolveThresholdUnit(acos({ compare: { window: { kind: 'previous_period' }, agg: 'avg', mode: 'abs' } }), METRICS[0]!)).toBe('%')
    expect(fields(one(acos({ unit: '%' })))).toEqual([])
    expect(fields(one(acos({ unit: 'abs' })))).toEqual(['unit'])
    expect(fields(one(sales({ unit: '%' })))).toEqual([])
  })

  it('一条条件的多个问题一起返回', () => {
    expect(fields(one(acos({ agg: 'sum', window: days(0), threshold: Number.NaN })))).toEqual(['agg', 'window', 'threshold'])
  })
})

describe('describeConditions', () => {
  it('单条：近 N 天、指标、聚合、比较符、阈值', () => {
    expect(describeConditions(one(acos()), CATALOG)).toBe('近 7 天 ACoS 平均值 > 35%')
    expect(describeConditions(one(acos({ op: '>=', window: { kind: 'yesterday' }, agg: 'last' })), CATALOG)).toBe('昨日 ACoS 最新值 ≥ 35%')
    expect(describeConditions(one(acos({ op: '!=', window: { kind: 'today' }, agg: 'max' })), CATALOG)).toBe('今日 ACoS 最大值 ≠ 35%')
    expect(describeConditions(one(acos({ op: '<=', window: { kind: 'month_to_date' }, agg: 'min', threshold: 12.5 })), CATALOG)).toBe('本月累计 ACoS 最小值 ≤ 12.5%')
    expect(describeConditions(one(acos({ op: '=', window: { kind: 'last_month' }, threshold: 0.1 + 0.2 })), CATALOG)).toBe('上月 ACoS 平均值 = 0.3%')
  })

  it('天数与金额的单位：天数加“天”，金额与件数不加单位', () => {
    expect(describeConditions(one({ metric: 'M-206', window: { kind: 'today' }, agg: 'last', op: '<', threshold: 14 }), CATALOG)).toBe('今日 我方可售天数 最新值 < 14 天')
    expect(describeConditions(one(sales({ compare: undefined, op: '>', threshold: 1000 })), CATALOG)).toBe('近 7 天 广告销售额 合计 > 1000')
  })

  it('对比：环比下降超过、同比上升至少、差值减少、较另一窗口', () => {
    expect(describeConditions(one(sales()), CATALOG)).toBe('近 7 天 广告销售额 合计 环比下降超过 20%')
    expect(describeConditions(one(sales({ op: '<=' })), CATALOG)).toBe('近 7 天 广告销售额 合计 环比下降至少 20%')
    expect(describeConditions(one(sales({ op: '>=', threshold: 30, compare: { window: { kind: 'same_period_last_year' }, agg: 'sum', mode: 'pct' } })), CATALOG)).toBe(
      '近 7 天 广告销售额 合计 同比上升至少 30%',
    )
    expect(describeConditions(one(sales({ threshold: -500, compare: { window: { kind: 'previous_period' }, agg: 'sum', mode: 'abs' } })), CATALOG)).toBe('近 7 天 广告销售额 合计 环比减少超过 500')
    expect(describeConditions(one(sales({ compare: { window: days(30), agg: 'avg', mode: 'pct' } })), CATALOG)).toBe('近 7 天 广告销售额 合计 较近 30 天平均值下降超过 20%')
    expect(describeConditions(one(sales({ compare: { window: { kind: 'previous_period' }, agg: 'avg', mode: 'pct' } })), CATALOG)).toBe('近 7 天 广告销售额 合计 环比（对比期平均值）下降超过 20%')
  })

  it('百分比指标的差值写“个百分点”；方向与符号对不上时写比较符', () => {
    expect(describeConditions(one(acos({ op: '>', threshold: 5, compare: { window: { kind: 'previous_period' }, agg: 'avg', mode: 'abs' } })), CATALOG)).toBe(
      '近 7 天 ACoS 平均值 环比增加超过 5 个百分点',
    )
    expect(describeConditions(one(sales({ op: '<', threshold: 5 })), CATALOG)).toBe('近 7 天 广告销售额 合计 环比变化 < 5%')
    expect(describeConditions(one(sales({ op: '=', threshold: 0 })), CATALOG)).toBe('近 7 天 广告销售额 合计 环比变化 = 0%')
  })

  it('多条用“，且”，多组加括号用“或”；空数据与未知指标不报错', () => {
    expect(describeConditions(one(acos(), sales()), CATALOG)).toBe('近 7 天 ACoS 平均值 > 35%，且近 7 天 广告销售额 合计 环比下降超过 20%')
    expect(describeConditions({ groups: [{ conditions: [acos()] }, { conditions: [sales()] }] }, CATALOG)).toBe('（近 7 天 ACoS 平均值 > 35%）或（近 7 天 广告销售额 合计 环比下降超过 20%）')
    expect(describeConditions({ groups: [] }, CATALOG)).toBe('尚未设置条件')
    expect(describeConditions({ groups: [{ conditions: [] }] }, CATALOG)).toBe('尚未设置条件')
    expect(describeRuleCondition(acos({ metric: 'M-999' }), CATALOG)).toBe('近 7 天 M-999 平均值 > 35')
    expect(describeRuleCondition(acos({ window: { kind: 'days' } }), CATALOG)).toContain('近 ? 天')
  })
})

describe('evaluateConditions', () => {
  const table = (values: Record<string, number | null>) => (query: ConditionQuery) => values[queryKey(query)]
  const cur = (condition: RuleCondition) => queryKey(conditionQueries(condition).current)
  const prev = (condition: RuleCondition) => queryKey(conditionQueries(condition).previous!)

  it('六种比较符：边界值分别判断；相等与不等有浮点容差', () => {
    expect(['>', '>=', '<', '<=', '=', '!='].map(op => compareValues(35, op as never, 35))).toEqual([false, true, false, true, true, false])
    expect(['>', '>=', '<', '<=', '=', '!='].map(op => compareValues(36, op as never, 35))).toEqual([true, true, false, false, false, true])
    expect(['>', '>=', '<', '<=', '=', '!='].map(op => compareValues(34, op as never, 35))).toEqual([false, false, true, true, false, true])
    expect(compareValues(0.1 + 0.2, '=', 0.3)).toBe(true)
    expect(compareValues(0.1 + 0.2, '!=', 0.3)).toBe(false)
  })

  it('直接比较：触发、不触发；缺数据不触发，也不当成 0（“< 5”遇到缺数据不会误报）', () => {
    const condition = acos({ op: '<', threshold: 5 })
    expect(evaluateCondition(acos(), table({ [cur(acos())]: 40 }))).toMatchObject({ triggered: true, value: 40, missing: null })
    expect(evaluateCondition(acos(), table({ [cur(acos())]: 30 })).triggered).toBe(false)
    for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateCondition(condition, table({ [cur(condition)]: missing as never }))).toMatchObject({ triggered: false, value: null, missing: 'no-data' })
    }
    expect(evaluateCondition(condition, () => 0).triggered).toBe(true)
  })

  it('百分比对比：下降超过 20% 触发，正好 20% 不触发（<），<= 触发；上期为负数按绝对值算方向', () => {
    const condition = sales()
    const values = (now: number, before: number) => table({ [cur(condition)]: now, [prev(condition)]: before })
    expect(evaluateCondition(condition, values(70, 100))).toMatchObject({ triggered: true, value: -30, current: 70, previous: 100 })
    expect(evaluateCondition(condition, values(80, 100)).triggered).toBe(false)
    expect(evaluateCondition({ ...condition, op: '<=' }, values(80, 100)).triggered).toBe(true)
    expect(evaluateCondition(condition, values(90, 100)).triggered).toBe(false)
    // 上期 -100、本期 -50：利润变好了 50%
    expect(evaluateCondition({ ...condition, op: '>', threshold: 40 }, values(-50, -100)).value).toBe(50)
  })

  it('差值对比：本期减上期；对比期为零时百分比无法计算，按缺数据处理，差值照常', () => {
    const abs = sales({ compare: { window: { kind: 'previous_period' }, agg: 'sum', mode: 'abs' }, threshold: -50 })
    const values = (now: number | null, before: number | null) => table({ [cur(abs)]: now, [prev(abs)]: before })
    expect(evaluateCondition(abs, values(40, 100))).toMatchObject({ triggered: true, value: -60 })
    expect(evaluateCondition(abs, values(60, 100)).triggered).toBe(false)
    expect(evaluateCondition(abs, values(10, 0))).toMatchObject({ triggered: false, value: 10, missing: null })
    const pct = sales()
    const zero = evaluateCondition(pct, table({ [cur(pct)]: 10, [prev(pct)]: 0 }))
    expect(zero).toMatchObject({ triggered: false, value: null, missing: 'zero-base', current: 10, previous: 0 })
    expect(evaluateCondition(pct, table({ [cur(pct)]: 10, [prev(pct)]: null }))).toMatchObject({ triggered: false, missing: 'no-compare-data', current: 10 })
    expect(evaluateCondition(pct, table({ [cur(pct)]: null, [prev(pct)]: 10 }))).toMatchObject({ triggered: false, missing: 'no-data' })
  })

  it('相对对比窗口把基准窗口一起交给取数方；普通对比窗口不带', () => {
    const seen: ConditionQuery[] = []
    evaluateCondition(sales(), query => (seen.push(query), 1))
    expect(seen).toEqual([
      { metric: 'M-500', window: days(7), agg: 'sum' },
      { metric: 'M-500', window: { kind: 'previous_period' }, agg: 'sum', base: days(7) },
    ])
    const plain = sales({ compare: { window: days(30), agg: 'avg', mode: 'pct' } })
    expect(conditionQueries(plain).previous).toEqual({ metric: 'M-500', window: days(30), agg: 'avg' })
  })

  it('组内“且”、组间“或”；空组不触发；没有组不触发', () => {
    const a = acos()
    const b = sales()
    const values = table({ [cur(a)]: 40, [cur(b)]: 70, [prev(b)]: 100 })
    const both = evaluateConditions(one(a, b), values)
    expect(both.triggered).toBe(true)
    expect(both.groups[0]!.conditions.map(item => item.triggered)).toEqual([true, true])
    const noB = evaluateConditions(one(a, b), table({ [cur(a)]: 40, [cur(b)]: 90, [prev(b)]: 100 }))
    expect(noB).toMatchObject({ triggered: false, groups: [{ triggered: false }] })
    const either = evaluateConditions(
      { groups: [{ conditions: [a, b] }, { conditions: [acos({ window: days(30) })] }] },
      table({ [cur(a)]: 40, [cur(b)]: 90, [prev(b)]: 100, [cur(acos({ window: days(30) }))]: 50 }),
    )
    expect(either.groups.map(group => group.triggered)).toEqual([false, true])
    expect(either.triggered).toBe(true)
    expect(evaluateConditions({ groups: [{ conditions: [] }] }, () => 1).triggered).toBe(false)
    expect(evaluateConditions({ groups: [] }, () => 1)).toEqual({ triggered: false, groups: [] })
  })

  it('requiredQueries：相同的数只取一次，对比期单独一份，窗口天数不同算不同', () => {
    const queries = requiredQueries({ groups: [{ conditions: [acos(), acos({ op: '<', threshold: 5 }), sales()] }, { conditions: [sales(), acos({ window: days(14) })] }] })
    expect(queries.map(queryKey).sort()).toEqual(['M-500|days:7|sum|', 'M-500|previous_period|sum|days:7', 'M-501|days:14|avg|', 'M-501|days:7|avg|'])
  })
})
