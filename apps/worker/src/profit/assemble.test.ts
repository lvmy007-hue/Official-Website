import { STORE_LEVEL_SKU, type ProfitBasis } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { assembleProfit, type AssembleInput, type ProfitRow } from './assemble'
import type { AdsInfo, FeeRow, FxLookup, SalesRow, SkuStreams } from './types'

// 利润日表装配（P2b-09）：三种口径、汇率折算与回退、成本版本与存货计价、数据质量标记。

const STORE = 'store-1'
const DAY = '2026-09-05'
const sale = (over: Partial<SalesRow> = {}): SalesRow => ({ sellerAccountId: STORE, sku: 'SKU-A', asin: 'B0A', day: DAY, currency: 'USD', units: 10, revenue: 200, ...over })
const fee = (category: string, subtype: string | null, amount: number, over: Partial<FeeRow> = {}): FeeRow => ({
  sellerAccountId: STORE,
  sku: 'SKU-A',
  asin: 'B0A',
  day: DAY,
  category,
  subtype,
  status: 'RELEASED',
  currency: 'USD',
  mode: 'ORDER',
  amount,
  lines: 1,
  ...over,
})
const fx =
  (rates: Record<string, { rate: number; carried?: boolean; missingFrom?: string }>): FxLookup =>
  (currency, day) => {
    if (currency === 'USD') return { rate: 1, source: 'SAME_CURRENCY', carriedForward: false }
    const entry = rates[currency]
    if (!entry || (entry.missingFrom && day >= entry.missingFrom)) return null
    return { rate: entry.rate, source: 'FRANKFURTER', carriedForward: entry.carried ?? false }
  }
const streams = (product: SkuStreams['product'], firstMile: SkuStreams['firstMile'] = [], other: SkuStreams['other'] = []): Map<string, SkuStreams> =>
  new Map([['SKU-A', { product, firstMile, other }]])
const cnyLayer = [{ date: '2026-09-01', unitCost: 72, currency: 'CNY', quantity: 100 }]

function run(over: Partial<AssembleInput> = {}, basis: ProfitBasis = 'ORDERED'): ProfitRow[] {
  return assembleProfit({
    basis,
    costing: 'FIFO',
    costingValid: true,
    range: { from: '2026-09-01', to: '2026-09-30' },
    today: '2026-10-23',
    sales: [sale()],
    fees: [],
    streams: new Map(),
    draftOnly: new Set(),
    fx: fx({ CNY: { rate: 7.2 } }),
    ads: new Map(),
    ...over,
  })
}
const skuRow = (rows: ProfitRow[], sku = 'SKU-A', day = DAY) => rows.find(row => row.sku === sku && row.profitDate === day)!
const storeRow = (rows: ProfitRow[], day = DAY) => rows.find(row => row.sku === STORE_LEVEL_SKU && row.profitDate === day)!

