import { describe, expect, it } from 'vitest'
import { adsBucketOf, adsRangeIssue, countBuckets, inAdsRanges, inBucket, isAdsLevel, summarizeLevel } from './ads-levels'

const totals = (impressions: number, clicks: number, orders: number, spend: number | null = null, sales: number | null = null) => ({ impressions, clicks, orders, spend, sales })

describe('广告层级通用口径', () => {
  it('分类互斥且按先后判断', () => {
    expect(adsBucketOf(totals(0, 5, 1))).toBe('CONVERTED')
    expect(adsBucketOf(totals(10, 5, 0))).toBe('CLICK_NO_ORDER')
    expect(adsBucketOf(totals(10, 0, 0))).toBe('IMPRESSION_NO_CLICK')
    expect(adsBucketOf(totals(0, 0, 0))).toBe('NO_IMPRESSION')
  })

  it('没有指标的行不进任何一类，单独数', () => {
    const counted = countBuckets([totals(10, 1, 1), totals(10, 1, 0), null, null])
    expect(counted.withoutMetrics).toBe(2)
    expect(Object.values(counted.buckets).reduce((sum, value) => sum + value, 0)).toBe(2)
    expect(inBucket(null, 'CONVERTED')).toBe(false)
    expect(inBucket(null, undefined)).toBe(true)
  })

  it('区间：没有指标或比率算不出来都不命中；比率按小数；边界含端点', () => {
    expect(inAdsRanges(null, {})).toBe(true)
    expect(inAdsRanges(null, { spendMin: 0 })).toBe(false)
    const row = totals(1000, 100, 5, 40, 100)
    expect(inAdsRanges(row, { acosMin: 0.4, acosMax: 0.4 })).toBe(true)
    expect(inAdsRanges(row, { acosMax: 0.3 })).toBe(false)
    expect(inAdsRanges(totals(10, 5, 0, 3, null), { acosMax: 10 })).toBe(false)
    expect(inAdsRanges(row, { ordersMin: 6 })).toBe(false)
    expect(inAdsRanges(row, { spendMin: 40, clicksMax: 100 })).toBe(true)
  })

  it('区间下限大于上限给出提示', () => {
    expect(adsRangeIssue({ acosMin: 0.5, acosMax: 0.1 })).toContain('下限')
    expect(adsRangeIssue({ acosMin: 0.1, acosMax: 0.5 })).toBeNull()
    expect(adsRangeIssue({})).toBeNull()
  })

  it('汇总只合计有指标的行，并给出没有指标的个数', () => {
    const summary = summarizeLevel([totals(100, 10, 2, 10, 50), totals(100, 10, 0, 5, 0), null])
    expect(summary).toMatchObject({ total: 3, withoutMetrics: 1, totals: { spend: 15, sales: 50, orders: 2 } })
    expect(summary.ratios.acos).toBeCloseTo(0.3)
    expect(summarizeLevel([]).total).toBe(0)
  })

  it('层级白名单', () => {
    expect(isAdsLevel('campaigns')).toBe(true)
    expect(isAdsLevel('portfolios')).toBe(false)
  })
})
