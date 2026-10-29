import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { allocationOf, campaignSpendOf, currentDailyBudgetOf, dailyOfCampaigns, recentDailyOf, spendBetween, sumCampaignTotals } from './ads-portfolios-rows'
import type { PortfolioCampaign } from './ads-portfolios-load'

// 广告组合行装配的纯函数（P3-11）：活动按“档案 + 产品 + 活动编号”取数、日预算只算启用中的美元按日预算、分配占比与空值。

const campaign = (id: string, values: Partial<PortfolioCampaign> = {}): PortfolioCampaign => ({
  id,
  adsProfileId: 'ap-a',
  adProduct: 'SPONSORED_PRODUCTS',
  externalCampaignId: id,
  portfolioId: 'PF1',
  name: `活动 ${id}`,
  state: 'ENABLED',
  servingStatus: null,
  budget: new Prisma.Decimal(10),
  budgetType: 'DAILY',
  currency: 'USD',
  ...values,
})
const row = (id: string, date: string, spend: number, adsProfileId = 'ap-a') => ({ adsProfileId, adProduct: 'SPONSORED_PRODUCTS', campaignId: id, date, spend })
const period = { from: '2026-10-01', to: '2026-10-09', basis: 'BUDGET_PERIOD' as const }

describe('日预算合计', () => {
  it('只算启用中、美元、按日预算且大于 0 的活动；没有可算的活动为 null', () => {
    const list = [
      campaign('c1', { budget: new Prisma.Decimal(50) }),
      campaign('c2', { state: 'PAUSED' }),
      campaign('c3', { budgetType: 'LIFETIME' }),
      campaign('c4', { currency: 'CAD' }),
      campaign('c5', { budget: new Prisma.Decimal(0) }),
      campaign('c6', { state: 'enabled', budget: new Prisma.Decimal(5.5) }),
    ]
    expect(currentDailyBudgetOf(list)).toBe(55.5)
    expect(currentDailyBudgetOf([list[1], list[2]])).toBeNull()
    expect(currentDailyBudgetOf([])).toBeNull()
  })
})

describe('逐日花费与区间合计', () => {
  const list = [campaign('c1'), campaign('c2')]
  const rows = [row('c1', '2026-10-01', 10), row('c1', '2026-10-02', 5), row('c2', '2026-10-02', 7), row('c1', '2026-10-02', 99, 'ap-other'), row('c9', '2026-10-02', 99)]

  it('只合计本组合的活动：别的档案同编号、别的活动的行忽略', () => {
    const daily = dailyOfCampaigns(list, rows)
    expect([...daily.entries()]).toEqual([
      ['2026-10-01', 10],
      ['2026-10-02', 12],
    ])
    expect(Object.fromEntries(campaignSpendOf(list, rows))).toEqual({ 'ap-a|SPONSORED_PRODUCTS|c1': 15, 'ap-a|SPONSORED_PRODUCTS|c2': 7 })
  })

  it('区间内没有任何一天有行是 null（不是 0）；近 7 天均值缺的天按 0 平均', () => {
    const daily = dailyOfCampaigns(list, rows)
    expect(spendBetween(daily, '2026-10-01', '2026-10-02')).toBe(22)
    expect(spendBetween(daily, '2026-09-01', '2026-09-30')).toBeNull()
    expect(recentDailyOf(daily, '2026-10-03')).toBeCloseTo(22 / 7)
    expect(recentDailyOf(daily, '2026-12-01')).toBeNull()
  })

  it('范围合计：没有任何活动有行是 null', () => {
    expect(sumCampaignTotals(list, new Map())).toBeNull()
  })
})

describe('活动预算分配', () => {
  it('没有活动是“尚无记录”', () => {
    expect(allocationOf([], new Map(), period, true)).toMatchObject({ state: 'NO_DATA', items: [], period: null })
  })

  it('花费从高到低、空值在后；花费占比与日预算占比；暂停的活动不进日预算占比；没有汇总行的花费是 null', () => {
    const list = [campaign('c1', { budget: new Prisma.Decimal(30) }), campaign('c2', { budget: new Prisma.Decimal(10) }), campaign('c3', { state: 'PAUSED', budget: new Prisma.Decimal(60) })]
    const spend = new Map([
      ['ap-a|SPONSORED_PRODUCTS|c1', 25],
      ['ap-a|SPONSORED_PRODUCTS|c2', 75],
    ])
    const result = allocationOf(list, spend, period, true)
    expect(result.items.map(item => item.id)).toEqual(['c2', 'c1', 'c3'])
    expect(result.items[0]).toMatchObject({ spend: 75, spendShare: 0.75, budgetShare: 0.25 })
    expect(result.items[1]).toMatchObject({ spend: 25, spendShare: 0.25, budgetShare: 0.75 })
    expect(result.items[2]).toMatchObject({ spend: null, spendShare: null, budgetShare: null })
    expect(result.period).toEqual(period)
  })

  it('非美元组合或非美元活动不读花费，不折算', () => {
    const list = [campaign('c1', { currency: 'CAD' }), campaign('c2')]
    const spend = new Map([
      ['ap-a|SPONSORED_PRODUCTS|c1', 25],
      ['ap-a|SPONSORED_PRODUCTS|c2', 75],
    ])
    expect(allocationOf(list, spend, period, true).items.find(item => item.id === 'c1')?.spend).toBeNull()
    expect(allocationOf(list, spend, period, false).items.every(item => item.spend === null)).toBe(true)
  })
})
