import { describe, expect, it } from 'vitest'
import { simulatePrice, type ProfitBridgeView } from '@nova/api-contracts'
import { unitEconomicsOf } from './product-economics-math'

const bridge = (netProfit: number | null, incompleteRows = 0): ProfitBridgeView => ({
  netProfit,
  coveredProfit: netProfit,
  incompleteRows,
  rows: 3,
  items: [
    { key: 'REVENUE', label: '销售额', direction: 'INCOME', value: 200, contribution: 200, state: 'OK', note: null },
    { key: 'REFUNDS', label: '退款', direction: 'COST', value: 10, contribution: -10, state: 'OK', note: null },
    { key: 'COMMISSION', label: '佣金', direction: 'COST', value: 30, contribution: -30, state: 'OK', note: null },
    { key: 'ADS', label: '广告', direction: 'COST', value: null, contribution: null, state: 'NO_DATA', note: null },
    { key: 'DUTY', label: '关税', direction: 'COST', value: null, contribution: null, state: 'NOT_CONNECTED', note: null },
    { key: 'NET_PROFIT', label: '净利润', direction: 'RESULT', value: netProfit, contribution: netProfit, state: netProfit === null ? 'NO_DATA' : 'OK', note: null },
  ],
})
const input = { units: 10, revenue: 200, refunds: 10, feeCommission: 30, promotion: 10 }

describe('每件经济折算', () => {
  it('合计 ÷ 件数；净利润项不进明细；没有数据与尚未接入的项目每件金额为空', () => {
    const unit = unitEconomicsOf(input, bridge(50))
    expect(unit).toMatchObject({ state: 'OK', note: null, units: 10, avgPrice: 20, netPerUnit: 5, proportionalShare: 0.25 })
    expect(unit.lines.map(line => line.key)).toEqual(['REVENUE', 'REFUNDS', 'COMMISSION', 'ADS', 'DUTY'])
    expect(unit.lines.find(line => line.key === 'COMMISSION')).toMatchObject({ perUnit: 3, contribution: -3, direction: 'COST', link: 'PROPORTIONAL' })
    expect(unit.lines.find(line => line.key === 'ADS')).toMatchObject({ perUnit: null, state: 'NO_DATA', contribution: null })
    expect(unit.lines.find(line => line.key === 'DUTY')).toMatchObject({ perUnit: null, state: 'NOT_CONNECTED' })
  })

  it('折算结果与价格模拟自洽：按平均售价模拟，净利润等于每件净利润', () => {
    const unit = unitEconomicsOf(input, bridge(50))
    expect(simulatePrice(unit, unit.avgPrice!)?.net).toBe(unit.netPerUnit)
  })

  it('没有销量：无法折算，不给 0', () => {
    const unit = unitEconomicsOf({ ...input, units: 0, revenue: 0 }, bridge(null))
    expect(unit).toMatchObject({ state: 'NO_UNITS', avgPrice: null, netPerUnit: null, proportionalShare: null, lines: [] })
    expect(simulatePrice(unit, 20)).toBeNull()
  })

  it('净利润整体算不出（缺成本）：每件净利润为空，说明缺了几行，价格模拟不可用', () => {
    const unit = unitEconomicsOf(input, bridge(null, 2))
    expect(unit).toMatchObject({ state: 'INCOMPLETE', netPerUnit: null, avgPrice: 20, proportionalShare: 0.25 })
    expect(unit.note).toContain('2 行')
    expect(simulatePrice(unit, 20)).toBeNull()
  })

  it('有销量但销售额不为正：没有平均售价，模拟不可用', () => {
    const unit = unitEconomicsOf({ ...input, revenue: 0 }, bridge(-5))
    expect(unit).toMatchObject({ state: 'INCOMPLETE', avgPrice: null, netPerUnit: -0.5 })
    expect(simulatePrice(unit, 20)).toBeNull()
  })
})
