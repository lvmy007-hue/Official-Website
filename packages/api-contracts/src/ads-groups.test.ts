import { describe, expect, it } from 'vitest'
import { ADS_GROUP_TABS, ADS_TARGET_TABS, adsTargetTabsFor, bidChangeOf, bidEffectWindows, suggestedBidOf } from './ads-groups'
import type { AdsTotals } from './ads-overview-math'

const day = (spend: number, sales: number | null, clicks = 10, orders = 1): AdsTotals => ({ impressions: 1000, clicks, spend, sales, orders })

describe('广告组与投放对象页签', () => {
  it('广告组 7 个页签，第 7 个叫“操作记录”', () => {
    expect(ADS_GROUP_TABS.map(tab => tab.key)).toEqual(['trend', 'targets', 'search-terms', 'products', 'negatives', 'hourly', 'history'])
    expect(ADS_GROUP_TABS[6].label).toBe('操作记录')
  })

  it('品牌分析页签只有关键词类才有', () => {
    expect(ADS_TARGET_TABS).toHaveLength(6)
    expect(adsTargetTabsFor('KEYWORD').map(tab => tab.key)).toContain('brand-analytics')
    expect(adsTargetTabsFor('PRODUCT').map(tab => tab.key)).not.toContain('brand-analytics')
    expect(adsTargetTabsFor('PRODUCT')).toHaveLength(5)
  })
})

describe('建议竞价', () => {
  it('读区间两端与单点值，顶层与下一层都找', () => {
    expect(suggestedBidOf({ suggestedBidLow: 0.8, suggestedBidHigh: '1.6', suggestedBid: 1.2 }, '2026-10-01T00:00:00Z')).toEqual({
      low: 0.8,
      high: 1.6,
      point: 1.2,
      receivedAt: '2026-10-01T00:00:00Z',
    })
    expect(suggestedBidOf({ detail: { rangeStart: 0.5, rangeEnd: 1 } }, null)).toEqual({ low: 0.5, high: 1, point: null, receivedAt: null })
  })

  it('原文里一个数都没有、或根本不是对象：没有建议，不编造', () => {
    expect(suggestedBidOf({ title: '提高预算' }, null)).toBeNull()
    expect(suggestedBidOf({ suggestedBid: '' }, null)).toBeNull()
    expect(suggestedBidOf(null, null)).toBeNull()
    expect(suggestedBidOf([1, 2], null)).toBeNull()
  })
})

describe('调价事件详情', () => {
  it('读前后竞价；一边缺失或格式不对为 null', () => {
    expect(bidChangeOf({ before: { bid: 1 }, after: { bid: '1.25' } })).toEqual({ before: { bid: 1 }, after: { bid: 1.25 } })
    expect(bidChangeOf({ before: { bid: null }, after: { bid: 2 } })).toEqual({ before: { bid: null }, after: { bid: 2 } })
    expect(bidChangeOf({ before: { bid: 1 } })).toBeNull()
    expect(bidChangeOf('x')).toBeNull()
  })
})

describe('调价前后效果窗口', () => {
  const daily = new Map<string, AdsTotals>([
    ['2026-10-01', day(10, 40)],
    ['2026-10-03', day(20, 60)],
    ['2026-10-04', day(500, 500)], // 调价当天，两边都不算
    ['2026-10-05', day(30, 150)],
    ['2026-10-12', day(99, 99)], // 超出后 7 天
  ])

  it('调价当天不计入任何一边；各边只合计有数据的天，并说明有数据的天数', () => {
    const { before, after } = bidEffectWindows(daily, '2026-10-04', 7)
    expect(before.daysWithData).toBe(2)
    expect(before.totals).toMatchObject({ spend: 30, sales: 100, clicks: 20, orders: 2 })
    expect(before.ratios?.acos).toBeCloseTo(0.3)
    expect(after.daysWithData).toBe(1)
    expect(after.totals).toMatchObject({ spend: 30, sales: 150 })
    expect(after.ratios?.roas).toBeCloseTo(5)
  })

  it('窗口里没有任何指标行：合计与比率是 null，不是 0', () => {
    const { before, after } = bidEffectWindows(new Map(), '2026-10-04', 7)
    expect(before).toEqual({ days: 7, daysWithData: 0, totals: null, ratios: null })
    expect(after).toEqual({ days: 7, daysWithData: 0, totals: null, ratios: null })
  })

  it('跨月、跨年也按日历天算', () => {
    const rows = new Map<string, AdsTotals>([
      ['2026-12-31', day(5, 10)],
      ['2027-01-02', day(7, 14)],
    ])
    const { before, after } = bidEffectWindows(rows, '2027-01-01', 3)
    expect(before.totals?.spend).toBe(5)
    expect(after.totals?.spend).toBe(7)
  })
})
