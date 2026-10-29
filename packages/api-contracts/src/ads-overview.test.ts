import { describe, expect, it } from 'vitest'
import {
  ADS_ANOMALY_RULES,
  ADS_CARD_DEFINITION,
  ADS_CARD_GOOD_WHEN,
  ADS_CARD_KEYS,
  ADS_CARD_LABEL,
  ADS_CONNECTED_PRODUCTS,
  ADS_PRODUCTS,
  ADS_PRODUCT_LABEL,
  ADS_QUADRANTS,
  ADS_QUADRANT_LABEL,
} from './ads-overview'
import { AdsOverviewQuerySchema } from './ads-overview-query'
import {
  addNullable,
  addTotals,
  adsAttribution,
  adsRatios,
  bucketKeyOf,
  bucketValues,
  budgetUtilizationOf,
  campaignAnomaly,
  overlapDays,
  pointChange,
  quadrantOf,
  ratioChange,
} from './ads-overview-math'

describe('广告控制台目录', () => {
  it('每张指标卡都有名称、变好方向与口径说明；产品、象限都有中文', () => {
    expect(ADS_CARD_KEYS).toHaveLength(12)
    for (const key of ADS_CARD_KEYS) {
      expect(ADS_CARD_LABEL[key], key).toBeTruthy()
      expect(ADS_CARD_GOOD_WHEN[key], key).toMatch(/^(up|down)$/)
      expect(ADS_CARD_DEFINITION[key].definition, key).toBeTruthy()
      expect(ADS_CARD_DEFINITION[key].source, key).toBeTruthy()
    }
    for (const product of ADS_PRODUCTS) expect(ADS_PRODUCT_LABEL[product]).toBeTruthy()
    for (const quadrant of ADS_QUADRANTS) expect(ADS_QUADRANT_LABEL[quadrant]).toBeTruthy()
    expect(ADS_CONNECTED_PRODUCTS.every(product => ADS_PRODUCTS.includes(product))).toBe(true)
  })

  it('请求参数：粒度默认按日，只接受日、周、月', () => {
    expect(AdsOverviewQuerySchema.parse({})).toEqual({ granularity: 'day' })
    expect(AdsOverviewQuerySchema.parse({ granularity: 'week' }).granularity).toBe('week')
    expect(AdsOverviewQuerySchema.safeParse({ granularity: 'year' }).success).toBe(false)
  })
})

describe('比率与合计', () => {
  const totals = { impressions: 10_000, clicks: 200, spend: 100, sales: 400, orders: 20 }

  it('ACoS、ROAS、点击率、单次点击成本、转化率', () => {
    expect(adsRatios(totals)).toEqual({ acos: 0.25, roas: 4, ctr: 0.02, cpc: 0.5, cvr: 0.1 })
  })

  it('分母为 0 或来源没给的值，比率是 null，不是 0 也不是无穷大', () => {
    expect(adsRatios({ impressions: 0, clicks: 0, spend: 50, sales: 0, orders: 0 })).toEqual({ acos: null, roas: 0, ctr: null, cpc: null, cvr: null })
    expect(adsRatios({ impressions: 100, clicks: 10, spend: null, sales: null, orders: 1 })).toMatchObject({ acos: null, roas: null, cpc: null })
  })

  it('可空求和：全空还是空，有一个值就有合计；合计时不把空当 0 影响其他项', () => {
    expect(addNullable([null, undefined])).toBeNull()
    expect(addNullable([null, 3, 4])).toBe(7)
    expect(addTotals([totals, { impressions: 1, clicks: 1, spend: null, sales: null, orders: 0 }])).toEqual({ impressions: 10_001, clicks: 201, spend: 100, sales: 400, orders: 20 })
  })

  it('变化：比率用相对变化，对比期为 0 或缺失不编造；百分比类用差值', () => {
    expect(ratioChange(120, 100)).toBeCloseTo(0.2, 9)
    expect(ratioChange(100, 0)).toBeNull()
    expect(ratioChange(null, 100)).toBeNull()
    expect(pointChange(0.3, 0.25)).toBeCloseTo(0.05, 9)
    expect(pointChange(0.3, null)).toBeNull()
  })
})

describe('分桶', () => {
  it('周按周一起算，月按月初；桶内全是空则桶为空', () => {
    expect(bucketKeyOf('2026-10-01', 'day')).toBe('2026-10-01')
    expect(bucketKeyOf('2026-10-01', 'week')).toBe('2026-09-28')
    expect(bucketKeyOf('2026-10-04', 'week')).toBe('2026-09-28')
    expect(bucketKeyOf('2026-10-05', 'week')).toBe('2026-10-05')
    expect(bucketKeyOf('2026-10-31', 'month')).toBe('2026-10-01')
    const days = [
      { date: '2026-10-01', value: 5 },
      { date: '2026-10-02', value: null },
      { date: '2026-10-05', value: null },
      { date: '2026-10-06', value: null },
    ]
    expect(bucketValues(days, 'week')).toEqual([
      { key: '2026-09-28', value: 5 },
      { key: '2026-10-05', value: null },
    ])
    expect(bucketValues(days, 'month')).toEqual([{ key: '2026-10-01', value: 5 }])
  })
})