describe('下单口径：销售额来自订单，费用明细里的销售额不重复计', () => {
  const fees = [
    fee('NON_FEE', 'Principal', 200), // 订单口径下忽略，避免与订单销售额重复
    fee('NON_FEE', 'Tax', 16), // 税不计
    fee('COMMISSION', 'Commission', -30),
    fee('FULFILLMENT', 'FBAPerUnitFulfillmentFee', -40),
    fee('STORAGE', 'StorageFee', -3),
    fee('OTHER', 'Subscription', -1, { sku: '' }), // 没有 SKU：落到店铺级行
    fee('NON_FEE', 'PromotionDiscount', -5),
    fee('REFUND', 'Principal', -20, { mode: 'POSTED' }),
    fee('REFUND', 'Commission', 3, { mode: 'POSTED' }), // 退还的佣金冲回
    fee('REIMBURSEMENT', 'WarehouseDamage', 8, { mode: 'POSTED' }),
  ]

  it('每个利润桥项目落在对应列，SKU 行与店铺级行分开', () => {
    const rows = run({ fees, streams: streams(cnyLayer, [{ date: '2026-09-01', unitCost: 2, currency: 'USD', quantity: 100 }]) })
    const row = skuRow(rows)
    expect(row).toMatchObject({
      units: 10,
      costedUnits: 10,
      revenue: 200,
      refunds: 20,
      feeCommission: 27,
      feeFulfillment: 40,
      feeStorage: 3,
      promotion: 5,
      reimbursement: 8,
      basis: 'ORDERED',
      currency: 'USD',
    })
    // 采购成本：10 件 × 72 元 ÷ 7.2 = 100 美元；头程 10 × 2 = 20 美元
    expect(row).toMatchObject({ productCost: 100, firstMileCost: 20, costCoverage: 1 })
    // 利润 = 200 - 20 - (27 + 40 + 3) - 5 - 100 - 20 + 8 = -7
    expect(row.profit).toBe(-7)
    expect(row.flags).toEqual([])
    expect(storeRow(rows)).toMatchObject({ feeOther: 1, units: 0, revenue: 0 })
  })

  it('成本的原币金额、折算汇率、汇率来源都留在行上', () => {
    const row = skuRow(run({ fees, streams: streams(cnyLayer) }))
    expect(row).toMatchObject({ costCurrency: 'CNY', productCostOriginal: 720, fxRate: 7.2, fxSource: 'FRANKFURTER', fxFallback: false })
  })
})

describe('汇率：按交易日折算，缺失时回退并标记', () => {
  it('当天没有汇率沿用前值：照常折算，打“汇率沿用前值”标记与回退字段', () => {
    const row = skuRow(run({ fees: [fee('COMMISSION', 'Commission', -30)], streams: streams(cnyLayer), fx: fx({ CNY: { rate: 7.0, carried: true } }) }))
    expect(row.productCost).toBeCloseTo(102.857143, 5)
    expect(row.fxFallback).toBe(true)
    expect(row.flags).toContain('FX_FALLBACK')
  })

  it('超出回退范围（取不到汇率）：这部分成本不折算、不给利润，打“汇率缺失”，不用 0 或 1 顶替', () => {
    const row = skuRow(run({ streams: streams(cnyLayer), fx: fx({}) }))
    expect(row).toMatchObject({ costedUnits: 0, productCost: null, profit: null, costCoverage: 0 })
    expect(row.flags).toEqual(expect.arrayContaining(['FX_MISSING']))
  })

  it('汇率按每一天各自取：9 月 5 日有、9 月 6 日没有', () => {
    const rows = run({
      sales: [sale(), sale({ day: '2026-09-06', units: 5, revenue: 100 })],
      streams: streams(cnyLayer),
      fx: fx({ CNY: { rate: 7.2, missingFrom: '2026-09-06' } }),
    })
    expect(skuRow(rows, 'SKU-A', '2026-09-05').productCost).toBe(100)
    expect(skuRow(rows, 'SKU-A', '2026-09-06')).toMatchObject({ productCost: null, profit: null })
  })
})

