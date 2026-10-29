import { describe, expect, it } from 'vitest'
import { ASIN360_TABS, asin360PriceLink, simulatePrice, visibleAsin360Tabs, type Asin360UnitEconomics, type Asin360UnitLine } from './index.js'

const line = (key: Asin360UnitLine['key'], label: string, perUnit: number | null, direction: 'INCOME' | 'COST' = 'COST', state: Asin360UnitLine['state'] = 'OK'): Asin360UnitLine => ({
  key,
  label,
  direction,
  perUnit,
  state,
  link: asin360PriceLink(key),
  contribution: perUnit === null ? null : direction === 'INCOME' ? perUnit : -perUnit,
})

// 每件：售价 20，退款 1，佣金 3，促销 1（比例项合计 5 = 25%），配送费 4、采购 5、头程 1（固定）→ 净利 20 − 1 − 3 − 1 − 4 − 5 − 1 = 5
const unit: Asin360UnitEconomics = {
  state: 'OK',
  note: null,
  units: 10,
  avgPrice: 20,
  netPerUnit: 5,
  proportionalShare: 0.25,
  lines: [
    line('REVENUE', '销售额', 20, 'INCOME'),
    line('REFUNDS', '退款', 1),
    line('COMMISSION', '佣金', 3),
    line('FULFILLMENT', '配送费', 4),
    line('PROMOTION', '促销费用', 1),
    line('PRODUCT_COST', '采购成本', null, 'COST', 'RESTRICTED'),
    line('FIRST_MILE', '头程', 1),
  ],
}

describe('价格模拟', () => {
  it('目标价等于当前平均售价：与每件净利润一致', () => {
    const sim = simulatePrice(unit, 20)
    expect(sim).toMatchObject({ price: 20, net: 5, deltaNet: 0, margin: 0.25 })
  })

  it('涨价：比例项（退款、佣金、促销）一起涨，固定项不变', () => {
    const sim = simulatePrice(unit, 24)!
    // 比例项合计每件 5 → 6，其余固定：24 − 6 − 4 − 5 − 1 = 8（采购成本 5 + 头程 1 的合计固定在 6，被隐藏的成本不影响差额）
    expect(sim.net).toBeCloseTo(8, 6)
    expect(sim.deltaNet).toBeCloseTo(3, 6)
    expect(sim.margin).toBeCloseTo(8 / 24, 6)
    expect(sim.lines.find(item => item.key === 'REVENUE')?.perUnit).toBe(24)
    expect(sim.lines.find(item => item.key === 'COMMISSION')?.perUnit).toBeCloseTo(3.6, 6)
    expect(sim.lines.find(item => item.key === 'FULFILLMENT')?.perUnit).toBe(4)
  })

  it('没有数据或没有权限的项目逐项仍为空，不被当成 0', () => {
    const sim = simulatePrice(unit, 25)!
    expect(sim.lines.find(item => item.key === 'PRODUCT_COST')?.perUnit).toBeNull()
  })

  it('保本价：净利润为 0 的售价；按该价模拟确实为 0', () => {
    const sim = simulatePrice(unit, 18)!
    // 净利 = 5 + (p − 20) × 0.75 = 0 → p = 20 − 5 / 0.75
    expect(sim.breakEvenPrice).toBeCloseTo(13.33, 2)
    expect(simulatePrice(unit, sim.breakEvenPrice!)!.net).toBeCloseTo(0, 1)
  })

  it('亏损商品降价会更亏；保本价高于当前售价', () => {
    const loss = { ...unit, netPerUnit: -3 }
    const sim = simulatePrice(loss, 15)!
    expect(sim.net).toBeCloseTo(-3 - 5 * 0.75, 6)
    expect(sim.breakEvenPrice).toBeCloseTo(24, 2)
  })

  it('比例项吃掉全部涨幅时没有保本价', () => {
    expect(simulatePrice({ ...unit, proportionalShare: 1 }, 25)?.breakEvenPrice).toBeNull()
  })

  it('净利润算不出、没有销量、目标价不合法：不模拟', () => {
    expect(simulatePrice({ ...unit, state: 'INCOMPLETE', netPerUnit: null }, 20)).toBeNull()
    expect(simulatePrice({ ...unit, state: 'NO_UNITS', avgPrice: null, netPerUnit: null, proportionalShare: null }, 20)).toBeNull()
    expect(simulatePrice(unit, 0)).toBeNull()
    expect(simulatePrice(unit, -1)).toBeNull()
    expect(simulatePrice(unit, Number.NaN)).toBeNull()
  })
})

describe('价格联动分类', () => {
  it('销售额随目标价，佣金、退款、促销等比例，其余固定', () => {
    expect(asin360PriceLink('REVENUE')).toBe('PRICE')
    expect(['REFUNDS', 'COMMISSION', 'PROMOTION'].map(key => asin360PriceLink(key as never))).toEqual(['PROPORTIONAL', 'PROPORTIONAL', 'PROPORTIONAL'])
    expect(['FULFILLMENT', 'STORAGE', 'ADS', 'PRODUCT_COST', 'FIRST_MILE', 'DUTY', 'OTHER_COST', 'REIMBURSEMENT'].map(key => asin360PriceLink(key as never))).toEqual(Array(8).fill('FIXED'))
  })
})

describe('页签上线', () => {
  it('利润与成本、退货两个页签已上线，利润页签需要 profit.read 与 field.profit', () => {
    const live = ASIN360_TABS.filter(tab => tab.live).map(tab => tab.key)
    expect(live).toEqual(expect.arrayContaining(['economics', 'returns']))
    const economics = ASIN360_TABS.find(tab => tab.key === 'economics')!
    expect(economics.permissions).toEqual(['products.read', 'profit.read', 'field.profit'])
  })

  it('权限不够的页签不显示', () => {
    const has = (permissions: string[]) => (permission: string) => permissions.includes(permission)
    const keys = (permissions: string[]) => visibleAsin360Tabs(has(permissions)).map(tab => tab.key)
    expect(keys(['products.read'])).toEqual(['overview', 'traffic', 'changes'])
    expect(keys(['products.read', 'profit.read'])).not.toContain('economics')
    expect(keys(['products.read', 'profit.read', 'field.profit', 'returns.read'])).toEqual(['overview', 'traffic', 'economics', 'returns', 'changes'])
  })
})
