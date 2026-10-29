import { describe, expect, it } from 'vitest'
import { BA_BASKET_RULES, BA_MIN_SAMPLE, BA_REPORT_DEFS, BA_REPORT_TYPES, BA_TERM_RULES, baReportOf, isBrandReportType } from './brand-analytics'
import type { BaShareSet } from './brand-analytics-types'
import {
  basketAdviceOf,
  breakpointOf,
  emptyShares,
  isDateText,
  isPeriodStart,
  lastCompletePeriod,
  baMedian,
  medianShares,
  ownTopOf,
  periodEndOf,
  periodKindOf,
  previousPeriodStart,
  baQuadrantMedians,
  baQuadrantOf,
  ratioOf,
  recentPeriodStarts,
  shareDelta,
  termGroupOf,
  weightedAverage,
} from './brand-analytics-math'
import { BaBasketQuerySchema, BaCatalogQuerySchema, BaRepeatQuerySchema, BaSqpQuerySchema, BaTermsQuerySchema } from './brand-analytics-query'
import { freshnessErrorMessage, freshnessStatusForFailure, REPORT_FRESHNESS_SOURCES } from './freshness'

const shares = (impression: number | null, click: number | null, cartAdd: number | null, purchase: number | null): BaShareSet => ({ impression, click, cartAdd, purchase })

describe('报告目录', () => {
  it('五份报告各有来源键，与新鲜度目录一一对应（键、类型、展示名）', () => {
    expect(BA_REPORT_DEFS).toHaveLength(5)
    expect(new Set(BA_REPORT_TYPES).size).toBe(5)
    for (const def of BA_REPORT_DEFS) {
      const source = REPORT_FRESHNESS_SOURCES.find(item => item.reportType === def.reportType)
      expect(source, def.reportType).toMatchObject({ key: def.freshnessKey, label: def.label, intervalMinutes: 7 * 24 * 60 })
      expect(def.freshnessKey.startsWith('rpt.ba.')).toBe(true)
    }
    expect(isBrandReportType('GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT')).toBe(true)
    expect(isBrandReportType('GET_SALES_AND_TRAFFIC_REPORT')).toBe(false)
    expect(isBrandReportType(null)).toBe(false)
    expect(baReportOf('market-basket').code).toBe('R-38')
  })

  it('没有品牌备案（BA_NO_BRAND）记“不适用”而不是故障；有中文说明', () => {
    expect(freshnessStatusForFailure('BA_NO_BRAND')).toBe('NOT_APPLICABLE')
    expect(freshnessErrorMessage('BA_NO_BRAND')).toContain('品牌分析')
    expect(freshnessErrorMessage('BA_PERIOD_INVALID')).toContain('完整的一周')
  })
})

