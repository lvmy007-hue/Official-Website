import { describe, expect, it } from 'vitest'
import { AD_TERM_RULES } from './ad-terms'
import {
  aggregateRoots,
  anomalyAppliesTo,
  buildTermQuadrant,
  compareTermRows,
  lemmaOf,
  summarizeTerms,
  termAdviceOf,
  termAnomaliesOf,
  termFilterIssue,
  termMatches,
  termRowStatus,
  termTokens,
} from './ad-terms-math'
import { AdTermDetailQuerySchema, AdTermListQuerySchema, AdTermRootsQuerySchema } from './ad-terms-query'
import { adsRatios, type AdsTotals } from './ads-overview-math'

const totals = (patch: Partial<AdsTotals> = {}): AdsTotals => ({ impressions: 1000, clicks: 30, spend: 25, sales: 100, orders: 0, ...patch })

describe('词级状态与异常分组', () => {
  it('综合状态：每个活动都否定才算已否定；任一活动投放算已投放；其余未投放', () => {
    expect(termRowStatus({ total: 2, targeted: 0, negated: 2 })).toBe('NEGATED')
    expect(termRowStatus({ total: 2, targeted: 1, negated: 1 })).toBe('TARGETED')
    expect(termRowStatus({ total: 2, targeted: 0, negated: 1 })).toBe('UNTARGETED')
    expect(termRowStatus({ total: 0, targeted: 0, negated: 0 })).toBe('UNTARGETED')
  })

  it('高花费无成交：花费与点击都过线且没有订单；花费为空不判断', () => {
    expect(termAnomaliesOf(totals(), { kind: 'target' })).toEqual(['HIGH_SPEND_NO_ORDER'])
    expect(termAnomaliesOf(totals({ spend: AD_TERM_RULES.MIN_SPEND - 1 }), { kind: 'target' })).toEqual([])
    expect(termAnomaliesOf(totals({ clicks: AD_TERM_RULES.MIN_CLICKS - 1 }), { kind: 'target' })).toEqual([])
    expect(termAnomaliesOf(totals({ spend: null }), { kind: 'target' })).toEqual([])
    expect(termAnomaliesOf(totals({ orders: 1 }), { kind: 'target' })).toEqual([])
  })

  it('可扩量：订单够多且广告成本销售比低', () => {
    expect(termAnomaliesOf(totals({ orders: 3, spend: 20, sales: 100 }), { kind: 'target' })).toEqual(['SCALE_UP'])
    expect(termAnomaliesOf(totals({ orders: 3, spend: 30, sales: 100 }), { kind: 'target' })).toEqual([])
    expect(termAnomaliesOf(totals({ orders: 3, spend: 20, sales: null }), { kind: 'target' })).toEqual([])
    expect(termAnomaliesOf(totals({ orders: 2, spend: 10, sales: 100 }), { kind: 'target' })).toEqual([])
  })

  it('加词与否定候选只对还没投放的搜索词成立', () => {
    const converting = totals({ clicks: 10, orders: 2, spend: 6, sales: 40 })
    expect(termAnomaliesOf(converting, { kind: 'search-term', status: 'UNTARGETED' })).toEqual(['ADD_KEYWORD'])
    expect(termAnomaliesOf(converting, { kind: 'search-term', status: 'TARGETED' })).toEqual([])
    expect(termAnomaliesOf(converting, { kind: 'target' })).toEqual([])
    const wasted = totals({ clicks: 12, orders: 0, spend: 6, sales: 0 })
    expect(termAnomaliesOf(wasted, { kind: 'search-term', status: 'UNTARGETED' })).toEqual(['NEGATIVE_CANDIDATE'])
    expect(termAnomaliesOf(wasted, { kind: 'search-term', status: 'NEGATED' })).toEqual([])
    expect(termAnomaliesOf(totals({ clicks: 12, orders: 0, spend: null, sales: null }), { kind: 'search-term', status: 'UNTARGETED' })).toEqual([])
  })

  it('异常分组适用的页签、筛选与页签的组合', () => {
    expect(anomalyAppliesTo('ADD_KEYWORD', 'search-terms')).toBe(true)
    expect(anomalyAppliesTo('ADD_KEYWORD', 'targets')).toBe(false)
    expect(termFilterIssue('targets', { anomaly: 'NEGATIVE_CANDIDATE' })).toMatch(/不适用/)
    expect(termFilterIssue('targets', { status: 'TARGETED' })).toMatch(/搜索词/)
    expect(termFilterIssue('search-terms', { level: 'CAMPAIGN' })).toMatch(/否定词库/)
    expect(termFilterIssue('search-terms', { matchType: 'EXACT' })).toMatch(/匹配方式/)
    expect(termFilterIssue('targets', { subject: 'targets' })).toMatch(/四象限/)
    expect(termFilterIssue('search-terms', { anomaly: 'ADD_KEYWORD', status: 'UNTARGETED' })).toBeNull()
    expect(termFilterIssue('negatives', { level: 'CAMPAIGN', matchType: 'NEGATIVE_EXACT' })).toBeNull()
  })

  it('合计与异常计数', () => {
    const rows = [
      { totals: totals(), ratios: adsRatios(totals()), anomalies: ['HIGH_SPEND_NO_ORDER'] as const },
      { totals: totals({ spend: null }), ratios: adsRatios(totals({ spend: null })), anomalies: [] as const },
    ]
    const summary = summarizeTerms(rows)
    expect(summary.total).toBe(2)
    expect(summary.totals.clicks).toBe(60)
    expect(summary.totals.spend).toBe(25)
    expect(summary.anomalies.HIGH_SPEND_NO_ORDER).toBe(1)
    expect(summary.anomalies.SCALE_UP).toBe(0)
  })
})

