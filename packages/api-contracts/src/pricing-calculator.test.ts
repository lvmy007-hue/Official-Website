import { describe, expect, it } from 'vitest'
import { SHARE_TREND_DISCLAIMER, aggregateShareTrend } from './share-trend'
import { estimateFromRateCard, scenarioOf, withAmazonFees, type PricingInput } from './pricing-calculator'

const input: PricingInput = {
  purchaseCost: 5,
  firstMile: { method: 'NONE', unitPrice: 0 },
  lengthCm: 20,
  widthCm: 15,
  heightCm: 2,
  weightG: 200,
  category: 'STANDARD',
  prices: [20, 25],
  referenceAsin: null,
  storeId: null,
}

describe('新品定价试算费率表', () => {
  it('200 克、综合品类、售价 20：大标准件配送费 4.08，佣金 3，利润 7.92', () => {
    const result = estimateFromRateCard(input, { state: 'NOT_REQUESTED', message: '没有参考 ASIN' })
    expect(result.tier).toBe('LARGE_STANDARD')
    expect(result.rateCardVersion).toBe('US-FBA-2025-NONPEAK')
    expect(result.scenarios[0]).toMatchObject({ price: 20, referralFee: 3, fulfillmentFee: 4.08, profit: 7.92, margin: 0.396, roi: 1.584, feeSource: 'RATE_CARD' })
    expect(result.scenarios[1]?.price).toBe(25)
    expect(result.estimateNote).toContain('模型估算')
  })

  it('头程按公斤计入成本，分母为 0 时 ROI 为空', () => {
    const withMile = estimateFromRateCard({ ...input, firstMile: { method: 'PER_KG', unitPrice: 10 }, prices: [20] }, { state: 'NOT_REQUESTED', message: '' })
    expect(withMile.scenarios[0]?.firstMileFee).toBe(2)
    expect(withMile.scenarios[0]?.profit).toBe(5.92)
    const free = scenarioOf(10, 1, 1, 0, 0, 'RATE_CARD')
    expect(free.roi).toBeNull()
  })

  it('费用预估回写：佣金按售价比例，配送费不变', () => {
    const base = estimateFromRateCard(input, { state: 'QUEUED', message: '', priceUsed: 20 })
    const next = withAmazonFees(base, 3.5, 5, 20)
    expect(next.source).toBe('AMAZON')
    expect(next.scenarios[0]).toMatchObject({ referralFee: 3.5, fulfillmentFee: 5, feeSource: 'AMAZON' })
    expect(next.scenarios[1]?.referralFee).toBe(4.38)
    expect(next.scenarios[1]?.fulfillmentFee).toBe(5)
    expect(next.amazon.state).toBe('OK')
  })
})

describe('关键词份额趋势', () => {
  it('同一词多店只留展示次数最高的一行，不把市场总量相加', () => {
    const { points } = aggregateShareTrend([
      { periodStart: '2026-10-11', searchQuery: 'mug', impressionsOwn: 10, impressionsTotal: 100, clicksOwn: 2, clicksTotal: 40, searchVolume: 1000 },
      { periodStart: '2026-10-11', searchQuery: 'mug', impressionsOwn: 30, impressionsTotal: 80, clicksOwn: 8, clicksTotal: 20, searchVolume: 1000 },
    ])
    expect(points).toEqual([{ periodStart: '2026-10-11', impressionShare: 30 / 80, clickShare: 8 / 20, searchVolume: 1000 }])
  })

  it('超过周期上限只留最近的，并截断', () => {
    const rows = Array.from({ length: 18 }, (_, index) => ({
      periodStart: `2026-01-${String(index + 1).padStart(2, '0')}`,
      searchQuery: 'mug',
      impressionsOwn: 1,
      impressionsTotal: 2,
      clicksOwn: null,
      clicksTotal: null,
      searchVolume: null,
    }))
    const { points, truncated } = aggregateShareTrend(rows, 16)
    expect(truncated).toBe(true)
    expect(points).toHaveLength(16)
    expect(points[0]?.periodStart).toBe('2026-01-03')
    expect(points.at(-1)?.clickShare).toBeNull()
  })

  it('免责声明写明这不是前台排名', () => {
    expect(SHARE_TREND_DISCLAIMER).toContain('这不是前台排名')
  })
})