describe('成本版本与存货计价', () => {
  it('没有生效的成本版本：不给利润并标“缺少成本”；只有草稿时标“成本仍是草稿”', () => {
    const missing = skuRow(run({}))
    expect(missing).toMatchObject({ productCost: null, profit: null, costedUnits: 0 })
    expect(missing.flags).toContain('COST_MISSING')
    const draft = skuRow(run({ draftOnly: new Set(['SKU-A']) }))
    expect(draft.flags).toContain('COST_DRAFT_ONLY')
    expect(draft.flags).not.toContain('COST_MISSING')
  })

  it('同一批销售，三种存货计价得到不同的采购成本（口径切换）', () => {
    const layers = [
      { date: '2026-09-01', unitCost: 10, currency: 'USD', quantity: 100 },
      { date: '2026-09-04', unitCost: 20, currency: 'USD', quantity: 100 },
    ]
    const sales = [sale({ day: '2026-09-02', units: 60, revenue: 600 }), sale({ day: '2026-09-05', units: 80, revenue: 800 })]
    const costOf = (costing: AssembleInput['costing']) =>
      run({ costing, sales, streams: streams(layers) })
        .filter(row => row.sku === 'SKU-A')
        .map(row => row.productCost)
    // 先进先出：60×10；旧批次剩 40 件，40×10 + 40×20 = 1200
    expect(costOf('FIFO')).toEqual([600, 1200])
    // 移动加权：9 月 2 日平均 10；9 月 5 日 (400 + 2000) ÷ 140 = 17.142857，80 件 = 1371.428571
    expect(costOf('MOVING_AVG')).toEqual([600, 1371.428571])
    // 月末加权：9 月全部入库平均 (1000 + 2000) ÷ 200 = 15，两天都按 15
    expect(costOf('MONTH_AVG')).toEqual([900, 1200])
  })

  it('批次不够：卖出超过入库数量，不给利润，标“成本批次不够”，覆盖率小于 1', () => {
    const row = skuRow(run({ streams: streams([{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 4 }]) }))
    expect(row).toMatchObject({ units: 10, costedUnits: 4, productCost: null, profit: null, costCoverage: 0.4 })
    expect(row.flags).toContain('COST_LAYERS_EXHAUSTED')
  })

  it('月末加权平均当月为暂估；存货计价设置无效时在店铺级行标记', () => {
    const rows = run({ costing: 'MONTH_AVG', today: '2026-09-20', costingValid: false, streams: streams([{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 100 }]) })
    expect(skuRow(rows).flags).toContain('COST_PROVISIONAL')
    expect(storeRow(rows).flags).toContain('COSTING_INVALID')
  })

  it('头程成本：没有头程批次或不够，利润里不含头程并标“头程成本缺失”，但仍给出利润', () => {
    const row = skuRow(run({ streams: streams([{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 100 }]) }))
    expect(row).toMatchObject({ productCost: 50, firstMileCost: null })
    expect(row.profit).toBe(150)
    expect(row.flags).toContain('FIRST_MILE_MISSING')
    const part = skuRow(run({ streams: streams([{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 100 }], [{ date: '2026-09-01', unitCost: 1, currency: 'USD', quantity: 4 }]) }))
    expect(part).toMatchObject({ firstMileCost: 4 })
    expect(part.flags).toContain('FIRST_MILE_MISSING')
  })

  it('其他成本：有批次或价格版本才有值；没有就是空（不是 0）', () => {
    const none = skuRow(run({ streams: streams([{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 100 }]) }))
    expect(none.otherCost).toBeNull()
    const some = skuRow(run({ streams: streams([{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 100 }], [], [{ date: '2026-09-01', unitCost: 0.5, currency: 'USD', quantity: null }]) }))
    expect(some.otherCost).toBe(5)
  })

  it('两个店铺同一天卖同一个 SKU：共用批次，每个店铺按自己的件数分到成本', () => {
    const rows = run({
      sales: [sale({ units: 6, revenue: 120 }), sale({ sellerAccountId: 'store-2', units: 4, revenue: 80 })],
      streams: streams([{ date: '2026-09-01', unitCost: 10, currency: 'USD', quantity: 100 }]),
    })
    const byStore = Object.fromEntries(rows.filter(row => row.sku === 'SKU-A').map(row => [row.sellerAccountId, row.productCost]))
    expect(byStore).toEqual({ 'store-1': 60, 'store-2': 40 })
  })
})

