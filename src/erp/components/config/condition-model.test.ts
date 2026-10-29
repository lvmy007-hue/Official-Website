import { describe, expect, it } from 'vitest'
import { buildRuleCatalog, validateConditions, type ConditionGroups, type RuleCondition, type RuleMetric } from '@nova/api-contracts'
import { addCondition, addGroup, aggOptions, changeCompare, changeMetric, changeWindowKind, cloneConditions, compareChoiceOf, newCondition, removeCondition, updateCondition } from './condition-model'

// 条件构造器的纯逻辑（P6-07）：换指标时修正聚合方式、窗口与对比的切换、增删条件与组。

const ACOS: RuleMetric = { id: 'M-501', name: 'ACoS', domain: 'ads', unit: 'percent', aggs: ['avg', 'last', 'min', 'max'] }
const SPEND: RuleMetric = { id: 'M-007', name: '广告花费', domain: 'ads', unit: 'money', aggs: ['sum', 'avg', 'min', 'max'] }
const STOCK: RuleMetric = { id: 'M-200', name: '可售总量', domain: 'inventory', unit: 'count', aggs: ['last', 'min', 'max'] }
const CATALOG = buildRuleCatalog([ACOS, SPEND, STOCK])

describe('新建与换指标', () => {
  it('新条件：近 7 天、有平均值就用平均值、没有就取第一个允许的聚合；新建出来一定合法', () => {
    expect(newCondition(ACOS)).toEqual({ metric: 'M-501', window: { kind: 'days', days: 7 }, agg: 'avg', op: '>', threshold: 0 })
    expect(newCondition(STOCK).agg).toBe('last')
    for (const metric of [ACOS, SPEND, STOCK]) expect(validateConditions({ groups: [{ conditions: [newCondition(metric)] }] }, CATALOG)).toEqual([])
  })

  it('换指标：聚合方式不被新指标支持时改成平均值或第一个选项，对比的聚合同理；写死的单位作废', () => {
    const condition: RuleCondition = { ...newCondition(SPEND), agg: 'sum', unit: 'abs', compare: { window: { kind: 'previous_period' }, agg: 'sum', mode: 'pct' } }
    const next = changeMetric(condition, ACOS)
    expect(next).toMatchObject({ metric: 'M-501', agg: 'avg', compare: { agg: 'avg' } })
    expect(next.unit).toBeUndefined()
    expect(changeMetric({ ...condition, agg: 'sum' }, STOCK)).toMatchObject({ agg: 'last', compare: { agg: 'last' } })
    expect(changeMetric({ ...condition, agg: 'avg' }, STOCK).agg).toBe('last')
    expect(changeMetric({ ...newCondition(ACOS), agg: 'max' }, SPEND).agg).toBe('max')
  })
})

describe('窗口与对比', () => {
  it('窗口换种类：近 N 天带天数（保留原来的），其余去掉天数', () => {
    expect(changeWindowKind({ kind: 'today' }, 'days')).toEqual({ kind: 'days', days: 7 })
    expect(changeWindowKind({ kind: 'days', days: 30 }, 'days')).toEqual({ kind: 'days', days: 30 })
    expect(changeWindowKind({ kind: 'days', days: 30 }, 'last_month')).toEqual({ kind: 'last_month' })
  })

  it('对比方式：不对比去掉整个对比；环比同比自带窗口；与其他窗口比默认近 7 天；切换时保留计算方式', () => {
    const base = newCondition(SPEND)
    expect(compareChoiceOf(undefined)).toBe('none')
    const mom = changeCompare({ ...base, unit: '%' }, 'previous_period')
    expect(mom.compare).toEqual({ window: { kind: 'previous_period' }, agg: 'avg', mode: 'pct' })
    expect(mom.unit).toBeUndefined()
    expect(compareChoiceOf(mom.compare)).toBe('previous_period')
    const abs = { ...mom, compare: { ...mom.compare!, mode: 'abs' as const } }
    expect(changeCompare(abs, 'same_period_last_year').compare).toMatchObject({ window: { kind: 'same_period_last_year' }, mode: 'abs' })
    const other = changeCompare(abs, 'other')
    expect(other.compare!.window).toEqual({ kind: 'days', days: 7 })
    expect(compareChoiceOf(other.compare)).toBe('other')
    expect(changeCompare({ ...other, compare: { ...other.compare!, window: { kind: 'days', days: 30 } } }, 'other').compare!.window).toEqual({ kind: 'days', days: 30 })
    expect(changeCompare(other, 'none')).not.toHaveProperty('compare')
  })

  it('聚合下拉只含指标允许的方式，顺序固定', () => {
    expect(aggOptions(ACOS.aggs).map(option => option.label)).toEqual(['平均值', '最新值', '最小值', '最大值'])
    expect(aggOptions([])).toEqual([])
  })
})

describe('增删条件与组', () => {
  const a = newCondition(ACOS)
  const b = newCondition(SPEND)
  const value: ConditionGroups = { groups: [{ conditions: [a, b] }, { conditions: [a] }] }

  it('更新、追加条件、追加组都返回新对象，不改原数据', () => {
    const snapshot = JSON.stringify(value)
    const changed = updateCondition(value, 0, 1, { ...b, threshold: 9 })
    expect(changed.groups[0]!.conditions[1]!.threshold).toBe(9)
    expect(addCondition(value, 1, b).groups[1]!.conditions).toHaveLength(2)
    expect(addGroup(value, b).groups).toHaveLength(3)
    expect(JSON.stringify(value)).toBe(snapshot)
  })

  it('删除条件：组里还有别的条件就只去这一条；删光了整组一起去掉，不留空组', () => {
    expect(removeCondition(value, 0, 0).groups[0]!.conditions).toEqual([b])
    expect(removeCondition(value, 1, 0).groups).toHaveLength(1)
    expect(removeCondition({ groups: [{ conditions: [a] }] }, 0, 0)).toEqual({ groups: [] })
  })

  it('复制是深拷贝', () => {
    const copy = cloneConditions(value)
    copy.groups[0]!.conditions[0]!.threshold = 99
    expect(value.groups[0]!.conditions[0]!.threshold).toBe(0)
  })
})
