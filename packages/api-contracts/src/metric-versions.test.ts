import { describe, expect, it } from 'vitest'
import {
  BUSINESS_RULE_KEYS,
  DEFAULT_BUSINESS_RULES,
  availableInventoryOf,
  describeBusinessRule,
  describeRuleChanges,
  netSalesOf,
  readBusinessRuleValue,
  readBusinessRules,
  resolveToday,
  weekStartOf,
} from './business-rules.js'
import { BRIDGE_KEYS } from './profit.js'
import { buildBridge } from './profit-math.js'
import {
  DEFAULT_PROFIT_FORMULA,
  FORMULA_KEYS,
  describeFormula,
  describeFormulaChanges,
  evaluateFormula,
  formulaIssues,
  formulaTags,
  readFormulaConfig,
  sameFormula,
  type ProfitFormulaConfig,
} from './metric-versions.js'
import { BusinessRuleBodySchema, BusinessRuleValueSchemas, MetricDecisionBodySchema, MetricDiffBodySchema, ProfitFormulaBodySchema } from './metric-versions-query.js'

// 一行利润日表：所有金额列都有数，净利润 = 各项带符号贡献之和（与派生任务的口径一致）。
const row = {
  units: 10,
  costedUnits: 10,
  revenue: 1000,
  refunds: 50,
  feeCommission: 150,
  feeFulfillment: 120,
  feeStorage: 10,
  feeAged: 5,
  feeInbound: 8,
  feeOther: 7,
  promotion: 20,
  adsSpendAllocated: 60,
  adsUnallocated: 15,
  productCost: 300,
  firstMileCost: 40,
  otherCost: 12,
  dutyCost: 25,
  reimbursement: 30,
  productCostOriginal: null,
  firstMileCostOriginal: null,
  profit: 1000 - 50 - 150 - 120 - 10 - 5 - 8 - 7 - 20 - 75 - 300 - 40 - 25 - 12 + 30,
}
const bridge = buildBridge([row])
const items = bridge.items.map(item => ({ key: item.key, contribution: item.contribution, state: item.state }))

