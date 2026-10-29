import { STORE_LEVEL_SKU } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { assembleProfit, type AssembleInput, type ProfitRow } from './assemble'
import { actualDayKey, actualMonthKey, buildEstimateLines, EMPTY_ESTIMATES, type EstimateInputs, type EstimateRule } from './estimated-fees'
import { EMPTY_ALLOCATION } from './fee-allocation'
import type { FeeRow, SalesRow } from './types'

// 预估与自定义费用（P6-20）：固定金额按日按月、销售额比例、范围、生效区间边界、冲销、与实际费用走同一条路径、分摊规则、净利润。

const STORE = 'store-1'
const ITEM = 'item-offsite'
const rule = (over: Partial<EstimateRule> = {}): EstimateRule => ({
  id: 'e1',
  itemId: ITEM,
  scopeType: 'STORE',
  scopeId: STORE,
  mode: 'FIXED',
  value: 300,
  period: 'MONTHLY',
  from: '2026-09-01',
  to: null,
  status: 'ACTIVE',
  itemKey: ITEM,
  target: 'OTHER_FEES',
  actualKeys: [ITEM, '~:OTHER_FEES'],
  ...over,
})
const estimates = (rules: EstimateRule[], over: Partial<EstimateInputs> = {}): EstimateInputs => ({ ...EMPTY_ESTIMATES, ...over, rules })
const sale = (sku: string, revenue: number, day = '2026-09-05', store = STORE): SalesRow => ({ sellerAccountId: store, sku, asin: `B-${sku}`, day, currency: 'USD', units: 1, revenue })
const range = { from: '2026-09-01', to: '2026-09-30' }
const total = (lines: ReadonlyArray<{ amount: number }>) => Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 1e6) / 1e6

function lines(input: Partial<Parameters<typeof buildEstimateLines>[0]> & { rules?: EstimateRule[] } = {}) {
  const { rules = [rule()], estimates: extra, ...rest } = input
  return buildEstimateLines({ estimates: estimates(rules, extra), range, today: '2026-10-23', revenue: [], pairs: [], ...rest })
}