describe('结算释放口径：只认已释放的交易', () => {
  it('销售额来自已释放的销售额明细，递延中的明细不计入并标记；件数来自销售行', () => {
    const rows = run(
      {
        sales: [sale({ revenue: 0 })],
        fees: [
          fee('NON_FEE', 'Principal', 180, { mode: 'POSTED', status: 'DEFERRED_RELEASED' }),
          fee('NON_FEE', 'Principal', 999, { mode: 'POSTED', status: 'DEFERRED' }),
          fee('COMMISSION', 'Commission', -27, { mode: 'POSTED' }),
          fee('FULFILLMENT', 'x', -50, { mode: 'POSTED', status: 'DEFERRED' }),
        ],
        streams: streams([{ date: '2026-09-01', unitCost: 5, currency: 'USD', quantity: 100 }]),
      },
      'SETTLED',
    )
    expect(skuRow(rows)).toMatchObject({ basis: 'SETTLED', units: 10, revenue: 180, feeCommission: 27, feeFulfillment: 0, productCost: 50 })
    expect(storeRow(rows).flags).toContain('DEFERRED_EXCLUDED')
  })

  it('三种口径互相独立：同样的明细，下单口径不取费用明细里的销售额', () => {
    const fees = [fee('NON_FEE', 'Principal', 180, { mode: 'POSTED' })]
    expect(skuRow(run({ sales: [sale({ revenue: 200 })], fees }, 'ORDERED')).revenue).toBe(200)
    expect(skuRow(run({ sales: [sale({ revenue: 0 })], fees }, 'SETTLED')).revenue).toBe(180)
  })
})

describe('广告与数据质量标记', () => {
  const ads = (info: Partial<AdsInfo>): Map<string, AdsInfo> => new Map([[STORE, { first: null, last: null, byDay: new Map(), nonUsd: false, ...info }]])

  it('广告没有接入：店铺级行标“广告尚未接入”，广告列为空（不是 0）', () => {
    const row = storeRow(run({ fees: [fee('COMMISSION', 'Commission', -10)] }))
    expect(row.adsUnallocated).toBeNull()
    expect(row.flags).toContain('ADS_NOT_CONNECTED')
  })

  it('广告已接入：当天有销售的花费分摊到商品，店铺级行只留没分出去的部分；有记录的日期范围内没有花费的日子是 0；范围之外仍是尚未接入', () => {
    const info = ads({ first: '2026-09-01', last: '2026-09-10', byDay: new Map([[DAY, 12.5]]) })
    const rows = run({ ads: info, sales: [sale(), sale({ day: '2026-09-07', units: 1, revenue: 20 }), sale({ day: '2026-09-20', units: 1, revenue: 20 })] })
    expect(skuRow(rows)).toMatchObject({ adsSpendAllocated: 12.5, adsUnallocated: null })
    expect(storeRow(rows)).toMatchObject({ adsUnallocated: 0, adsSpendAllocated: null })
    expect(storeRow(rows).flags).not.toContain('ADS_UNALLOCATED')
    expect(skuRow(rows, 'SKU-A', '2026-09-07')).toMatchObject({ adsSpendAllocated: 0 })
    expect(storeRow(rows, '2026-09-07')).toMatchObject({ adsUnallocated: 0 })
    expect(storeRow(rows, '2026-09-20')).toMatchObject({ adsUnallocated: null })
    expect(storeRow(rows, '2026-09-20').flags).toContain('ADS_NOT_CONNECTED')
    // 范围之外的日子是“不知道”，SKU 行的广告列保持为空，不是 0
    expect(skuRow(rows, 'SKU-A', '2026-09-20').adsSpendAllocated).toBeNull()
  })

  it('只有广告花费的日子也有店铺级行；当天没有销售，花费留在店铺级行并标“广告未分摊”', () => {
    const rows = run({ sales: [], ads: ads({ first: '2026-09-01', last: '2026-09-30', byDay: new Map([['2026-09-12', 3]]) }) })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sku: STORE_LEVEL_SKU, profitDate: '2026-09-12', adsUnallocated: 3, profit: -3 })
  })

  it('有销售额但没有任何费用明细：标“费用未入账”；退款行与店铺级行不标', () => {
    const rows = run({ fees: [fee('REFUND', 'Principal', -5, { sku: 'SKU-B', mode: 'POSTED' })] })
    expect(skuRow(rows).flags).toContain('FEES_PENDING')
    expect(skuRow(rows, 'SKU-B').flags).not.toContain('FEES_PENDING')
    expect(storeRow(rows).flags).not.toContain('FEES_PENDING')
  })

  it('关联不到订单的费用按入账日计入并标记；缺 SKU 的订单行与非美元数据落在店铺级行并标记', () => {
    const rows = run({
      sales: [sale(), sale({ sku: '', units: 2, revenue: 30 }), sale({ currency: 'CAD', units: 9, revenue: 900 })],
      fees: [fee('COMMISSION', 'Commission', -4, { mode: 'UNLINKED' }), fee('FULFILLMENT', 'x', -9, { currency: 'CAD' })],
    })
    expect(skuRow(rows).flags).toContain('FEES_UNLINKED_ORDER')
    expect(skuRow(rows).units).toBe(10) // 加拿大元的订单行不计入
    expect(storeRow(rows)).toMatchObject({ units: 2, revenue: 30 })
    expect(storeRow(rows).flags).toEqual(expect.arrayContaining(['SKU_UNKNOWN', 'NON_USD_EXCLUDED']))
  })

  it('范围之外的日期不产出行（只用来接上批次消耗）；全部为空的行不写', () => {
    const rows = run({ sales: [sale({ day: '2026-08-20' }), sale({ day: '2026-10-05' })], streams: streams([{ date: '2026-08-01', unitCost: 1, currency: 'USD', quantity: 100 }]) })
    expect(rows).toEqual([])
    const only = run({ sales: [sale({ day: '2026-08-20', units: 30 }), sale()], streams: streams([{ date: '2026-08-01', unitCost: 1, currency: 'USD', quantity: 100 }]) })
    // 8 月卖掉的 30 件先消耗批次，9 月 5 日的 10 件用的是剩下的批次（FIFO 单价相同，数量够）
    expect(skuRow(only)).toMatchObject({ costedUnits: 10, productCost: 10 })
  })

  it('行按日期、店铺、SKU 排序，每行带指标版本需要的字段（口径、计价、币种）', () => {
    const rows = run({ sales: [sale({ day: '2026-09-07' }), sale(), sale({ sku: 'SKU-0' })] })
    expect(rows.map(row => `${row.profitDate}|${row.sku}`)).toEqual(['2026-09-05|SKU-0', '2026-09-05|SKU-A', '2026-09-05|__STORE__', '2026-09-07|SKU-A', '2026-09-07|__STORE__'])
    expect(rows[0]).toMatchObject({ basis: 'ORDERED', costing: 'FIFO', currency: 'USD' })
  })
})