describe('利润公式', () => {
  it('公式表的行 = 利润桥去掉净利润与汇兑损益，顺序与利润桥一致', () => {
    expect(FORMULA_KEYS).toEqual(BRIDGE_KEYS.filter(key => key !== 'NET_PROFIT' && key !== 'FX_GAIN_LOSS'))
  })

  it('默认公式合法，毛利润不含广告、其他成本与赔付，分母是销售额', () => {
    expect(formulaIssues(DEFAULT_PROFIT_FORMULA)).toEqual([])
    expect(DEFAULT_PROFIT_FORMULA.gross).not.toContain('ADS')
    expect(DEFAULT_PROFIT_FORMULA.gross).not.toContain('OTHER_COST')
    expect(DEFAULT_PROFIT_FORMULA.gross).not.toContain('REIMBURSEMENT')
    expect(DEFAULT_PROFIT_FORMULA.denominator).toEqual(['REVENUE'])
  })

  it('基线：默认公式逐分算出固定数字，全部项目都计入时毛利润等于净利润', () => {
    const result = evaluateFormula(DEFAULT_PROFIT_FORMULA, items, 1)
    expect(result.grossProfit).toBe(1000 - 50 - 150 - 120 - 10 - 5 - 8 - 7 - 20 - 300 - 40 - 25)
    expect(result.grossProfit).toBe(265)
    expect(result.denominator).toBe(1000)
    expect(result.grossMargin).toBe(0.265)
    expect(result.missing).toEqual([])
    const all = evaluateFormula({ gross: [...FORMULA_KEYS], denominator: ['REVENUE'] }, items, 1)
    expect(all.grossProfit).toBe(row.profit)
    expect(bridge.netProfit).toBe(row.profit)
  })

  it('改公式只影响毛利润与毛利率：去掉退款、加上广告，分母加上赔付收入', () => {
    const next: ProfitFormulaConfig = { gross: [...DEFAULT_PROFIT_FORMULA.gross.filter(key => key !== 'REFUNDS'), 'ADS'], denominator: ['REVENUE', 'REIMBURSEMENT'] }
    const result = evaluateFormula(next, items, 1)
    expect(result.grossProfit).toBe(265 + 50 - 75)
    expect(result.denominator).toBe(1030)
    expect(result.grossMargin).toBe(Math.round((240 / 1030) * 1_000_000) / 1_000_000)
    expect(describeFormulaChanges(DEFAULT_PROFIT_FORMULA, next)).toEqual(['毛利润新增计入：广告', '毛利润不再计入：退款', '毛利率分母新增：赔付收入'])
  })

  it('没有采购成本时不给毛利润；其他项目没有数据按 0 计入并列出；没有成本权限时不给', () => {
    const noCost = items.map(item => (item.key === 'PRODUCT_COST' ? { ...item, contribution: null, state: 'NO_DATA' } : item))
    expect(evaluateFormula(DEFAULT_PROFIT_FORMULA, noCost, 1)).toMatchObject({ grossProfit: null, grossMargin: null, note: expect.stringContaining('采购成本') })
    const noDuty = items.map(item => (item.key === 'DUTY' ? { ...item, contribution: null, state: 'NO_DATA' } : item))
    const result = evaluateFormula(DEFAULT_PROFIT_FORMULA, noDuty, 1)
    expect(result.grossProfit).toBe(290)
    expect(result.missing).toEqual(['DUTY'])
    const restricted = items.map(item => (item.key === 'PRODUCT_COST' ? { ...item, contribution: null, state: 'RESTRICTED' } : item))
    expect(evaluateFormula(DEFAULT_PROFIT_FORMULA, restricted, 1).note).toContain('field.cost')
    expect(evaluateFormula(DEFAULT_PROFIT_FORMULA, [], 0)).toMatchObject({ grossProfit: null, note: '范围内没有利润日表数据' })
  })

  it('分母不为正时没有毛利率', () => {
    const zero = items.map(item => (item.key === 'REVENUE' ? { ...item, contribution: 0 } : item))
    expect(evaluateFormula(DEFAULT_PROFIT_FORMULA, zero, 1)).toMatchObject({ grossMargin: null, note: '分母不为正，毛利率没有意义' })
  })

  it('合法性：毛利润要有收入类项目，分母必须是收入类项目', () => {
    expect(formulaIssues({ gross: [], denominator: ['REVENUE'] })).toContain('毛利润至少要计入一个项目')
    expect(formulaIssues({ gross: ['COMMISSION'], denominator: ['REVENUE'] })).toContain('毛利润至少要计入一个收入类项目（销售额或赔付收入）')
    expect(formulaIssues({ gross: ['REVENUE'], denominator: [] })).toContain('毛利率的分母至少要选一个项目')
    expect(formulaIssues({ gross: ['REVENUE'], denominator: ['REVENUE', 'COMMISSION'] })).toEqual(['毛利率的分母只能选收入类项目，佣金是花费'])
  })

  it('读取存储里的配置：按利润桥顺序去重，形状不对返回 null', () => {
    expect(readFormulaConfig({ gross: ['PRODUCT_COST', 'REVENUE', 'REVENUE'], denominator: ['REVENUE'] })).toEqual({ gross: ['REVENUE', 'PRODUCT_COST'], denominator: ['REVENUE'] })
    expect(readFormulaConfig({ gross: ['NET_PROFIT'], denominator: [] })).toBeNull()
    expect(readFormulaConfig(null)).toBeNull()
    expect(readFormulaConfig({ gross: 'x' })).toBeNull()
    expect(sameFormula(DEFAULT_PROFIT_FORMULA, { ...DEFAULT_PROFIT_FORMULA })).toBe(true)
  })

  it('文字与标签：加项、减项分开，第一项是花费时带负号', () => {
    expect(describeFormula(DEFAULT_PROFIT_FORMULA).gross).toBe('毛利润 = 销售额 − 退款 − 佣金 − 配送费 − 仓储费 − 库龄附加费 − 入仓配置费 − 其他平台费用 − 促销费用 − 采购成本 − 头程 − 关税')
    expect(describeFormula({ gross: ['COMMISSION', 'REVENUE'], denominator: ['REVENUE'] }).gross).toBe('毛利润 = 销售额 − 佣金')
    expect(describeFormula(DEFAULT_PROFIT_FORMULA).margin).toBe('毛利率 = 毛利润 ÷ (销售额)')
    expect(formulaTags(DEFAULT_PROFIT_FORMULA)[0]).toEqual({ key: 'REVENUE', label: '销售额', sign: 1 })
    expect(formulaTags(DEFAULT_PROFIT_FORMULA)[1]?.sign).toBe(-1)
  })
})