describe('估算行生成：固定金额', () => {
  it('按月：整月金额平均到当月每一天，30 天合计恰好是 300', () => {
    const result = lines()
    expect(result).toHaveLength(30)
    expect(result[0]).toMatchObject({ sellerAccountId: STORE, sku: '', day: '2026-09-01', itemKey: ITEM, target: 'OTHER_FEES', amount: 10 })
    expect(total(result)).toBe(300)
  })

  it('按日：每天一笔；生效区间两端都含（9 月 10 日到 12 日共 3 天），区间外不计', () => {
    const result = lines({ rules: [rule({ period: 'DAILY', value: 5, from: '2026-09-10', to: '2026-09-12' })] })
    expect(result.map(line => line.day)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12'])
    expect(total(result)).toBe(15)
  })

  it('只估算到今天为止，不预支未来；停用的规则不参与', () => {
    expect(lines({ today: '2026-09-10', rules: [rule({ period: 'DAILY', value: 1 })] })).toHaveLength(10)
    expect(lines({ rules: [rule({ status: 'INACTIVE' })] })).toEqual([])
  })

  it('范围是别的店铺：只落在那个店铺的店铺级行', () => {
    const result = lines({ rules: [rule({ scopeId: 'store-2', period: 'DAILY', value: 2 })] })
    expect(new Set(result.map(line => line.sellerAccountId))).toEqual(new Set(['store-2']))
  })

  it('SKU 范围：落到卖过这个 SKU 的每个店铺', () => {
    const result = lines({
      rules: [rule({ scopeType: 'SKU', scopeId: 'A', period: 'DAILY', value: 2, from: '2026-09-01', to: '2026-09-01' })],
      pairs: [
        { sellerAccountId: 's2', sku: 'A' },
        { sellerAccountId: 's1', sku: 'A' },
        { sellerAccountId: 's1', sku: 'B' },
      ],
    })
    expect(result.map(line => [line.sellerAccountId, line.sku, line.amount])).toEqual([
      ['s1', 'A', 2],
      ['s2', 'A', 2],
    ])
  })

  it('品类范围：按当天品类内各 SKU 的销售额分摊，当天没有销售就不计入', () => {
    const categories = new Map([
      ['A', new Set(['Home'])],
      ['B', new Set(['Home'])],
      ['C', new Set(['Toys'])],
    ])
    const revenue = [
      { sellerAccountId: STORE, sku: 'A', day: '2026-09-05', revenue: 300 },
      { sellerAccountId: STORE, sku: 'B', day: '2026-09-05', revenue: 100 },
      { sellerAccountId: STORE, sku: 'C', day: '2026-09-05', revenue: 999 },
    ]
    const result = lines({
      rules: [rule({ scopeType: 'CATEGORY', scopeId: 'Home', period: 'DAILY', value: 10, from: '2026-09-04', to: '2026-09-05' })],
      estimates: estimates([], { categories }),
      revenue,
    })
    expect(result.map(line => [line.day, line.sku, line.amount])).toEqual([
      ['2026-09-05', 'A', 7.5],
      ['2026-09-05', 'B', 2.5],
    ])
  })
})

describe('估算行生成：销售额比例', () => {
  it('SKU 范围：每天销售额乘比例（2.5% × 200 = 5），没有销售额的日子没有估算', () => {
    const revenue = [
      { sellerAccountId: STORE, sku: 'A', day: '2026-09-05', revenue: 200 },
      { sellerAccountId: STORE, sku: 'B', day: '2026-09-05', revenue: 100 },
    ]
    const result = lines({ rules: [rule({ mode: 'PERCENT_OF_SALES', scopeType: 'SKU', scopeId: 'A', value: 2.5 })], revenue })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ sku: 'A', day: '2026-09-05', amount: 5 })
  })

  it('店铺范围：该店铺所有 SKU 的销售额都算', () => {
    const revenue = [
      { sellerAccountId: STORE, sku: 'A', day: '2026-09-05', revenue: 200 },
      { sellerAccountId: 'other', sku: 'A', day: '2026-09-05', revenue: 500 },
    ]
    expect(total(lines({ rules: [rule({ mode: 'PERCENT_OF_SALES', value: 10 })], revenue }))).toBe(20)
  })
})

describe('冲销：实际费用出账后对应期间的估算自动不再计入', () => {
  it('按日：只冲销出账那一天', () => {
    const actual = new Set([actualDayKey(STORE, ITEM, '2026-09-05')])
    const result = lines({ rules: [rule({ period: 'DAILY', value: 1, from: '2026-09-04', to: '2026-09-06' })], estimates: estimates([], { actual }) })
    expect(result.map(line => line.day)).toEqual(['2026-09-04', '2026-09-06'])
  })

  it('按月：当月任何一天有实际费用，当月每一天都不再估算；别的月份不受影响', () => {
    const actual = new Set([actualMonthKey(STORE, ITEM, '2026-09-20')])
    const result = lines({ rules: [rule({ from: '2026-08-25', to: '2026-09-02' })], estimates: estimates([], { actual }) })
    expect(result).toEqual([])
    const august = buildEstimateLines({
      estimates: estimates([rule({ from: '2026-08-25', to: '2026-09-02' })], { actual }),
      range: { from: '2026-08-25', to: '2026-09-02' },
      today: '2026-10-23',
      revenue: [],
      pairs: [],
    })
    expect(august.map(line => line.day)).toEqual(['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'])
  })

  it('按系统项目未映射的键冲销（实际费用按内置口径归到同一利润桥项目）', () => {
    const actual = new Set([actualMonthKey(STORE, '~:OTHER_FEES', '2026-09-01')])
    expect(lines({ estimates: estimates([], { actual }) })).toEqual([])
  })

  it('别的店铺的实际费用不冲销本店铺的估算', () => {
    const actual = new Set([actualMonthKey('store-2', ITEM, '2026-09-01')])
    expect(lines({ estimates: estimates([], { actual }) })).toHaveLength(30)
  })
})

