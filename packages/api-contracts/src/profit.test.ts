import { describe, expect, it } from 'vitest'
import { BRIDGE_KEYS, BRIDGE_NOT_CONNECTED, PROFIT_BASES, PROFIT_FLAGS, PROFIT_FLAG_KEYS, INVENTORY_COSTINGS } from './profit.js'
import { buildBridge, bridgeTargetOfLine, computeProfit, emptyAmounts, feeTotal, lineValue, normalizeCosting } from './profit-math.js'
import { classifyFeeLine } from './fee-events.js'

// 利润日表契约（P2b-09）：费用明细归类、单行利润、利润桥、存货计价设置。

const row = (over: Partial<ReturnType<typeof emptyAmounts>> = {}) => ({ ...emptyAmounts(), ...over })

describe('费用明细归到利润桥项目', () => {
  it('销售额、促销、税、运费收入（NON_FEE 里的不同子类型）', () => {
    expect(bridgeTargetOfLine({ category: 'NON_FEE', subtype: 'Principal' })).toBe('REVENUE')
    expect(bridgeTargetOfLine({ category: 'NON_FEE', subtype: 'ProductCharge' })).toBe('REVENUE')
    expect(bridgeTargetOfLine({ category: 'NON_FEE', subtype: 'PromotionDiscount' })).toBe('PROMOTION')
    expect(bridgeTargetOfLine({ category: 'NON_FEE', subtype: 'Tax' })).toBe('EXCLUDED')
    expect(bridgeTargetOfLine({ category: 'NON_FEE', subtype: 'MarketplaceFacilitatorTax' })).toBe('EXCLUDED')
    expect(bridgeTargetOfLine({ category: 'NON_FEE', subtype: 'ShippingCharge' })).toBe('OTHER_FEES')
    expect(bridgeTargetOfLine({ category: 'NON_FEE', subtype: null })).toBe('OTHER_FEES')
  })

  it('退款类下：退给买家的商品款进“退款”，退还的佣金与配送费冲回对应费用，税不计', () => {
    expect(bridgeTargetOfLine({ category: 'REFUND', subtype: 'Principal' })).toBe('REFUNDS')
    expect(bridgeTargetOfLine({ category: 'REFUND', subtype: 'Commission' })).toBe('COMMISSION')
    expect(bridgeTargetOfLine({ category: 'REFUND', subtype: 'FBAPerUnitFulfillmentFee' })).toBe('FULFILLMENT')
    expect(bridgeTargetOfLine({ category: 'REFUND', subtype: 'PromotionDiscount' })).toBe('PROMOTION')
    expect(bridgeTargetOfLine({ category: 'REFUND', subtype: 'ProductTax' })).toBe('EXCLUDED')
  })

  it('其余类别一一对应；移除弃置、订阅等归“其他平台费用”', () => {
    expect(bridgeTargetOfLine({ category: 'COMMISSION', subtype: 'Commission' })).toBe('COMMISSION')
    expect(bridgeTargetOfLine({ category: 'FULFILLMENT', subtype: 'x' })).toBe('FULFILLMENT')
    expect(bridgeTargetOfLine({ category: 'STORAGE', subtype: 'x' })).toBe('STORAGE')
    expect(bridgeTargetOfLine({ category: 'AGED_SURCHARGE', subtype: 'x' })).toBe('AGED_SURCHARGE')
    expect(bridgeTargetOfLine({ category: 'INBOUND_PLACEMENT', subtype: 'x' })).toBe('INBOUND_PLACEMENT')
    expect(bridgeTargetOfLine({ category: 'REIMBURSEMENT', subtype: 'x' })).toBe('REIMBURSEMENT')
    for (const category of ['REMOVAL_DISPOSAL', 'OTHER', 'UNKNOWN']) expect(bridgeTargetOfLine({ category, subtype: 'x' })).toBe('OTHER_FEES')
  })

  it('与写入时的分类器接得上：同一条明细经两步分类得到预期项目', () => {
    const through = (path: string, transactionType: string) => {
      const { category, subtype } = classifyFeeLine({ path, transactionType })
      return bridgeTargetOfLine({ category, subtype })
    }
    expect(through('ItemChargeList/Principal', 'Shipment')).toBe('REVENUE')
    expect(through('ItemFeeList/Commission', 'Shipment')).toBe('COMMISSION')
    expect(through('ItemFeeList/FBAPerUnitFulfillmentFee', 'Shipment')).toBe('FULFILLMENT')
    expect(through('ItemChargeList/Tax', 'Shipment')).toBe('EXCLUDED')
    expect(through('ItemChargeList/Principal', 'Refund')).toBe('REFUNDS')
  })

  it('金额方向：费用与退款取反成“花掉的钱”，销售额与赔付保持原样', () => {
    expect(lineValue('COMMISSION', -15)).toBe(15)
    expect(lineValue('COMMISSION', 3)).toBe(-3) // 退还的佣金
    expect(lineValue('REFUNDS', -40)).toBe(40)
    expect(lineValue('REVENUE', 100)).toBe(100)
    expect(lineValue('REIMBURSEMENT', 25)).toBe(25)
    expect(lineValue('OTHER_FEES', 2)).toBe(-2) // 运费收入是负的费用
  })
})

