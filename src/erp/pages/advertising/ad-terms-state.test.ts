import { describe, expect, it } from 'vitest'
import { buildTermQuadrantOption, buildTermTrendOption } from './ad-terms-options'
import { initialState, parseView, requestOf, sortFieldsOf, switchTab, type TermsState } from './ad-terms-state'

// 词级中心的筛选状态与图表配置（纯函数，P3-10）。

const base = (patch: Partial<TermsState> = {}): TermsState => ({ ...initialState('search-terms'), ...patch })

describe('请求参数', () => {
  it('每个页签只带适用的筛选', () => {
    const state = base({ q: 'yoga', anomaly: 'SCALE_UP', status: 'TARGETED', level: 'CAMPAIGN', matchType: 'EXACT', subject: 'targets' })
    expect(requestOf({ ...state, tab: 'search-terms' })).toEqual({ path: '/ads/terms', params: { tab: 'search-terms', q: 'yoga', anomaly: 'SCALE_UP', status: 'TARGETED', sort: 'spend:desc' } })
    expect(requestOf({ ...state, tab: 'targets' }).params).toEqual({ tab: 'targets', q: 'yoga', anomaly: 'SCALE_UP', matchType: 'EXACT', sort: 'spend:desc' })
    expect(requestOf({ ...state, tab: 'negatives', sort: 'term', dir: 'asc' }).params).toEqual({ tab: 'negatives', q: 'yoga', level: 'CAMPAIGN', matchType: 'EXACT', sort: 'term:asc' })
    expect(requestOf({ ...state, tab: 'quadrant' }).params).toEqual({ tab: 'quadrant', q: 'yoga', anomaly: 'SCALE_UP', subject: 'targets' })
    expect(requestOf({ ...state, tab: 'roots' })).toEqual({ path: '/ads/terms/roots', params: { q: 'yoga', sort: 'spend:desc' } })
  })
})

describe('切换页签', () => {
  it('保留关键字，只保留适用的异常分组，丢掉其余筛选，排序回到默认', () => {
    const state = base({ q: 'yoga', anomaly: 'ADD_KEYWORD', status: 'NEGATED', sort: 'clicks', dir: 'asc' })
    const targets = switchTab(state, 'targets')
    expect(targets).toMatchObject({ tab: 'targets', q: 'yoga', sort: 'spend', dir: 'desc' })
    expect(targets.anomaly).toBeUndefined()
    expect(targets.status).toBeUndefined()
    expect(switchTab(base({ anomaly: 'SCALE_UP' }), 'quadrant').anomaly).toBe('SCALE_UP')
    expect(switchTab(base({ anomaly: 'SCALE_UP' }), 'roots').anomaly).toBeUndefined()
    expect(switchTab(base({ anomaly: 'SCALE_UP' }), 'negatives')).toMatchObject({ sort: 'term', dir: 'asc' })
  })

  it('每个页签可选的排序：否定词库只有词，四象限没有，词根多两项', () => {
    expect(sortFieldsOf('negatives')).toEqual(['term'])
    expect(sortFieldsOf('quadrant')).toEqual([])
    expect(sortFieldsOf('roots')).toEqual(expect.arrayContaining(['terms', 'stores', 'spend']))
    expect(sortFieldsOf('targets')).not.toContain('terms')
  })
})

describe('保存视图的还原', () => {
  it('合法字段还原，认不出的丢弃，页签不适用的筛选丢掉', () => {
    const view = parseView({ tab: 'negatives', level: 'AD_GROUP', matchType: ' EXACT ', sort: 'term', dir: 'desc', status: 'TARGETED', anomaly: 'SCALE_UP', junk: 1 })
    expect(view).toMatchObject({ tab: 'negatives', level: 'AD_GROUP', matchType: 'EXACT', sort: 'term', dir: 'desc' })
    expect(view?.status).toBeUndefined()
    expect(view?.anomaly).toBeUndefined()
  })

  it('页签认不出或不是对象：不还原', () => {
    expect(parseView(null)).toBeNull()
    expect(parseView('x')).toBeNull()
    expect(parseView({ tab: 'nope' })).toBeNull()
  })

  it('排序字段不属于该页签：用默认排序', () => {
    expect(parseView({ tab: 'negatives', sort: 'spend', dir: 'asc' })).toMatchObject({ sort: 'term', dir: 'asc' })
    expect(parseView({ tab: 'search-terms', sort: 'bogus' })).toMatchObject({ sort: 'spend', dir: 'desc' })
  })

  it('搜索词页签保留状态筛选', () => {
    expect(parseView({ tab: 'search-terms', status: 'NEGATED', anomaly: 'NEGATIVE_CANDIDATE', q: 'mat' })).toMatchObject({ status: 'NEGATED', anomaly: 'NEGATIVE_CANDIDATE', q: 'mat' })
  })
})

describe('图表配置', () => {
  it('四象限：每个点带象限与分界线；没有分界线时不画线', () => {
    const option = buildTermQuadrantOption({
      points: [{ key: 'a', name: 'a', spend: 10, sales: 40, orders: 2, acos: 0.25, quadrant: 'STAR' }],
      spendLine: 5,
      acosLine: 0.3,
    })
    const series = (option.series as Array<{ data: unknown[]; markLine: { data: unknown[] } }>)[0]!
    expect(series.data).toHaveLength(1)
    expect(series.markLine.data).toEqual([{ xAxis: 5 }, { yAxis: 0.3 }])
    const none = buildTermQuadrantOption({ points: [], spendLine: null, acosLine: null })
    expect((none.series as Array<{ markLine: { data: unknown[] } }>)[0]!.markLine.data).toEqual([])
  })

  it('趋势：没有数据的日期保持为空，不补 0', () => {
    const option = buildTermTrendOption([
      { date: '2026-10-20', impressions: 10, clicks: 2, spend: 3, sales: 9, orders: 1 },
      { date: '2026-10-21', impressions: null, clicks: null, spend: null, sales: null, orders: null },
    ])
    const series = option.series as Array<{ name: string; data: Array<number | null> }>
    expect(series.find(item => item.name === '花费')?.data).toEqual([3, null])
    expect(series.find(item => item.name === '广告销售额')?.data).toEqual([9, null])
  })
})
