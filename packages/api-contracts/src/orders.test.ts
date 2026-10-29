import { describe, expect, it } from 'vitest'
import { OrderListQuerySchema, orderStatusLabel, transactionStatusLabel } from './orders'
import { chargesSummary, classifyFinanceLine, financeLineLabel, financeMatch, netIncomeOf, orderRisks, orderSettlementState, refundOf, type OrderRiskFacts } from './orders-math'

// P2b-01 订单：请求校验与口径（结算状态、退款、财务明细分组、匹配、净收益、风险）。

describe('订单列表查询', () => {
  it('默认按下单时间倒序，筛选值转成布尔与枚举；未知参数被拒绝', () => {
    const parsed = OrderListQuerySchema.parse({ refunded: 'true', settlement: 'DEFERRED', risk: 'RETURN', status: 'Shipped', pageSize: '20' })
    expect(parsed).toMatchObject({ refunded: true, settlement: 'DEFERRED', risk: 'RETURN', status: 'Shipped', pageSize: 20, sort: { field: 'purchaseDate', dir: 'desc' } })
    expect(() => OrderListQuerySchema.parse({ bogus: '1' })).toThrow()
    expect(() => OrderListQuerySchema.parse({ risk: 'TAX_ANOMALY' })).toThrow()
    expect(() => OrderListQuerySchema.parse({ sort: 'amount:desc' })).toThrow()
  })
})

describe('订单标签', () => {
  it('状态标签：未知状态原样显示', () => {
    expect(orderStatusLabel('Shipped')).toBe('已发货')
    expect(orderStatusLabel('BrandNew')).toBe('BrandNew')
    expect(transactionStatusLabel('DEFERRED_RELEASED')).toBe('递延后释放')
    expect(transactionStatusLabel(null)).toBe('状态未知')
  })
})

describe('结算状态', () => {
  it('没有交易 = 尚无；任一递延 = 递延；全部释放 = 已释放；见到没见过的状态 = 未知', () => {
    expect(orderSettlementState([])).toBe('NONE')
    expect(orderSettlementState(['RELEASED', 'DEFERRED'])).toBe('DEFERRED')
    expect(orderSettlementState(['RELEASED', 'DEFERRED_RELEASED'])).toBe('RELEASED')
    expect(orderSettlementState(['RELEASED', null])).toBe('UNKNOWN')
  })
})

describe('退款', () => {
  const sale = { externalTransactionId: 'T1', transactionType: 'Shipment', transactionStatus: 'RELEASED', amount: 20 }
  const refund = { externalTransactionId: 'T2', transactionType: 'Refund', transactionStatus: 'RELEASED', amount: -18 }
  it('没有任何财务交易不能说无退款', () => {
    expect(refundOf([], [], 25)).toEqual({ state: 'PENDING_DATA', amount: null })
  })
  it('有交易但没有退款类交易 = 无退款', () => {
    expect(refundOf([sale], [], 25)).toEqual({ state: 'NONE', amount: null })
  })
  it('退款金额取退款交易里收入与税类明细（客户拿回的钱），不含佣金退还', () => {
    const lines = [
      { sourceEventId: 'T2:0:0.0', path: 'ProductCharges/Principal', amount: -20 },
      { sourceEventId: 'T2:0:0.1', path: 'Tax/ProductTax', amount: -2 },
      { sourceEventId: 'T2:0:0.2', path: 'AmazonFees/Commission', amount: 3 },
      { sourceEventId: 'T1:0:0.0', path: 'ProductCharges/Principal', amount: 22 },
    ]
    expect(refundOf([sale, refund], lines, 22)).toEqual({ state: 'FULL', amount: 22 })
    expect(refundOf([sale, refund], lines, 40)).toEqual({ state: 'PARTIAL', amount: 22 })
  })
  it('没有逐项明细时退回交易合计', () => {
    expect(refundOf([sale, refund], [], 40)).toEqual({ state: 'PARTIAL', amount: 18 })
  })
})

describe('财务明细分组', () => {
  it('收入、税、费用三类；费用关键字优先，认不出的归为费用', () => {
    expect(classifyFinanceLine('ProductCharges/Principal')).toBe('REVENUE')
    expect(classifyFinanceLine('Shipping/ShippingCharge')).toBe('REVENUE')
    expect(classifyFinanceLine('Promotion/Discount')).toBe('REVENUE')
    expect(classifyFinanceLine('Tax/ProductTax')).toBe('TAX')
    expect(classifyFinanceLine('AmazonFees/Commission')).toBe('FEE')
    expect(classifyFinanceLine('AmazonFees/FBAPerUnitFulfillmentFee')).toBe('FEE')
    expect(classifyFinanceLine('Mystery/Node')).toBe('FEE')
    expect(financeLineLabel('AmazonFees/FBAPerUnitFulfillmentFee')).toBe('Amazon Fees / FBAPer Unit Fulfillment Fee')
  })
})

