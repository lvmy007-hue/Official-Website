import { describe, expect, it } from 'vitest'
import { coreTerms, funnelStages, preferKiosk, resolveFunnelPeriod, summarizeTraffic, termShares, trafficPoints, type TermRow, type TrafficRow } from './product-traffic-math'

const row = (date: string, over: Partial<TrafficRow> = {}): TrafficRow => ({
  date,
  source: 'DATA_KIOSK',
  sessions: 100,
  pageViews: 250,
  units: 5,
  sales: 100,
  buyBoxPct: 0.9,
  unitSessionPct: null,
  ...over,
})

describe('逐日流量', () => {
  it('同一天两个来源都有时取数据中心；只有报告来源的日子用报告', () => {
    const byDate = preferKiosk([row('2026-10-01', { source: 'REPORT', sessions: 1 }), row('2026-10-01', { sessions: 100 }), row('2026-10-02', { source: 'REPORT', sessions: 7 })])
    expect(byDate.get('2026-10-01')!.sessions).toBe(100)
    expect(byDate.get('2026-10-02')!.sessions).toBe(7)
    // 顺序反过来结果一样
    expect(preferKiosk([row('2026-10-01', { sessions: 100 }), row('2026-10-01', { source: 'REPORT', sessions: 1 })]).get('2026-10-01')!.sessions).toBe(100)
  })

  it('范围内每天一个点；没有记录的日子全是 null，不是 0；转化率缺省时用件数 ÷ 会话补算', () => {
    const points = trafficPoints(['2026-10-01', '2026-10-02'], new Map([['2026-10-02', row('2026-10-02')]]))
    expect(points[0]).toEqual({ date: '2026-10-01', sessions: null, pageViews: null, units: null, sales: null, buyBoxPct: null, unitSessionPct: null })
    expect(points[1]).toMatchObject({ sessions: 100, units: 5, unitSessionPct: 0.05 })
    expect(trafficPoints(['2026-10-02'], new Map([['2026-10-02', row('2026-10-02', { unitSessionPct: 0.12 })]]))[0]!.unitSessionPct).toBe(0.12)
  })

  it('没有任何记录的范围没有合计', () => {
    expect(summarizeTraffic(trafficPoints(['2026-10-01'], new Map()))).toBeNull()
  })

  it('合计：转化率只用两个口径都有记录的日子，购物车获得率按会话加权', () => {
    const byDate = new Map([
      ['2026-10-01', row('2026-10-01', { sessions: 100, units: 10, buyBoxPct: 1 })],
      ['2026-10-02', row('2026-10-02', { sessions: 300, units: 0, buyBoxPct: 0.5 })],
      ['2026-10-03', row('2026-10-03', { sessions: null, units: 9, buyBoxPct: null, pageViews: null, sales: 50 })],
    ])
    const summary = summarizeTraffic(trafficPoints(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'], byDate))!
    expect(summary).toMatchObject({ sessions: 400, units: 19, days: 3, pageViews: 500 })
    // 10-03 没有会话，不参与转化率：(10 + 0) ÷ 400
    expect(summary.unitSessionPct).toBe(0.025)
    // (1×100 + 0.5×300) ÷ 400 = 0.625
    expect(summary.buyBoxPct).toBe(0.625)
    expect(summary.pageViewsPerSession).toBe(1.25)
  })

  it('没有会话时不给转化率、购物车获得率与每会话浏览量', () => {
    const summary = summarizeTraffic(trafficPoints(['2026-10-01'], new Map([['2026-10-01', row('2026-10-01', { sessions: null, pageViews: null, buyBoxPct: null })]])))!
    expect(summary).toMatchObject({ sessions: null, unitSessionPct: null, buyBoxPct: null, pageViewsPerSession: null, units: 5 })
  })
})

const counts = (impressions: number | null, clicks: number | null, cartAdds: number | null, purchases: number | null) => ({ impressions, clicks, cartAdds, purchases })
const NONE: TermRow['official'] = { impression: null, click: null, cartAdd: null, purchase: null }
const term = (searchQuery: string, volume: number | null, own: ReturnType<typeof counts>, total: ReturnType<typeof counts>, official = NONE): TermRow => ({
  searchQuery,
  searchVolume: volume,
  own,
  total,
  official,
})

describe('搜索词份额与漏斗', () => {
  it('份额 = 我方 ÷ 市场；次数缺失退回官方份额；超过 1 按 1', () => {
    expect(termShares(term('a', 1, counts(10, 5, 2, 1), counts(100, 50, 20, 10)))).toEqual({ impression: 0.1, click: 0.1, cartAdd: 0.1, purchase: 0.1 })
    expect(termShares(term('a', 1, counts(null, null, null, null), counts(null, null, null, null), { impression: 0.2, click: 0.3, cartAdd: null, purchase: 0.4 }))).toEqual({
      impression: 0.2,
      click: 0.3,
      cartAdd: null,
      purchase: 0.4,
    })
    expect(termShares(term('a', 1, counts(200, 0, 0, 0), counts(100, 10, 10, 10))).impression).toBe(1)
  })

  it('漏斗：全部词合计，并与上一周期对比；没有上一周期时对比为空', () => {
    const now = [term('a', 100, counts(10, 4, 2, 1), counts(100, 40, 20, 10)), term('b', 50, counts(30, 6, 3, 1), counts(100, 60, 30, 10))]
    const before = [term('a', 100, counts(5, 2, 1, 0), counts(100, 40, 20, 10))]
    const stages = funnelStages(now, before)
    expect(stages.map(stage => stage.key)).toEqual(['impressions', 'clicks', 'cartAdds', 'purchases'])
    expect(stages[0]).toMatchObject({ market: 200, own: 40, share: 0.2, previousShare: 0.05, shareChange: 0.15 })
    expect(stages[3]).toMatchObject({ share: 0.1, previousShare: 0, shareChange: 0.1 })
    expect(funnelStages(now, null).every(stage => stage.previousShare === null && stage.shareChange === null)).toBe(true)
    expect(funnelStages([], null)[0]).toMatchObject({ market: null, own: null, share: null })
  })
})

describe('品牌分析周期', () => {
  it('没传起始日取最近一个有数据的周期；传了就用它（哪怕没有数据）；一个都没有为 null', () => {
    expect(resolveFunnelPeriod('WEEK', undefined, ['2026-10-18', '2026-10-11'])).toEqual({
      kind: 'WEEK',
      start: '2026-10-18',
      end: '2026-10-24',
      previousStart: '2026-10-11',
      available: ['2026-10-18', '2026-10-11'],
    })
    expect(resolveFunnelPeriod('MONTH', '2026-09-01', ['2026-10-01'])).toMatchObject({ start: '2026-09-01', end: '2026-09-30', previousStart: '2026-08-01' })
    expect(resolveFunnelPeriod('MONTH', undefined, [])).toBeNull()
  })
})

describe('核心搜索词与断点', () => {
  it('不足样本数不做断点诊断，但仍按搜索量排序列出', () => {
    const { terms, breakpoints } = coreTerms([term('小', 10, counts(1, 1, 1, 1), counts(10, 10, 10, 10)), term('大', 99, counts(1, 1, 1, 1), counts(10, 10, 10, 10))])
    expect(terms.map(item => item.searchQuery)).toEqual(['大', '小'])
    expect(breakpoints).toMatchObject({ state: 'INSUFFICIENT', medians: null, counts: { CLICK: 0, CART: 0, PURCHASE: 0 } })
    expect(terms.every(item => item.breakpoint === null)).toBe(true)
  })

  it('样本足够时：以这个 ASIN 自己全部词的中位数为界，报最靠上游的断点', () => {
    // 6 个词；展示份额都是 0.5，点击份额 5 个 0.5、1 个 0.1，其余份额都是 0.5
    const rows = ['a', 'b', 'c', 'd', 'e'].map((name, index) => term(name, 100 - index, counts(50, 50, 50, 50), counts(100, 100, 100, 100)))
    rows.push(term('低点击', 200, counts(50, 10, 50, 50), counts(100, 100, 100, 100)))
    const { terms, breakpoints } = coreTerms(rows)
    expect(breakpoints.state).toBe('OK')
    expect(breakpoints.counts).toEqual({ CLICK: 1, CART: 0, PURCHASE: 0 })
    expect(terms[0]).toMatchObject({ searchQuery: '低点击', breakpoint: 'CLICK' })
    expect(terms.slice(1).every(item => item.breakpoint === null)).toBe(true)
  })

  it('核心词表最多 20 个，但断点计数覆盖全部词', () => {
    const rows = Array.from({ length: 30 }, (_, index) => term(`w${String(index).padStart(2, '0')}`, 1000 - index, counts(50, index === 0 ? 1 : 50, 50, 50), counts(100, 100, 100, 100)))
    const { terms, breakpoints } = coreTerms(rows)
    expect(terms).toHaveLength(20)
    expect(breakpoints.counts.CLICK).toBe(1)
  })
})
