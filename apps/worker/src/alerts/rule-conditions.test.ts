import { describe, expect, it } from 'vitest'
import { METRIC_DEFINITIONS, buildRuleCatalog, evaluateConditions, queryKey, requiredQueries, ruleMetricsOf, validateConditions, type ConditionGroups } from '@nova/api-contracts'

// 规则条件（P6-07）：worker 与前端预览共用契约里的同一份校验与判断（15 章 5.5）。
// 本包不接任何业务，这里只证明 worker 取得到、跑得通：校验用口径字典里登记的真实指标，取数一次批量取回，判断结果与前端预览一致。

const CONDITIONS: ConditionGroups = {
  groups: [
    {
      conditions: [
        { metric: 'M-501', window: { kind: 'days', days: 7 }, agg: 'avg', op: '>', threshold: 35 },
        { metric: 'M-500', window: { kind: 'days', days: 7 }, agg: 'sum', compare: { window: { kind: 'previous_period' }, agg: 'sum', mode: 'pct' }, op: '<', threshold: -20 },
      ],
    },
  ],
}

describe('worker 使用规则条件', () => {
  const catalog = buildRuleCatalog(ruleMetricsOf(METRIC_DEFINITIONS))

  it('字典里的真实指标过校验；批量取数只取不重复的三个数', () => {
    expect(validateConditions(CONDITIONS, catalog)).toEqual([])
    expect(requiredQueries(CONDITIONS)).toHaveLength(3)
  })

  it('按取回的数判断：两个条件都满足才触发；缺一个数不触发', () => {
    const fetched = new Map<string, number>()
    for (const query of requiredQueries(CONDITIONS)) fetched.set(queryKey(query), query.metric === 'M-501' ? 40 : query.window.kind === 'previous_period' ? 100 : 70)
    expect(evaluateConditions(CONDITIONS, query => fetched.get(queryKey(query))).triggered).toBe(true)
    const missing = new Map(fetched)
    for (const key of [...missing.keys()].filter(key => key.startsWith('M-500|previous_period'))) missing.delete(key)
    expect(evaluateConditions(CONDITIONS, query => missing.get(queryKey(query))).triggered).toBe(false)
  })
})