describe('周期对齐', () => {
  it('日期合法性含回写比对', () => {
    expect(isDateText('2026-10-18')).toBe(true)
    expect(isDateText('2026-02-30')).toBe(false)
    expect(isDateText('2026-1-8')).toBe(false)
    expect(isDateText(null)).toBe(false)
  })

  it('周必须从周日起，月从 1 日起，季从 1、4、7、10 月 1 日起', () => {
    expect(isPeriodStart('WEEK', '2026-10-18')).toBe(true) // 周日
    expect(isPeriodStart('WEEK', '2026-10-19')).toBe(false)
    expect(isPeriodStart('MONTH', '2026-10-01')).toBe(true)
    expect(isPeriodStart('MONTH', '2026-10-02')).toBe(false)
    expect(isPeriodStart('QUARTER', '2026-10-01')).toBe(true)
    expect(isPeriodStart('QUARTER', '2026-11-01')).toBe(false)
  })

  it('周期结束日：周 +6 天，月到月底（含闰年），季到季末', () => {
    expect(periodEndOf('WEEK', '2026-10-18')).toBe('2026-10-24')
    expect(periodEndOf('MONTH', '2028-02-01')).toBe('2028-02-29')
    expect(periodEndOf('MONTH', '2026-12-01')).toBe('2026-12-31')
    expect(periodEndOf('QUARTER', '2026-10-01')).toBe('2026-12-31')
    expect(periodEndOf('QUARTER', '2026-01-01')).toBe('2026-03-31')
    expect(periodEndOf('WEEK', '2026-10-19')).toBeNull()
  })

  it('起止日恰好是对齐的周期才认出种类', () => {
    expect(periodKindOf('2026-10-18', '2026-10-24')).toBe('WEEK')
    expect(periodKindOf('2026-10-01', '2026-10-31')).toBe('MONTH')
    expect(periodKindOf('2026-07-01', '2026-09-30')).toBe('QUARTER')
    expect(periodKindOf('2026-10-18', '2026-10-25')).toBeNull()
    expect(periodKindOf('2026-10-01', '2026-10-30')).toBeNull()
    expect(periodKindOf(undefined, '2026-10-30')).toBeNull()
  })

  it('上一个同种周期、逐期回看（跨年）', () => {
    expect(previousPeriodStart('WEEK', '2026-01-04')).toBe('2025-12-28')
    expect(previousPeriodStart('MONTH', '2026-01-01')).toBe('2025-12-01')
    expect(previousPeriodStart('QUARTER', '2026-01-01')).toBe('2025-10-01')
    expect(recentPeriodStarts('MONTH', '2026-02-01', 3)).toEqual(['2026-02-01', '2026-01-01', '2025-12-01'])
  })

  it('最近一个已结束的周期：今天是周日时上周刚结束；月初取上个月；季初取上一季', () => {
    expect(lastCompletePeriod('WEEK', new Date('2026-10-25T08:00:00Z'))).toEqual({ start: '2026-10-18', end: '2026-10-24' }) // 周日
    expect(lastCompletePeriod('WEEK', new Date('2026-10-24T08:00:00Z'))).toEqual({ start: '2026-10-11', end: '2026-10-17' }) // 周六：本周还没结束
    expect(lastCompletePeriod('MONTH', new Date('2026-10-24T08:00:00Z'))).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(lastCompletePeriod('MONTH', new Date('2026-01-03T08:00:00Z'))).toEqual({ start: '2025-12-01', end: '2025-12-31' })
    expect(lastCompletePeriod('QUARTER', new Date('2026-10-24T08:00:00Z'))).toEqual({ start: '2026-07-01', end: '2026-09-30' })
    expect(lastCompletePeriod('QUARTER', new Date('2026-02-24T08:00:00Z'))).toEqual({ start: '2025-10-01', end: '2025-12-31' })
  })
})

describe('比率与中位数', () => {
  it('份额按次数相除；缺失或总量不为正是 null，不补 0', () => {
    expect(ratioOf(25, 100)).toBe(0.25)
    expect(ratioOf(0, 100)).toBe(0)
    expect(ratioOf(null, 100)).toBeNull()
    expect(ratioOf(5, 0)).toBeNull()
    expect(ratioOf(5, null)).toBeNull()
  })

  it('份额变化是百分点差，任一期没有为 null', () => {
    expect(shareDelta(0.12, 0.1)).toBe(0.02)
    expect(shareDelta(0.1, 0.12)).toBe(-0.02)
    expect(shareDelta(null, 0.1)).toBeNull()
    expect(shareDelta(0.1, undefined)).toBeNull()
  })

  it('加权平均只用值与权重都有的行', () => {
    expect(
      weightedAverage([
        { value: 0.1, weight: 100 },
        { value: 0.3, weight: 300 },
        { value: null, weight: 1000 },
        { value: 0.9, weight: null },
        { value: 0.9, weight: 0 },
      ]),
    ).toBe(0.25)
    expect(weightedAverage([])).toBeNull()
  })

  it('中位数：奇数取中间，偶数取两个中间的平均，空为 null', () => {
    expect(baMedian([3, 1, 2])).toBe(2)
    expect(baMedian([4, 1, 2, 3])).toBe(2.5)
    expect(baMedian([])).toBeNull()
  })
})