describe('单行利润', () => {
  const full = row({
    units: 10,
    costedUnits: 10,
    revenue: 200,
    refunds: 20,
    feeCommission: 30,
    feeFulfillment: 40,
    feeStorage: 5,
    promotion: 5,
    productCost: 50,
    firstMileCost: 10,
    otherCost: 2,
    reimbursement: 8,
  })

  it('收入减去全部花费：200 - 20 - 75 - 5 - 62 + 8 = 46', () => {
    expect(feeTotal(full)).toBe(75)
    expect(computeProfit(full)).toBe(46)
  })

  it('卖出了商品但成本没有完全覆盖，利润为空，不拿 0 当成本', () => {
    expect(computeProfit({ ...full, costedUnits: 9 })).toBeNull()
    expect(computeProfit({ ...full, productCost: null })).toBeNull()
  })

  it('没有卖出（只有退款、费用或广告的行）照常计算；头程缺失只少算、不影响是否有利润', () => {
    expect(computeProfit(row({ refunds: 12, feeOther: 3 }))).toBe(-15)
    expect(computeProfit(row({ adsUnallocated: 7.5, feeOther: 2.5 }))).toBe(-10)
    expect(computeProfit({ ...full, firstMileCost: null })).toBe(56)
  })

  it('广告：已分摊与账户级两列相加；都为空时按“未扣”', () => {
    expect(computeProfit(row({ revenue: 10, adsSpendAllocated: 2, adsUnallocated: 3 }))).toBe(5)
    expect(computeProfit(row({ revenue: 10 }))).toBe(10)
  })
})

describe('利润桥', () => {
  it('项目顺序与 07 章一致；关税与汇兑损益标“尚未接入”，不是 0', () => {
    expect(BRIDGE_KEYS[0]).toBe('REVENUE')
    expect(BRIDGE_KEYS[BRIDGE_KEYS.length - 1]).toBe('NET_PROFIT')
    expect(BRIDGE_KEYS).toHaveLength(17)
    const bridge = buildBridge([{ ...row({ revenue: 100, feeCommission: 15 }), profit: 85 }])
    for (const key of BRIDGE_NOT_CONNECTED) expect(bridge.items.find(item => item.key === key)).toMatchObject({ state: 'NOT_CONNECTED', value: null, contribution: null })
    expect(bridge.items.find(item => item.key === 'PRODUCT_COST')).toMatchObject({ state: 'NO_DATA', value: null })
  })

  it('多行合计；各项贡献相加等于净利润；方向正确', () => {
    const a = { ...row({ units: 5, costedUnits: 5, revenue: 100, refunds: 10, feeCommission: 15, productCost: 30, adsUnallocated: null }), profit: 45 }
    const b = { ...row({ revenue: 50, feeFulfillment: 20, promotion: 5, reimbursement: 4, adsUnallocated: 6 }), profit: 23 }
    const bridge = buildBridge([a, b])
    const byKey = Object.fromEntries(bridge.items.map(item => [item.key, item]))
    expect(byKey.REVENUE).toMatchObject({ value: 150, contribution: 150 })
    expect(byKey.REFUNDS).toMatchObject({ value: 10, contribution: -10 })
    expect(byKey.ADS).toMatchObject({ value: 6, contribution: -6 })
    expect(byKey.REIMBURSEMENT).toMatchObject({ value: 4, contribution: 4 })
    expect(bridge.netProfit).toBe(68)
    const sum = bridge.items.filter(item => item.key !== 'NET_PROFIT').reduce((total, item) => total + (item.contribution ?? 0), 0)
    expect(sum).toBe(68)
    expect(bridge.incompleteRows).toBe(0)
  })

  it('有一行利润算不出，整体净利润不给（null），并说明有几行不完整', () => {
    const bridge = buildBridge([
      { ...row({ revenue: 10 }), profit: 10 },
      { ...row({ units: 2, costedUnits: 0, revenue: 20 }), profit: null },
    ])
    expect(bridge).toMatchObject({ netProfit: null, incompleteRows: 1, rows: 2 })
    expect(bridge.items.find(item => item.key === 'NET_PROFIT')).toMatchObject({ value: null, state: 'NO_DATA' })
    expect(buildBridge([])).toMatchObject({ netProfit: null, rows: 0 })
  })
})

describe('常量与设置', () => {
  it('三种口径、三种计价、数据质量标记都有中文名与说明', () => {
    expect(PROFIT_BASES).toEqual(['ORDERED', 'SHIPPED', 'SETTLED'])
    expect(INVENTORY_COSTINGS).toEqual(['FIFO', 'MOVING_AVG', 'MONTH_AVG'])
    for (const key of PROFIT_FLAG_KEYS) {
      expect(PROFIT_FLAGS[key].label.length).toBeGreaterThan(1)
      expect(PROFIT_FLAGS[key].note.length).toBeGreaterThan(5)
    }
  })

  it('存货计价设置：没设置或空值用默认且合法；写了不认识的取值用默认并标记不合法', () => {
    expect(normalizeCosting(undefined)).toEqual({ costing: 'FIFO', valid: true })
    expect(normalizeCosting(null)).toEqual({ costing: 'FIFO', valid: true })
    expect(normalizeCosting('MOVING_AVG')).toEqual({ costing: 'MOVING_AVG', valid: true })
    expect(normalizeCosting('LIFO')).toEqual({ costing: 'FIFO', valid: false })
    expect(normalizeCosting(3)).toEqual({ costing: 'FIFO', valid: false })
  })
})
