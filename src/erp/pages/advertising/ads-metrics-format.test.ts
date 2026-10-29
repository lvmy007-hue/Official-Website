import { describe, expect, it } from 'vitest'
import { chartOption, metricText, planChart } from './ads-metrics-format'
import { initialState, paramsOf, sortStillValid, withDataset } from './ads-metrics-state'
import { campaignRows, dailyRows, dayRow } from './ads-metrics-fixtures.test-helper'

// 广告指标页的纯函数：指标显示（空值不是 0）、图表规划（折线按时间、对比最多 5 条、空值断开）、筛选状态。

describe('指标显示', () => {
  it('空值写“—”，0 写 0；金额、百分比、比值、计数各用自己的格式', () => {
    expect(metricText('spend', null)).toBe('—')
    expect(metricText('spend', undefined)).toBe('—')
    expect(metricText('spend', 0)).toBe('$0.00')
    expect(metricText('spend', 1234.5)).toBe('$1,234.50')
    expect(metricText('acos', 0.3)).toBe('30.00%')
    expect(metricText('roas', 2.5)).toBe('2.50')
    expect(metricText('clicks', 1280)).toBe('1,280')
  })
})

describe('图表规划', () => {
  it('有日期维度：按日期画折线，缺值保持为空（不补 0）', () => {
    const plan = planChart(dailyRows(), ['date'], 'spend', [])
    expect(plan).toEqual({ kind: 'line', time: 'date', categories: ['2026-09-07', '2026-09-08', '2026-09-14'], series: [{ name: '合计', data: [6, 3, null] }] })
  })

  it('日期加活动：每个活动一条线；超过 5 条只取合计最大的 5 条，空值排最后', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((name, index) => [
      { key: `d1|${name}`, dims: { date: '2026-09-07', campaign: name }, values: { spend: index === 5 ? null : (index + 1) * 10 }, link: null },
      { key: `d2|${name}`, dims: { date: '2026-09-08', campaign: name }, values: { spend: index === 5 ? null : (index + 1) * 10 }, link: null },
    ])
    const plan = planChart(rows, ['date', 'campaign'], 'spend', [])
    expect(plan?.kind).toBe('line')
    if (plan?.kind !== 'line') return
    expect(plan.series.map(item => item.name)).toEqual(['E', 'D', 'C', 'B', 'A'])
    expect(plan.series[0]!.data).toEqual([50, 50])
  })

  it('没有时间维度：条形图；选中的行优先（最多 5 行），没选取前 10 行', () => {
    expect(planChart(campaignRows(), ['campaign'], 'spend', [])).toEqual({ kind: 'bar', categories: ['春季活动', 'C2'], data: [9, 1] })
    expect(planChart(campaignRows(), ['campaign'], 'spend', ['C2'])).toEqual({ kind: 'bar', categories: ['C2'], data: [1] })
    const many = Array.from({ length: 12 }, (_, index) => ({ key: `k${index}`, dims: { campaign: `c${index}` }, values: { spend: index }, link: null }))
    expect((planChart(many, ['campaign'], 'spend', []) as { categories: string[] }).categories).toHaveLength(10)
  })

  it('没有行不画图；图表配置里系列名用指标名称、数据保持空值', () => {
    expect(planChart([], ['date'], 'spend', [])).toBeNull()
    const plan = planChart([dayRow('2026-09-07', { spend: 1 }), dayRow('2026-09-08', { spend: null })], ['date'], 'spend', [])!
    const option = chartOption(plan, 'spend') as { series: Array<{ name: string; data: unknown[] }> }
    expect(option.series[0]).toMatchObject({ name: '花费', data: [1, null] })
  })
})

describe('筛选状态', () => {
  it('默认是活动日指标按日；换数据集回到该数据集的默认维度与指标，保留档案筛选，去掉不适用的产品筛选', () => {
    const base = { ...initialState(), adsProfileId: 'ap-a', adProduct: 'SPONSORED_BRANDS' as const }
    expect(paramsOf(base)).toMatchObject({ dataset: 'CAMPAIGN', dims: 'date', metrics: 'spend,sales,acos', grain: 'day', adProduct: 'SPONSORED_BRANDS', adsProfileId: 'ap-a' })
    const next = withDataset(base, 'PLACEMENT')
    expect(next).toMatchObject({ dataset: 'PLACEMENT', dims: ['placement'], adsProfileId: 'ap-a', adProduct: undefined })
    expect(paramsOf(next).adProduct).toBeUndefined()
    expect(paramsOf(next).grain).toBeUndefined()
  })

  it('不分组写 dims=none；取消选择正在排序的指标后排序失效', () => {
    expect(paramsOf({ ...initialState(), dims: [] }).dims).toBe('none')
    const state = { ...initialState(), sortField: 'acos' as const }
    expect(sortStillValid(state)).toBe(true)
    expect(sortStillValid({ ...state, metrics: ['spend'] })).toBe(false)
    expect(sortStillValid({ ...state, sortField: 'key' })).toBe(true)
  })
})