describe('业务口径', () => {
  it('默认值：净销售额扣退款、可用库存是可售、周一起始、统一取最晚站点', () => {
    expect(DEFAULT_BUSINESS_RULES).toEqual({
      netSales: { deduct: ['REFUNDS'] },
      availableInventory: { components: ['FULFILLABLE'] },
      weekStart: { day: 'MON' },
      multiSiteToday: { mode: 'LATEST_SITE' },
    })
    expect(readBusinessRules({})).toEqual(DEFAULT_BUSINESS_RULES)
  })

  it('净销售额：勾选扣减项；销售额没有数据就没有净销售额', () => {
    expect(netSalesOf({ deduct: ['REFUNDS'] }, { revenue: 1000, refunds: 50, promotion: 20 })).toBe(950)
    expect(netSalesOf({ deduct: ['REFUNDS', 'PROMOTION'] }, { revenue: 1000, refunds: 50, promotion: 20 })).toBe(930)
    expect(netSalesOf({ deduct: [] }, { revenue: 1000, refunds: 50, promotion: 20 })).toBe(1000)
    expect(netSalesOf({ deduct: ['REFUNDS'] }, { revenue: null, refunds: 50, promotion: 20 })).toBeNull()
  })

  it('可用库存：勾选项相加；任一勾选项没有数据就整体没有', () => {
    const quantity = { sellable: 10, reserved: 3, inboundWorking: 1, inboundShipped: 2, inboundReceiving: 4 }
    expect(availableInventoryOf({ components: ['FULFILLABLE'] }, quantity)).toBe(10)
    expect(availableInventoryOf({ components: ['FULFILLABLE', 'INBOUND_SHIPPED', 'INBOUND_RECEIVING'] }, quantity)).toBe(16)
    expect(availableInventoryOf({ components: ['FULFILLABLE', 'RESERVED'] }, { ...quantity, reserved: null })).toBeNull()
  })

  it('周起始日：同一天在不同起始日下落在不同的周', () => {
    // 2026-10-27 是周二
    expect(weekStartOf('2026-10-27', 'MON')).toBe('2026-10-26')
    expect(weekStartOf('2026-10-27', 'SUN')).toBe('2026-10-25')
    expect(weekStartOf('2026-10-27', 'SAT')).toBe('2026-10-24')
    expect(weekStartOf('2026-10-26', 'MON')).toBe('2026-10-26')
    expect(weekStartOf('2026-10-25', 'SUN')).toBe('2026-10-25')
    expect(weekStartOf('2026-01-01', 'MON')).toBe('2025-12-29')
  })

  it('多站点今日：统一取最晚的站点，或各站点各自取', () => {
    expect(resolveToday('LATEST_SITE', ['2026-10-27', '2026-10-28', '2026-10-27'])).toEqual({ shared: '2026-10-28', perSite: ['2026-10-28', '2026-10-28', '2026-10-28'] })
    expect(resolveToday('EACH_SITE', ['2026-10-27', '2026-10-28'])).toEqual({ shared: null, perSite: ['2026-10-27', '2026-10-28'] })
    expect(resolveToday('LATEST_SITE', [])).toEqual({ shared: null, perSite: [] })
  })

  it('读取单项：形状不对返回 null，库存组成不能为空', () => {
    expect(readBusinessRuleValue('weekStart', { day: 'FRI' })).toBeNull()
    expect(readBusinessRuleValue('availableInventory', { components: [] })).toBeNull()
    expect(readBusinessRuleValue('netSales', { deduct: ['PROMOTION', 'REFUNDS'] })).toEqual({ deduct: ['REFUNDS', 'PROMOTION'] })
    expect(readBusinessRules({ weekStart: { day: 'XX' } })).toBeNull()
    expect(BUSINESS_RULE_KEYS).toHaveLength(4)
  })

  it('文字与差别', () => {
    expect(describeBusinessRule('netSales', { deduct: ['REFUNDS', 'PROMOTION'] })).toBe('净销售额 = 销售额 − 退款 − 促销费用')
    expect(describeBusinessRule('availableInventory', { components: ['FULFILLABLE', 'RESERVED'] })).toBe('可用库存 = 可售 + 预留')
    expect(describeBusinessRule('weekStart', { day: 'SUN' })).toBe('每周从周日开始')
    const next = { ...DEFAULT_BUSINESS_RULES, weekStart: { day: 'SUN' as const } }
    expect(describeRuleChanges(DEFAULT_BUSINESS_RULES, next)).toEqual(['周起始日：每周从周一开始 → 每周从周日开始'])
    expect(describeRuleChanges(DEFAULT_BUSINESS_RULES, DEFAULT_BUSINESS_RULES)).toEqual([])
  })
})