describe('装配：与实际费用走同一条路径', () => {
  const actualFee = (amount: number, over: Partial<FeeRow> = {}): FeeRow => ({
    sellerAccountId: STORE,
    sku: '',
    asin: null,
    day: '2026-09-10',
    category: 'SERVICE_FEE',
    subtype: 'Subscription',
    status: 'RELEASED',
    currency: 'USD',
    mode: 'POSTED',
    amount,
    lines: 1,
    ...over,
  })
  function run(over: Partial<AssembleInput> = {}): ProfitRow[] {
    return assembleProfit({
      basis: 'ORDERED',
      costing: 'FIFO',
      costingValid: true,
      range,
      today: '2026-10-23',
      sales: [sale('A', 300), sale('B', 100)],
      fees: [],
      streams: new Map(),
      draftOnly: new Set(),
      fx: () => ({ rate: 1, source: 'SAME_CURRENCY', carriedForward: false }),
      ads: new Map(),
      dictionary: () => ({ target: 'OTHER_FEES', itemKey: 'item-actual', mapped: true }),
      estimates: estimates([rule()]),
      ...over,
    })
  }
  const feeOther = (rows: ProfitRow[], sku: string) => Math.round(rows.filter(row => row.sku === sku).reduce((sum, row) => sum + row.feeOther, 0) * 1e6) / 1e6
  const sum = (rows: ProfitRow[], pick: (row: ProfitRow) => number) => Math.round(rows.reduce((acc, row) => acc + pick(row), 0) * 1e6) / 1e6

  it('店铺级估算计入其他费用并标“含估算”：合计 300，按项目累计为 −300，净利润相应减少', () => {
    const rows = run()
    expect(feeOther(rows, STORE_LEVEL_SKU)).toBe(300)
    const day = rows.find(row => row.sku === STORE_LEVEL_SKU && row.profitDate === '2026-09-05')!
    expect(day.flags).toContain('ESTIMATE_INCLUDED')
    expect(day.estimatedFee).toBe(10)
    expect(day.itemAmounts).toEqual({ [ITEM]: -10 })
    expect(sum(rows, row => row.revenue - row.feeOther)).toBe(100)
    // 没有估算的口径不带估算列
    expect(run({ estimates: EMPTY_ESTIMATES }).some(row => row.estimatedFee !== undefined)).toBe(false)
  })

  it('实际费用出账后冲销：同一费用项的月度估算整月不再计入，利润里只有实际费用', () => {
    const rows = run({ estimates: estimates([rule()], { actual: new Set([actualMonthKey(STORE, ITEM, '2026-09-10')]) }), fees: [actualFee(-39.99)] })
    expect(sum(rows, row => row.feeOther)).toBe(39.99)
    expect(rows.some(row => row.flags.includes('ESTIMATE_INCLUDED'))).toBe(false)
  })

  it('店铺级估算按分摊规则拆到 SKU，分摊后总额不变', () => {
    const rows = run({ allocation: { ...EMPTY_ALLOCATION, rules: [{ feeItemId: ITEM, basis: 'SALES_AMOUNT', manualWeights: null, effectiveMonth: '2026-09' }] } })
    expect(sum(rows, row => row.feeOther)).toBe(300)
    expect(feeOther(rows, STORE_LEVEL_SKU)).toBe(0)
    expect(feeOther(rows, 'A')).toBeGreaterThan(feeOther(rows, 'B'))
  })

  it('比例估算计入对应利润桥项目：佣金类 10% × 300 = 30', () => {
    const rows = run({ estimates: estimates([rule({ mode: 'PERCENT_OF_SALES', scopeType: 'SKU', scopeId: 'A', value: 10, target: 'COMMISSION' })]) })
    expect(sum(rows, row => row.feeCommission)).toBe(30)
    expect(rows.find(row => row.sku === 'A')!.estimatedFee).toBe(30)
  })
})