describe('关键字与排序', () => {
  it('不分大小写包含', () => {
    expect(termMatches('Yoga Mat', 'yoga')).toBe(true)
    expect(termMatches('Yoga Mat', 'zzz')).toBe(false)
    expect(termMatches('Yoga Mat', undefined)).toBe(true)
  })

  it('空值永远在最后，并列按词再按键，升降序都稳定', () => {
    const make = (key: string, label: string, spend: number | null) => ({ key, label, totals: totals({ spend }), ratios: adsRatios(totals({ spend })) })
    const rows = [make('a', 'b', null), make('b', 'a', 5), make('c', 'c', 5), make('d', 'd', 9)]
    expect([...rows].sort((x, y) => compareTermRows(x, y, 'spend', 'desc')).map(r => r.key)).toEqual(['d', 'b', 'c', 'a'])
    expect([...rows].sort((x, y) => compareTermRows(x, y, 'spend', 'asc')).map(r => r.key)).toEqual(['b', 'c', 'd', 'a'])
    expect([...rows].sort((x, y) => compareTermRows(x, y, 'term', 'asc')).map(r => r.key)).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('四象限', () => {
  const input = (key: string, spend: number | null, sales: number | null) => ({ key, name: key, totals: totals({ spend, sales, orders: 1 }) })

  it('分界线是平均花费与整体广告成本销售比；没有销售额的词不画、单独计数', () => {
    const result = buildTermQuadrant(
      [input('hi-good', 100, 1000), input('hi-bad', 100, 100), input('lo-good', 10, 100), input('lo-bad', 10, 10), input('nosales', 50, 0), input('nospend', null, 20)],
      10,
    )
    expect(result.total).toBe(4)
    expect(result.spendLine).toBe(55)
    expect(result.acosLine).toBeCloseTo(220 / 1210, 6)
    expect(result.counts).toEqual({ STAR: 1, WASTE: 1, POTENTIAL: 1, LOW: 1 })
    expect(result.withoutSales).toEqual({ terms: 1, spend: 50 })
    expect(result.points.map(point => point.key)).toEqual(['hi-bad', 'hi-good', 'lo-bad', 'lo-good'])
  })

  it('点数超出上限只留花费最高的，计数仍覆盖全部；没有可画的点时线是 null', () => {
    const many = Array.from({ length: 5 }, (_, i) => input(`t${i}`, 10 + i, 100))
    const result = buildTermQuadrant(many, 2)
    expect(result.points).toHaveLength(2)
    expect(result.total).toBe(5)
    expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(5)
    const none = buildTermQuadrant([input('x', 5, 0)], 10)
    expect(none).toMatchObject({ points: [], spendLine: null, acosLine: null, total: 0, withoutSales: { terms: 1, spend: 5 } })
  })
})

describe('词根', () => {
  it('词形还原：不规则复数、常见复数规则、不是复数的 s 结尾词原样保留', () => {
    expect(lemmaOf('mats')).toBe('mat')
    expect(lemmaOf('Candies')).toBe('candy')
    expect(lemmaOf('brushes')).toBe('brush')
    expect(lemmaOf('dresses')).toBe('dress')
    expect(lemmaOf('glass')).toBe('glass')
    expect(lemmaOf('yoga')).toBe('yoga')
    expect(lemmaOf('women')).toBe('woman')
    expect(lemmaOf('bus')).toBe('bus')
    expect(lemmaOf('gas')).toBe('gas')
    expect(lemmaOf('cat')).toBe('cat')
  })

  it('拆词：去单字符、虚词与 ASIN 样式的词，同一词根只算一次', () => {
    expect(termTokens('The Yoga Mats for Women, yoga mat B0ABCDEFGH x')).toEqual([
      { root: 'yoga', form: 'yoga' },
      { root: 'mat', form: 'mats' },
      { root: 'woman', form: 'women' },
    ])
    expect(termTokens('   ')).toEqual([])
  })

  it('汇总：词数、店铺数、合计、写法与花费最高的例子；同一个词的多行合并', () => {
    const rows = aggregateRoots([
      { term: 'yoga mat', storeId: 's1', totals: totals({ spend: 10 }) },
      { term: 'Yoga Mat', storeId: 's2', totals: totals({ spend: 5 }) },
      { term: 'yoga mats', storeId: null, totals: totals({ spend: 3 }) },
      { term: 'yoga ball', storeId: 's1', totals: totals({ spend: null }) },
    ])
    const yoga = rows.find(row => row.root === 'yoga')
    expect(yoga).toMatchObject({ terms: 3, stores: 2 })
    expect(yoga?.totals.spend).toBe(18)
    expect(yoga?.examples[0]).toEqual({ term: 'yoga mat', spend: 15 })
    const mat = rows.find(row => row.root === 'mat')
    expect(mat?.terms).toBe(2)
    expect(mat?.forms).toEqual(['mat', 'mats'])
    expect(rows.find(row => row.root === 'ball')?.examples).toEqual([{ term: 'yoga ball', spend: null }])
  })
})

describe('推荐动作', () => {
  it('已投放的高花费无成交降价、没投放的否定；可扩量已投放提价、没投放加词；每个动作一次', () => {
    expect(termAdviceOf(totals(), 'TARGETED', ['HIGH_SPEND_NO_ORDER'], 30).map(a => a.action)).toEqual(['LOWER_BID'])
    expect(termAdviceOf(totals(), 'UNTARGETED', ['HIGH_SPEND_NO_ORDER'], 30).map(a => a.action)).toEqual(['NEGATE'])
    expect(termAdviceOf(totals({ orders: 3, spend: 20 }), 'TARGETED', ['SCALE_UP'], 30).map(a => a.action)).toEqual(['RAISE_BID'])
    expect(termAdviceOf(totals({ orders: 3, spend: 20 }), 'UNTARGETED', ['SCALE_UP'], 30).map(a => a.action)).toEqual(['ADD_KEYWORD'])
    const both = termAdviceOf(totals(), 'UNTARGETED', ['NEGATIVE_CANDIDATE', 'HIGH_SPEND_NO_ORDER'], 30)
    expect(both.map(a => a.action)).toEqual(['NEGATE'])
    expect(both[0]?.reason).toContain('近 30 天')
    expect(termAdviceOf(totals(), 'TARGETED', [], 30)).toEqual([])
  })
})

describe('请求校验', () => {
  it('列表：默认按花费降序；未声明的参数与非法值被拒绝', () => {
    const parsed = AdTermListQuerySchema.parse({ tab: 'search-terms', anomaly: 'ADD_KEYWORD', status: 'UNTARGETED', q: 'yoga' })
    expect(parsed).toMatchObject({ sort: { field: 'spend', dir: 'desc' }, tab: 'search-terms', anomaly: 'ADD_KEYWORD' })
    expect(AdTermListQuerySchema.safeParse({ anomaly: 'NOPE' }).success).toBe(false)
    expect(AdTermListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
    expect(AdTermListQuerySchema.safeParse({ sort: 'stores:desc' }).success).toBe(false)
  })

  it('词根与详情', () => {
    expect(AdTermRootsQuerySchema.parse({ sort: 'terms:desc' })).toMatchObject({ sort: { field: 'terms', dir: 'desc' } })
    expect(AdTermDetailQuerySchema.parse({ term: '  yoga mat ' }).term).toBe('yoga mat')
    expect(AdTermDetailQuerySchema.safeParse({}).success).toBe(false)
    expect(AdTermDetailQuerySchema.safeParse({ term: '   ' }).success).toBe(false)
  })
})