describe('关税与利润项目字典（P6-18）', () => {
  it('关税按单件关税 × 件数折算，计入利润；没有关税批次时是空（不是 0）', () => {
    const duty = [{ date: '2026-09-01', unitCost: 1.5, currency: 'USD', quantity: 100 }]
    const withDuty = skuRow(run({ streams: new Map([['SKU-A', { product: cnyLayer, firstMile: [], other: [], duty }]]) }))
    expect(withDuty.dutyCost).toBe(15)
    // 200 - 100（采购）- 15（关税）
    expect(withDuty.profit).toBe(85)
    expect(skuRow(run({ streams: streams(cnyLayer) })).dutyCost).toBeNull()
  })

  it('有字典时按项目累计 itemAmounts：已映射记项目编号，未映射记 ~:目标；改映射不改净利润', () => {
    const fees = [fee('COMMISSION', 'Commission', -30), fee('STORAGE', 'StorageFee', -3)]
    const dictionary = (category: string) =>
      category === 'COMMISSION' ? { target: 'OTHER_FEES' as const, itemKey: 'item-1', mapped: true } : { target: 'STORAGE' as const, itemKey: '~:STORAGE', mapped: false }
    const plain = skuRow(run({ fees, streams: streams(cnyLayer) }))
    const mapped = skuRow(run({ fees, streams: streams(cnyLayer), dictionary }))
    expect(mapped.itemAmounts).toMatchObject({ 'item-1': -30, '~:STORAGE': -3 })
    expect(mapped.feeOther).toBe(30)
    expect(mapped.feeCommission ?? 0).toBe(0)
    expect(mapped.profit).toBe(plain.profit)
    expect(plain.itemAmounts ?? null).toBeNull()
  })
})