describe('预算利用率', () => {
  it('重叠天数：含首尾，结束日为空表示不设结束', () => {
    expect(overlapDays('2026-10-01', '2026-10-10', null, null)).toBe(10)
    expect(overlapDays('2026-10-01', '2026-10-10', '2026-10-08', null)).toBe(3)
    expect(overlapDays('2026-10-01', '2026-10-10', null, '2026-10-03')).toBe(3)
    expect(overlapDays('2026-10-01', '2026-10-10', '2026-11-01', null)).toBe(0)
    expect(overlapDays('2026-10-01', '2026-10-10', null, '2026-09-30')).toBe(0)
  })

  it('花费合计 ÷ Σ（日预算 × 重叠天数）；活动在范围内不投放不计入；没有可算的活动为空', () => {
    const result = budgetUtilizationOf(
      [
        { dailyBudget: 10, spend: 60, startDate: null, endDate: null },
        { dailyBudget: 20, spend: 30, startDate: '2026-10-08', endDate: null },
        { dailyBudget: 50, spend: 999, startDate: '2026-12-01', endDate: null },
      ],
      '2026-10-01',
      '2026-10-10',
    )
    expect(result).toEqual({ utilization: 90 / 160, spent: 90, budgeted: 160 })
    expect(budgetUtilizationOf([], '2026-10-01', '2026-10-10').utilization).toBeNull()
  })
})

describe('异常与四象限', () => {
  const { MIN_SPEND, MIN_CLICKS } = ADS_ANOMALY_RULES

  it('花费无转化：花费与点击都达到下限、一单都没有', () => {
    expect(campaignAnomaly({ spend: MIN_SPEND, sales: 0, clicks: MIN_CLICKS, orders: 0 })).toBe('NO_CONVERSION')
    expect(campaignAnomaly({ spend: MIN_SPEND - 0.01, sales: 0, clicks: 500, orders: 0 })).toBeNull()
    expect(campaignAnomaly({ spend: 100, sales: 0, clicks: MIN_CLICKS - 1, orders: 0 })).toBe('ACOS_OVER_SALES')
  })

  it('花费超过广告销售额；来源没给销售额不判断；有转化且赚钱的活动正常', () => {
    expect(campaignAnomaly({ spend: 50, sales: 40, clicks: 100, orders: 2 })).toBe('ACOS_OVER_SALES')
    expect(campaignAnomaly({ spend: 50, sales: null, clicks: 100, orders: 2 })).toBeNull()
    expect(campaignAnomaly({ spend: 50, sales: 200, clicks: 100, orders: 5 })).toBeNull()
    expect(campaignAnomaly({ spend: null, sales: null, clicks: 100, orders: 0 })).toBeNull()
  })

  it('四象限：花费以平均为界，ACoS 以整体为界', () => {
    expect(quadrantOf(100, 0.2, 50, 0.3)).toBe('STAR')
    expect(quadrantOf(100, 0.5, 50, 0.3)).toBe('WASTE')
    expect(quadrantOf(10, 0.2, 50, 0.3)).toBe('POTENTIAL')
    expect(quadrantOf(10, 0.5, 50, 0.3)).toBe('LOW')
    expect(quadrantOf(50, 0.3, 50, 0.3)).toBe('STAR')
  })
})

describe('指标树因子', () => {
  const before = { impressions: 1000, clicks: 100, spend: 80, sales: 200, orders: 4 }
  const after = { impressions: 2000, clicks: 160, spend: 110, sales: 400, orders: 13 }

  it('花费 = 点击 × 单次点击成本；广告销售额 = 点击 × 转化率 × 订单均价，因子连乘等于总量', () => {
    const result = adsAttribution(after, before)
    expect(result.note).toBeNull()
    for (const tree of [result.spend!, result.sales!]) {
      const product = (pick: 'before' | 'after') => tree.factors.reduce((total, factor) => total * factor[pick], 1)
      expect(product('before')).toBeCloseTo(tree.before, 9)
      expect(product('after')).toBeCloseTo(tree.after, 9)
    }
    expect(result.spend!.factors.map(factor => factor.key)).toEqual(['clicks', 'cpc'])
    expect(result.sales!.factors.map(factor => factor.key)).toEqual(['clicks', 'cvr', 'aov'])
  })

  it('任一因子在任一期不是正数就不拆（不补 0）并说明原因；花费能拆而销售额不能时只返回花费', () => {
    const noOrders = adsAttribution({ ...after, orders: 0, sales: 0 }, before)
    expect(noOrders.sales).toBeNull()
    expect(noOrders.spend).not.toBeNull()
    expect(noOrders.note).toContain('不补 0')
    const none = adsAttribution(after, { impressions: 0, clicks: 0, spend: null, sales: null, orders: 0 })
    expect(none).toMatchObject({ spend: null, sales: null })
  })
})