describe('份额漏斗断点（M-146）', () => {
  const rows = [shares(0.1, 0.1, 0.1, 0.1), shares(0.2, 0.2, 0.2, 0.2), shares(0.3, 0.3, 0.3, 0.3), shares(0.4, 0.4, 0.4, 0.4), shares(0.5, 0.5, 0.5, 0.5)]
  const medians = medianShares(rows)!

  it('各份额的中位数；带值的词不足样本下限就整体不分析', () => {
    expect(medians).toEqual({ impression: 0.3, click: 0.3, cartAdd: 0.3, purchase: 0.3 })
    expect(medianShares(rows.slice(0, BA_MIN_SAMPLE - 1))).toBeNull()
    const gaps = [...rows.slice(0, 4), shares(0.5, null, 0.5, 0.5)]
    expect(medianShares(gaps)).toBeNull()
  })

  it('展示高点击低 → 点击断点；点击高加购低 → 加购断点；加购高购买低 → 购买断点；都不满足为空', () => {
    expect(breakpointOf(shares(0.5, 0.1, 0.5, 0.5), medians)).toBe('CLICK')
    expect(breakpointOf(shares(0.1, 0.5, 0.1, 0.5), medians)).toBe('CART')
    expect(breakpointOf(shares(0.1, 0.1, 0.5, 0.1), medians)).toBe('PURCHASE')
    expect(breakpointOf(shares(0.5, 0.5, 0.5, 0.5), medians)).toBeNull()
    expect(breakpointOf(shares(0.1, 0.1, 0.1, 0.1), medians)).toBeNull()
  })

  it('上游优先；等于中位数算“高”；缺少相关份额不判断；没有中位数不判断', () => {
    expect(breakpointOf(shares(0.5, 0.1, 0.5, 0.1), medians)).toBe('CLICK') // 点击与购买都有断点，报最靠上游的
    expect(breakpointOf(shares(0.3, 0.1, 0.1, 0.1), medians)).toBe('CLICK') // 等于中位数算高
    expect(breakpointOf(shares(0.5, null, 0.5, 0.5), medians)).toBeNull()
    expect(breakpointOf(shares(0.5, 0.1, 0.5, 0.5), null)).toBeNull()
    expect(breakpointOf(emptyShares(), medians)).toBeNull()
  })
})

describe('机会象限（M-148）', () => {
  const medians = baQuadrantMedians([
    { volume: 100, purchaseShare: 0.1 },
    { volume: 200, purchaseShare: 0.2 },
    { volume: 300, purchaseShare: 0.3 },
    { volume: 400, purchaseShare: 0.4 },
    { volume: 500, purchaseShare: 0.5 },
    { volume: 900, purchaseShare: null },
  ])!

  it('中位数只用搜索量与购买份额都有的词；样本不足为 null', () => {
    expect(medians).toEqual({ volume: 300, purchaseShare: 0.3 })
    expect(baQuadrantMedians([{ volume: 1, purchaseShare: 0.1 }])).toBeNull()
  })

  it('四个象限；缺值或没有中位数为 null', () => {
    expect(baQuadrantOf(500, 0.5, medians)).toBe('STAR')
    expect(baQuadrantOf(500, 0.1, medians)).toBe('OPPORTUNITY')
    expect(baQuadrantOf(100, 0.5, medians)).toBe('NICHE')
    expect(baQuadrantOf(100, 0.1, medians)).toBe('WATCH')
    expect(baQuadrantOf(300, 0.3, medians)).toBe('STAR') // 等于中位数算高
    expect(baQuadrantOf(null, 0.5, medians)).toBeNull()
    expect(baQuadrantOf(500, null, medians)).toBeNull()
    expect(baQuadrantOf(500, 0.5, null)).toBeNull()
  })
})

describe('热门搜索词分组', () => {
  const own = new Set(['B0OWN00001'])
  const slots = (...items: Array<[string | null, number | null]>) => items.map(([asin, clickShare]) => ({ asin, clickShare }))

  it('只看点击份额前三里的我方 ASIN，取最高份额；前三之外的我方 ASIN 不算', () => {
    expect(ownTopOf(slots(['B0OTHER001', 0.3], ['B0OWN00001', 0.2], ['B0OTHER002', 0.1]), own)).toEqual({ inTop3: true, bestClickShare: 0.2 })
    expect(ownTopOf(slots(['B0OTHER001', 0.3], ['B0OTHER002', 0.2], ['B0OTHER003', 0.1], ['B0OWN00001', 0.05]), own)).toEqual({ inTop3: false, bestClickShare: null })
    expect(ownTopOf(slots(['B0OWN00001', null]), own)).toEqual({ inTop3: true, bestClickShare: null })
    expect(ownTopOf([], own)).toEqual({ inTop3: false, bestClickShare: null })
  })

  it('风险词：掉出前三，或仍在前三但点击份额下降够多；下降不够多不算', () => {
    const now = (rank: number, inTop3: boolean, bestClickShare: number | null) => ({ rank, inTop3, bestClickShare })
    expect(termGroupOf(now(100, false, null), now(100, true, 0.2))).toBe('RISK')
    expect(termGroupOf(now(100, true, 0.14), now(100, true, 0.2))).toBe('RISK')
    expect(termGroupOf(now(100, true, 0.15), now(100, true, 0.2))).toBe('RISK') // 恰好下降 5 个百分点
    expect(termGroupOf(now(100, true, 0.16), now(100, true, 0.2))).toBeNull()
    expect(termGroupOf(now(100, true, null), now(100, true, 0.2))).toBeNull()
  })

  it('机会词：我方没进前三，且排名上升够多；上升不够、已在前三、上一期没有这个词都不算', () => {
    const base = (rank: number, inTop3 = false) => ({ rank, inTop3, bestClickShare: null })
    expect(termGroupOf(base(80), base(100))).toBe('OPPORTUNITY') // 恰好上升 20%
    expect(termGroupOf(base(81), base(100))).toBeNull()
    expect(termGroupOf(base(50, true), base(100))).toBeNull()
    expect(termGroupOf(base(80), null)).toBeNull()
    expect(termGroupOf({ rank: null, inTop3: false, bestClickShare: null }, base(100))).toBeNull()
    expect(BA_TERM_RULES.riseRatio).toBe(0.2)
  })
})