describe('请求校验', () => {
  const reason = '调整口径'
  it('利润公式：合法通过，不合法带出原因，不允许多余字段和不认识的项目', () => {
    expect(ProfitFormulaBodySchema.safeParse({ version: 0, gross: ['REVENUE', 'COMMISSION'], denominator: ['REVENUE'], reason }).success).toBe(true)
    const bad = ProfitFormulaBodySchema.safeParse({ version: 0, gross: [], denominator: [], reason })
    expect(bad.success).toBe(false)
    expect(ProfitFormulaBodySchema.safeParse({ version: 0, gross: ['NET_PROFIT'], denominator: ['REVENUE'], reason }).success).toBe(false)
    expect(ProfitFormulaBodySchema.safeParse({ version: 0, gross: ['REVENUE'], denominator: ['REVENUE'], reason: '', extra: 1 }).success).toBe(false)
  })

  it('业务口径：每项的值按各自形状校验', () => {
    expect(BusinessRuleBodySchema.safeParse({ version: 1, value: {}, reason }).success).toBe(true)
    expect(BusinessRuleValueSchemas.netSales.safeParse({ deduct: ['REFUNDS', 'REFUNDS'] }).success).toBe(false)
    expect(BusinessRuleValueSchemas.availableInventory.safeParse({ components: [] }).success).toBe(false)
    expect(BusinessRuleValueSchemas.weekStart.safeParse({ day: 'SAT' }).success).toBe(true)
    expect(BusinessRuleValueSchemas.multiSiteToday.safeParse({ mode: 'ANY' }).success).toBe(false)
  })

  it('审批：驳回必须写意见；差异区间不超过 366 天', () => {
    expect(MetricDecisionBodySchema.safeParse({ decision: 'REJECTED', comment: '', version: 1 }).success).toBe(false)
    expect(MetricDecisionBodySchema.safeParse({ decision: 'APPROVED', version: 1 }).success).toBe(true)
    expect(MetricDiffBodySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(true)
    expect(MetricDiffBodySchema.safeParse({ from: '2026-01-01', to: '2027-01-02' }).success).toBe(false)
    expect(MetricDiffBodySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(false)
  })
})