describe('订单收入汇总与匹配', () => {
  const charges = [
    { chargeKind: 'ITEM', amount: 20 },
    { chargeKind: 'SHIPPING', amount: 5 },
    { chargeKind: 'PROMOTION', amount: -2 },
    { chargeKind: 'TAX', amount: 2.16 },
  ]
  it('汇总：促销为负、税单列、不含税合计与含税合计', () => {
    expect(chargesSummary(charges)).toEqual({ item: 20, shipping: 5, promotion: -2, tax: 2.16, other: 0, totalExTax: 23, total: 25.16 })
  })
  it('没有交易、没有明细、一致、不一致四种状态', () => {
    const lines = [
      { sourceEventId: 'T1:0:0', path: 'ProductCharges/Principal', amount: 20 },
      { sourceEventId: 'T1:0:1', path: 'Shipping/ShippingCharge', amount: 5 },
      { sourceEventId: 'T1:0:2', path: 'Promotion/Discount', amount: -2 },
      { sourceEventId: 'T1:0:3', path: 'Tax/ProductTax', amount: 2.16 },
      { sourceEventId: 'T1:0:4', path: 'AmazonFees/Commission', amount: -3 },
    ]
    expect(financeMatch({ orderRevenue: 23, orderTax: 2.16, transactionCount: 0, lines: [] }).state).toBe('NO_TRANSACTIONS')
    expect(financeMatch({ orderRevenue: 23, orderTax: 2.16, transactionCount: 1, lines: [] }).state).toBe('NO_LINES')
    expect(financeMatch({ orderRevenue: 23, orderTax: 2.16, transactionCount: 1, lines })).toMatchObject({ state: 'MATCHED', revenue: { diff: 0 }, tax: { diff: 0 } })
    expect(financeMatch({ orderRevenue: 25, orderTax: 2.16, transactionCount: 1, lines })).toMatchObject({ state: 'DIFF', revenue: { order: 25, finance: 23, diff: -2 } })
  })
})

describe('净收益', () => {
  it('没有财务交易不能算（不是 0）；有交易取全部金额之和', () => {
    expect(netIncomeOf([])).toMatchObject({ state: 'PENDING', value: null })
    expect(netIncomeOf([{ amount: 20.5 }, { amount: -3.25 }, { amount: -10 }])).toMatchObject({ state: 'OK', value: 7.25 })
  })
})

describe('风险标记', () => {
  const base: OrderRiskFacts = {
    status: 'Shipped',
    amount: 25.16,
    chargesTotal: 25.16,
    orderTax: 2.16,
    financeTax: 2.16,
    cancellation: null,
    refund: { state: 'NONE', amount: null },
    returns: [],
    isReplacement: false,
    replacedOrderId: null,
    replacementReason: null,
    replacedBy: [],
    positiveTransactionTotal: 0,
  }
  it('正常订单没有风险', () => {
    expect(orderRisks(base)).toEqual([])
  })
  it('每条风险都带原因：取消请求未完成为高，已取消为中', () => {
    expect(orderRisks({ ...base, cancellation: { cancelledBy: 'BUYER', reasonCode: 'CUSTOMER_REQUEST', cancelledAt: null } })[0]).toMatchObject({ kind: 'CANCEL_REQUEST', level: 'HIGH' })
    const done = orderRisks({ ...base, cancellation: { cancelledBy: 'SELLER', reasonCode: '', cancelledAt: new Date() } })[0]
    expect(done).toMatchObject({ level: 'MEDIUM' })
    expect(done.reason).toContain('卖家')
  })
  it('退款、退货、替换（双向）', () => {
    const risks = orderRisks({
      ...base,
      refund: { state: 'FULL', amount: 25.16 },
      returns: [{ quantity: 2, reason: 'DEFECTIVE' }],
      isReplacement: true,
      replacedOrderId: '111-1',
      replacedBy: ['222-2'],
    })
    expect(risks.map(risk => risk.kind)).toEqual(['REFUND', 'RETURN', 'REPLACEMENT', 'REPLACEMENT'])
    expect(risks[0].reason).toContain('$25.16')
    expect(risks[1].reason).toContain('共 2 件')
    expect(risks.every(risk => risk.reason.length > 0 && risk.label.length > 0)).toBe(true)
  })
  it('税务异常与财务差异：金额对不上；已取消订单仍有收款', () => {
    expect(orderRisks({ ...base, financeTax: 3.5 }).map(risk => risk.kind)).toEqual(['TAX_ANOMALY'])
    expect(orderRisks({ ...base, financeTax: null }).map(risk => risk.kind)).toEqual([])
    expect(orderRisks({ ...base, chargesTotal: 20 }).map(risk => risk.kind)).toEqual(['FINANCE_DIFF'])
    expect(orderRisks({ ...base, status: 'Canceled', positiveTransactionTotal: 12 })[0]).toMatchObject({ kind: 'FINANCE_DIFF', level: 'HIGH' })
  })
})