describe('购物篮建议', () => {
  it('两个都是我方且同篮率够高 → 捆绑；对方不是我方且够高 → 商品定向；没有同篮率不建议', () => {
    expect(basketAdviceOf({ pairedOwn: true, combinationPct: BA_BASKET_RULES.bundleMinPct })).toBe('BUNDLE')
    expect(basketAdviceOf({ pairedOwn: true, combinationPct: 0.09 })).toBeNull()
    expect(basketAdviceOf({ pairedOwn: false, combinationPct: BA_BASKET_RULES.targetMinPct })).toBe('PRODUCT_TARGETING')
    expect(basketAdviceOf({ pairedOwn: false, combinationPct: 0.04 })).toBeNull()
    expect(basketAdviceOf({ pairedOwn: false, combinationPct: null })).toBeNull()
  })
})

describe('请求校验', () => {
  it('周期默认是周；起始日必须与周期种类对齐', () => {
    expect(BaSqpQuerySchema.parse({})).toMatchObject({ period: 'WEEK', dimension: 'BRAND', sort: { field: 'searchVolume', dir: 'desc' } })
    expect(BaSqpQuerySchema.safeParse({ period: 'WEEK', periodStart: '2026-10-18' }).success).toBe(true)
    expect(BaSqpQuerySchema.safeParse({ period: 'WEEK', periodStart: '2026-10-19' }).success).toBe(false)
    expect(BaSqpQuerySchema.safeParse({ period: 'MONTH', periodStart: '2026-10-01' }).success).toBe(true)
    expect(BaSqpQuerySchema.safeParse({ period: 'YEAR' }).success).toBe(false)
    expect(BaSqpQuerySchema.safeParse({ periodStart: 'nope' }).success).toBe(false)
  })

  it('ASIN 格式、维度、排序白名单、分组都有校验；重复购买默认按 ASIN 维度', () => {
    expect(BaSqpQuerySchema.parse({ asin: 'b0abcdefgh' }).asin).toBe('B0ABCDEFGH')
    expect(BaSqpQuerySchema.safeParse({ asin: 'short' }).success).toBe(false)
    expect(BaSqpQuerySchema.safeParse({ dimension: 'STORE' }).success).toBe(false)
    expect(BaSqpQuerySchema.safeParse({ sort: 'nope:asc' }).success).toBe(false)
    expect(BaCatalogQuerySchema.safeParse({ sort: 'clicks:asc' }).success).toBe(true)
    expect(BaCatalogQuerySchema.safeParse({ sort: 'nope:asc' }).success).toBe(false)
    expect(BaTermsQuerySchema.parse({}).filter).toBe('ALL')
    expect(BaTermsQuerySchema.safeParse({ filter: 'LOSERS' }).success).toBe(false)
    expect(BaBasketQuerySchema.safeParse({ sort: 'change:desc' }).success).toBe(true)
    expect(BaRepeatQuerySchema.parse({}).dimension).toBe('ASIN')
    expect(BaRepeatQuerySchema.safeParse({ sort: 'repeatCustomersChange:desc' }).success).toBe(true)
  })
})
