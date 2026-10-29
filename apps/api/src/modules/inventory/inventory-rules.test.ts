import { describe, expect, it } from 'vitest'
import { agingRisk, assess, computeDemand, countedInbound, daysBetween, plusDays, riskRank } from './inventory-rules'
import { policy, TODAY } from './inventory-fixtures.test-helper'

const orders = (over: Partial<Parameters<typeof computeDemand>[0] & object> = {}) => ({
  units7: 70,
  units30: 300,
  units60: 600,
  units90: 900,
  firstSeen: '2026-07-01',
  stockoutDays30: 0,
  stockoutUnits30: 0,
  ...over,
})

describe('日期工具', () => {
  it('跨月、跨年按日历日加减', () => {
    expect(plusDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(plusDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-10-01', '2026-10-22')).toBe(21)
  })
})

describe('预测日销', () => {
  it('订单充足：中取近 30 天日均，低高取 7/30/90 天日均的最小与最大', () => {
    const result = computeDemand(orders({ units7: 49, units90: 1080 }), null, TODAY)
    expect(result).toMatchObject({ source: 'ORDERS', mid: 10, low: 7, high: 12, stockoutDaysExcluded: 0 })
  })

  it('新品只用已有天数：上架 10 天卖 100 件，日均 10 而不是被 30 天摊薄', () => {
    const result = computeDemand(orders({ firstSeen: '2026-10-12', units7: 70, units30: 100, units60: 100, units90: 100 }), null, TODAY)
    expect(result.mid).toBe(10)
  })

  it('剔除已知断货日：30 天里 10 天断货，断货日卖了 0 件，日均按 20 天算', () => {
    const result = computeDemand(orders({ units30: 200, stockoutDays30: 10, stockoutUnits30: 0 }), null, TODAY)
    expect(result.mid).toBe(10)
    expect(result.stockoutDaysExcluded).toBe(10)
  })

  it('整月都断货时不剔除（没有可用的日子），避免除零', () => {
    const result = computeDemand(orders({ units30: 0, stockoutDays30: 30 }), null, TODAY)
    expect(result.mid).toBe(0)
    expect(result.stockoutDaysExcluded).toBe(0)
  })

  it('没有订单汇总时退回亚马逊报告销量；两者都没有则不预测', () => {
    expect(computeDemand(null, { t7: 14, t30: 90, t60: null, t90: 360 }, TODAY)).toMatchObject({ source: 'AMAZON_REPORT', mid: 3, low: 2, high: 4 })
    expect(computeDemand(null, { t7: null, t30: null, t60: null, t90: null }, TODAY)).toMatchObject({ source: null, mid: null })
    expect(computeDemand(null, null, TODAY).mid).toBeNull()
  })
})

describe('计入的在途', () => {
  it('只累加策略勾选的类别', () => {
    expect(countedInbound(['WORKING', 'SHIPPED'], { working: 1, shipped: 2, receiving: 4 })).toBe(3)
    expect(countedInbound([], { working: 1, shipped: 2, receiving: 4 })).toBe(0)
  })
})

describe('风险判定（规则来自策略版本，不用固定阈值）', () => {
  const base = { sellable: 100, inboundCounted: 0, demandMid: 10, awdQty: null, today: TODAY }

  it('没有策略：不判定，说明原因，不给等级', () => {
    expect(assess({ ...base, policy: null })).toMatchObject({ state: 'NOT_CONNECTED', reason: 'NO_POLICY', risk: null, daysOfCover: null })
  })

  it('没有库存数量或没有销量记录：无数据，不判定', () => {
    expect(assess({ ...base, policy: policy(), sellable: null })).toMatchObject({ state: 'NO_DATA', reason: 'NO_QUANTITY', risk: null })
    expect(assess({ ...base, policy: policy(), demandMid: null })).toMatchObject({ state: 'NO_DATA', reason: 'NO_DEMAND_DATA', risk: null })
  })

  it('覆盖天数早于提前期：高风险；断货日 = 今天 + 可售天数', () => {
    const result = assess({ ...base, policy: policy({ leadTimeDays: 30 }), sellable: 200 })
    expect(result).toMatchObject({ risk: 'HIGH', daysOfCover: 20, stockoutDate: '2026-11-11', fastestLeadDays: 30, fastestReplenishDate: '2026-11-21' })
  })

  it('覆盖天数在提前期与提前期 + 安全库存之间：中风险；刚好等于提前期不算高', () => {
    expect(assess({ ...base, policy: policy(), sellable: 400 }).risk).toBe('MEDIUM')
    expect(assess({ ...base, policy: policy(), sellable: 300 }).risk).toBe('MEDIUM')
    expect(assess({ ...base, policy: policy(), sellable: 440 }).risk).toBe('NORMAL')
  })

  it('覆盖天数超过目标 × 冗余倍数：冗余；刚好等于边界仍是正常', () => {
    expect(assess({ ...base, policy: policy({ coverageDays: 60, redundancyMultiplier: 1.5 }), sellable: 900 }).risk).toBe('NORMAL')
    expect(assess({ ...base, policy: policy({ coverageDays: 60, redundancyMultiplier: 1.5 }), sellable: 910 }).risk).toBe('EXCESS')
  })

  it('计入的在途与可售一起算覆盖天数', () => {
    expect(assess({ ...base, policy: policy(), sellable: 100, inboundCounted: 300 }).daysOfCover).toBe(40)
  })

  it('上游仓储有货且调拨更快时，用更快的提前期；没有可调拨数量时不用', () => {
    const fast = policy({ leadTimeDays: 45, awdLeadTimeDays: 10, safetyDays: 5 })
    expect(assess({ ...base, policy: fast, sellable: 300, awdQty: 50 })).toMatchObject({ fastestLeadDays: 10, risk: 'NORMAL' })
    expect(assess({ ...base, policy: fast, sellable: 300, awdQty: null })).toMatchObject({ fastestLeadDays: 45, risk: 'HIGH' })
  })

  it('近期没有销量：有库存算冗余并标记 noDemand，没有库存算正常，天数为空而不是 0', () => {
    expect(assess({ ...base, policy: policy(), demandMid: 0 })).toMatchObject({ risk: 'EXCESS', noDemand: true, daysOfCover: null, stockoutDate: null })
    expect(assess({ ...base, policy: policy(), demandMid: 0, sellable: 0 })).toMatchObject({ risk: 'NORMAL', noDemand: true })
  })

  it('风险排序：高、中、正常、冗余、未判定', () => {
    expect(['EXCESS', null, 'HIGH', 'NORMAL', 'MEDIUM'].map(item => riskRank(item as never)).sort()).toEqual([0, 1, 2, 3, 4])
  })
})

describe('库龄风险', () => {
  it('起算天数以上有库存或有附加费预估为风险；字段全空为未知', () => {
    expect(agingRisk({ age181to270: 5, age271to365: 0, age365plus: 0, surcharge: null }, 181)).toBe(true)
    expect(agingRisk({ age181to270: 5, age271to365: 0, age365plus: 0, surcharge: null }, 271)).toBe(false)
    expect(agingRisk({ age181to270: 0, age271to365: 0, age365plus: 0, surcharge: 1.5 }, 366)).toBe(true)
    expect(agingRisk({ age181to270: null, age271to365: null, age365plus: null, surcharge: null }, 271)).toBeNull()
    expect(agingRisk(null, 271)).toBeNull()
  })
})
