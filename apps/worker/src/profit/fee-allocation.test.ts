import { STORE_LEVEL_SKU, type DictionaryResolution } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { assembleProfit, type AssembleInput, type ProfitRow } from './assemble'
import { EMPTY_ALLOCATION, createFeeAllocator, type AllocationInput } from './fee-allocation'
import type { FeeRow, SalesRow } from './types'

// 店铺级费用分摊（P6-19）：每种依据的权重、尾差、没有规则或没有权重时留在店铺级、按月切换规则、分摊后总利润不变。

const STORE = 'store-1'
const sale = (sku: string, units: number, revenue: number, day = '2026-09-05'): SalesRow => ({ sellerAccountId: STORE, sku, asin: `B-${sku}`, day, currency: 'USD', units, revenue })
const storeFee = (amount: number, over: Partial<FeeRow> = {}): FeeRow => ({
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
const FEE_ITEM = 'item-subscription'
const dictionary = (): DictionaryResolution => ({ target: 'OTHER_FEES', itemKey: FEE_ITEM, mapped: true })
const rule = (over: Partial<AllocationInput['rules'][number]> = {}): AllocationInput['rules'][number] => ({
  feeItemId: FEE_ITEM,
  basis: 'SALES_AMOUNT',
  manualWeights: null,
  effectiveMonth: '2026-09',
  ...over,
})
const allocation = (over: Partial<AllocationInput> = {}): AllocationInput => ({ ...EMPTY_ALLOCATION, rules: [rule()], ...over })

function run(over: Partial<AssembleInput> = {}): ProfitRow[] {
  return assembleProfit({
    basis: 'ORDERED',
    costing: 'FIFO',
    costingValid: true,
    range: { from: '2026-09-01', to: '2026-09-30' },
    today: '2026-10-23',
    sales: [sale('A', 10, 300), sale('B', 5, 100)],
    fees: [storeFee(-10)],
    streams: new Map(),
    draftOnly: new Set(),
    fx: () => ({ rate: 1, source: 'SAME_CURRENCY', carriedForward: false }),
    ads: new Map(),
    dictionary,
    allocation: allocation(),
    ...over,
  })
}
const feeOther = (rows: ProfitRow[], sku: string) => rows.filter(row => row.sku === sku).reduce((sum, row) => sum + row.feeOther, 0)
const total = (rows: ProfitRow[]) => Math.round(rows.reduce((sum, row) => sum + row.feeOther, 0) * 1e6) / 1e6
const profitSum = (rows: ProfitRow[]) => Math.round(rows.reduce((sum, row) => sum + (row.revenue - row.feeOther), 0) * 1e6) / 1e6

describe('店铺级费用分摊', () => {
  it('没有规则：店铺级费用留在店铺级行', () => {
    const rows = run({ allocation: EMPTY_ALLOCATION })
    expect(feeOther(rows, STORE_LEVEL_SKU)).toBe(10)
    expect(feeOther(rows, 'A')).toBe(0)
  })

  it('按销售额：当月销售额 300 : 100，10 美元分成 7.5 与 2.5；店铺级行不再留这笔', () => {
    const rows = run()
    expect(feeOther(rows, 'A')).toBe(7.5)
    expect(feeOther(rows, 'B')).toBe(2.5)
    expect(feeOther(rows, STORE_LEVEL_SKU)).toBe(0)
  })

  it('按销量：10 : 5', () => {
    const rows = run({ allocation: allocation({ rules: [rule({ basis: 'SALES_UNITS' })] }), fees: [storeFee(-9)] })
    expect(feeOther(rows, 'A')).toBe(6)
    expect(feeOther(rows, 'B')).toBe(3)
  })

  it('尾差记到占比最大的 SKU，分摊之和等于原始费用', () => {
    const rows = run({
      sales: [sale('A', 1, 100), sale('B', 1, 100), sale('C', 1, 200)],
      fees: [storeFee(-0.000007)],
    })
    expect(total(rows)).toBe(0.000007)
    // 7 个最小单位按 1:1:2 分：向下取整 1、1、3，尾差 2 记到占比最大的 C，得 5
    expect(feeOther(rows, 'C')).toBe(0.000005)
    expect(feeOther(rows, 'A')).toBe(0.000001)
  })

  it('货件签收量与移除订单：取外部权重；按月切换：规则生效月之前不分摊', () => {
    const shipment = new Map([
      [
        `${STORE}|2026-09`,
        new Map([
          ['A', 1],
          ['B', 3],
        ]),
      ],
    ])
    const removal = new Map([[`${STORE}|2026-09`, new Map([['B', 4]])]])
    const byShipment = run({ allocation: allocation({ rules: [rule({ basis: 'SHIPMENT_RECEIVED_UNITS' })], shipment }), fees: [storeFee(-8)] })
    expect(feeOther(byShipment, 'A')).toBe(2)
    expect(feeOther(byShipment, 'B')).toBe(6)
    const byRemoval = run({ allocation: allocation({ rules: [rule({ basis: 'REMOVAL_ORDER_SKU' })], removal }), fees: [storeFee(-8)] })
    expect(feeOther(byRemoval, 'B')).toBe(8)
    expect(feeOther(byRemoval, 'A')).toBe(0)
    const later = run({ allocation: allocation({ rules: [rule({ effectiveMonth: '2026-10' })] }) })
    expect(feeOther(later, STORE_LEVEL_SKU)).toBe(10)
  })

  it('手动比例：不看销售，销量为 0 的 SKU 也能分到；比例里的 SKU 没有销售会新增一行', () => {
    const rows = run({ allocation: allocation({ rules: [rule({ basis: 'MANUAL', manualWeights: { A: 1, Z: 1 } })] }) })
    expect(feeOther(rows, 'A')).toBe(5)
    expect(feeOther(rows, 'Z')).toBe(5)
    expect(feeOther(rows, 'B')).toBe(0)
  })

  it('当月没有任何权重：整笔留在店铺级，不丢失', () => {
    const rows = run({ sales: [], allocation: allocation({ rules: [rule({ basis: 'SHIPMENT_RECEIVED_UNITS' })] }) })
    expect(feeOther(rows, STORE_LEVEL_SKU)).toBe(10)
    expect(total(rows)).toBe(10)
  })

  it('分摊后净利润合计不变（对比不分摊）', () => {
    const plain = run({ allocation: EMPTY_ALLOCATION })
    for (const basis of ['SALES_AMOUNT', 'SALES_UNITS', 'MANUAL'] as const) {
      const rows = run({ allocation: allocation({ rules: [rule({ basis, manualWeights: basis === 'MANUAL' ? { A: 3, B: 1, C: 1 } : null })] }) })
      expect(profitSum(rows), basis).toBe(profitSum(plain))
      expect(total(rows), basis).toBe(total(plain))
    }
  })

  it('只分摊映射到规则费用项的店铺级费用；有 SKU 的费用与未映射的费用不动', () => {
    const rows = run({
      fees: [storeFee(-10), storeFee(-4, { sku: 'A' }), storeFee(-2, { subtype: 'Other' })],
      dictionary: (category, subtype) => (subtype === 'Other' ? { target: 'OTHER_FEES', itemKey: '~:OTHER_FEES', mapped: false } : dictionary()),
    })
    // A 自己的 4 + 分到的 7.5；未映射的 2 留在店铺级
    expect(feeOther(rows, 'A')).toBe(11.5)
    expect(feeOther(rows, STORE_LEVEL_SKU)).toBe(2)
  })

  it('分摊后的金额写进 itemAmounts（带符号贡献）', () => {
    const rows = run()
    expect(rows.find(row => row.sku === 'A' && row.profitDate === '2026-09-10')?.itemAmounts).toEqual({ [FEE_ITEM]: -7.5 })
  })
})

describe('createFeeAllocator', () => {
  it('结算释放口径订单销售额为 0 时，销售额依据退回按销量', () => {
    const allocate = createFeeAllocator(allocation(), [sale('A', 3, 0), sale('B', 1, 0)])
    const result = allocate(STORE, '2026-09-10', FEE_ITEM, -8)
    expect(result?.parts.map(part => [part.key, part.amount])).toEqual([
      ['A', -6],
      ['B', -2],
    ])
  })
  it('非美元销售不参与权重；没有规则返回 null', () => {
    const allocate = createFeeAllocator(allocation(), [{ ...sale('A', 3, 30), currency: 'EUR' }, sale('B', 1, 10)])
    expect(allocate(STORE, '2026-09-10', FEE_ITEM, -4)?.parts.map(part => part.key)).toEqual(['B'])
    expect(allocate(STORE, '2026-09-10', 'other-item', -4)).toBeNull()
    expect(createFeeAllocator(EMPTY_ALLOCATION, [])(STORE, '2026-09-10', FEE_ITEM, -4)).toBeNull()
  })
})
