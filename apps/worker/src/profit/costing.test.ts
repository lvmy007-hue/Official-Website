import { describe, expect, it } from 'vitest'
import { consumeStream, type CostLayer } from './costing'

// 存货计价（P2b-09）：先进先出、移动加权平均、月末加权平均，以及价格版本、批次用完、币种混用。

const layer = (date: string, unitCost: number, quantity: number | null, currency = 'CNY'): CostLayer => ({ date, unitCost, quantity, currency })
const sales = (entries: Record<string, number>) => new Map(Object.entries(entries))
const TODAY = '2026-10-23'
const cost = (pieces: Array<{ qty: number; unitCost: number }>) => pieces.reduce((sum, piece) => sum + piece.qty * piece.unitCost, 0)

// 两批入库：1 日 100 件 @10，10 日 100 件 @20
const layers = [layer('2026-09-01', 10, 100), layer('2026-09-10', 20, 100)]

describe('先进先出', () => {
  it('先卖旧批次，跨批次时拆成两段；入库当天可供当天销售', () => {
    const result = consumeStream('FIFO', layers, sales({ '2026-09-05': 60, '2026-09-12': 80, '2026-09-10': 10 }), TODAY)
    expect(result.get('2026-09-05')!.pieces).toEqual([{ qty: 60, unitCost: 10, currency: 'CNY' }])
    // 9 月 10 日：旧批次还剩 40，先用旧的 10 件
    expect(result.get('2026-09-10')!.pieces).toEqual([{ qty: 10, unitCost: 10, currency: 'CNY' }])
    // 9 月 12 日：旧批次剩 30，再用新批次 50
    expect(result.get('2026-09-12')!.pieces).toEqual([
      { qty: 30, unitCost: 10, currency: 'CNY' },
      { qty: 50, unitCost: 20, currency: 'CNY' },
    ])
    expect([...result.values()].every(day => day.uncovered === 0)).toBe(true)
  })

  it('卖出超过已入库的数量：超出部分没有成本，并说明是“批次用完”', () => {
    const result = consumeStream('FIFO', [layer('2026-09-01', 10, 30)], sales({ '2026-09-02': 50 }), TODAY)
    expect(result.get('2026-09-02')).toMatchObject({ uncovered: 20, exhausted: true, pieces: [{ qty: 30, unitCost: 10, currency: 'CNY' }] })
  })

  it('入库之前卖出的件数没有成本，并且不是“批次用完”（压根还没有批次）', () => {
    const result = consumeStream('FIFO', [layer('2026-09-10', 10, 30)], sales({ '2026-09-02': 5, '2026-09-11': 10 }), TODAY)
    expect(result.get('2026-09-02')).toMatchObject({ uncovered: 5, exhausted: false, pieces: [] })
    expect(result.get('2026-09-11')).toMatchObject({ uncovered: 0, pieces: [{ qty: 10, unitCost: 10, currency: 'CNY' }] })
  })

  it('历史消耗会接上：范围之前卖掉的件数先消耗旧批次，之后的销售用的是剩下的', () => {
    const result = consumeStream('FIFO', layers, sales({ '2026-09-02': 100, '2026-09-20': 20 }), TODAY)
    expect(result.get('2026-09-20')!.pieces).toEqual([{ qty: 20, unitCost: 20, currency: 'CNY' }])
  })

  it('不同币种的批次各按各的币种给出，不混在一起平均', () => {
    const mixed = [layer('2026-09-01', 10, 5, 'CNY'), layer('2026-09-02', 2, 5, 'USD')]
    const result = consumeStream('FIFO', mixed, sales({ '2026-09-03': 8 }), TODAY)
    expect(result.get('2026-09-03')!.pieces).toEqual([
      { qty: 5, unitCost: 10, currency: 'CNY' },
      { qty: 3, unitCost: 2, currency: 'USD' },
    ])
  })
})

describe('移动加权平均', () => {
  it('每次入库后重算平均；卖出按当时平均，不影响平均本身', () => {
    // 9 月 5 日只有 100 件 @10；卖 50 → 平均 10，剩 50 件（价值 500）
    // 9 月 12 日入库 100 件 @20 后：(500 + 2000) / 150 = 16.666…；卖 30
    const result = consumeStream('MOVING_AVG', layers, sales({ '2026-09-05': 50, '2026-09-12': 30 }), TODAY)
    expect(result.get('2026-09-05')!.pieces).toEqual([{ qty: 50, unitCost: 10, currency: 'CNY' }])
    const second = result.get('2026-09-12')!.pieces[0]!
    expect(second.qty).toBe(30)
    expect(second.unitCost).toBeCloseTo(16.666667, 5)
  })

  it('卖出超过现有数量：超出部分没有成本；币种不同的批次不计入并标记', () => {
    const result = consumeStream('MOVING_AVG', [layer('2026-09-01', 10, 10, 'CNY'), layer('2026-09-02', 3, 100, 'USD')], sales({ '2026-09-03': 15 }), TODAY)
    expect(result.get('2026-09-03')).toMatchObject({ uncovered: 5, exhausted: true, mixedCurrency: true, pieces: [{ qty: 10, unitCost: 10, currency: 'CNY' }] })
  })
})

describe('月末加权平均', () => {
  it('整个月用同一个平均：包含当月全部入库，月初的销售也用它', () => {
    // 9 月：100 @10 + 100 @20 → 平均 15；9 月 5 日（第二批入库之前）卖 40 也按 15
    const result = consumeStream('MONTH_AVG', layers, sales({ '2026-09-05': 40, '2026-09-25': 60 }), TODAY)
    expect(result.get('2026-09-05')!.pieces).toEqual([{ qty: 40, unitCost: 15, currency: 'CNY' }])
    expect(result.get('2026-09-25')!.pieces).toEqual([{ qty: 60, unitCost: 15, currency: 'CNY' }])
  })

  it('结存带入下个月：期初数量与价值与当月入库一起平均', () => {
    // 9 月卖 100 → 结存 100 件（价值 1500）；10 月 3 日入库 100 @30 → 平均 (1500 + 3000) / 200 = 22.5
    const result = consumeStream('MONTH_AVG', [...layers, layer('2026-10-03', 30, 100)], sales({ '2026-09-20': 100, '2026-10-10': 50 }), TODAY)
    expect(result.get('2026-10-10')!.pieces).toEqual([{ qty: 50, unitCost: 22.5, currency: 'CNY' }])
  })

  it('当月还没过完时标为暂估，过完的月份不是', () => {
    const result = consumeStream('MONTH_AVG', layers, sales({ '2026-09-05': 10, '2026-10-05': 10 }), TODAY)
    expect(result.get('2026-09-05')!.provisional).toBe(false)
    expect(result.get('2026-10-05')!.provisional).toBe(true)
  })

  it('当月入库与销售合计不够：超出部分没有成本', () => {
    const result = consumeStream('MONTH_AVG', [layer('2026-09-01', 10, 20)], sales({ '2026-09-02': 15, '2026-09-03': 15 }), TODAY)
    expect(result.get('2026-09-02')!.uncovered).toBe(0)
    expect(result.get('2026-09-03')).toMatchObject({ uncovered: 10, exhausted: true })
  })
})

describe('价格版本与批次并存', () => {
  const prices = [layer('2026-09-01', 8, null), layer('2026-09-15', 9, null)]

  it('只有价格版本（没有数量）：当天适用生效日不晚于当天的最新一条，三种计价结果一样', () => {
    for (const method of ['FIFO', 'MOVING_AVG', 'MONTH_AVG'] as const) {
      const result = consumeStream(method, prices, sales({ '2026-09-10': 5, '2026-09-20': 7, '2026-08-30': 2 }), TODAY)
      expect(result.get('2026-09-10')!.pieces).toEqual([{ qty: 5, unitCost: 8, currency: 'CNY' }])
      expect(result.get('2026-09-20')!.pieces).toEqual([{ qty: 7, unitCost: 9, currency: 'CNY' }])
      // 第一个版本生效之前卖出的没有成本
      expect(result.get('2026-08-30')).toMatchObject({ uncovered: 2, pieces: [] })
    }
  })

  it('同时有入库批次与价格版本时只用入库批次', () => {
    const result = consumeStream('FIFO', [...prices, layer('2026-09-01', 10, 100)], sales({ '2026-09-02': 5 }), TODAY)
    expect(result.get('2026-09-02')!.pieces).toEqual([{ qty: 5, unitCost: 10, currency: 'CNY' }])
  })

  it('数量为 0 的批次不参与；没有销售就没有结果', () => {
    expect(consumeStream('FIFO', [layer('2026-09-01', 10, 0)], sales({ '2026-09-02': 3 }), TODAY).get('2026-09-02')).toMatchObject({ uncovered: 3, pieces: [] })
    expect(consumeStream('FIFO', layers, sales({}), TODAY).size).toBe(0)
    expect(consumeStream('FIFO', layers, sales({ '2026-09-02': 0 }), TODAY).size).toBe(0)
  })

  it('三种计价算同一批销售，总成本不同（口径切换有实际影响）', () => {
    const input = sales({ '2026-09-05': 50, '2026-09-12': 80 })
    const total = (method: 'FIFO' | 'MOVING_AVG' | 'MONTH_AVG') => [...consumeStream(method, layers, input, TODAY).values()].reduce((sum, day) => sum + cost(day.pieces), 0)
    // 先进先出：50×10 + (50×10 + 30×20) = 500 + 1100 = 1600
    expect(total('FIFO')).toBeCloseTo(1600, 4)
    // 移动加权：500 + 80 × (500 + 2000) / 150 = 500 + 1333.33
    expect(total('MOVING_AVG')).toBeCloseTo(1833.3333, 3)
    // 月末加权：130 × 15 = 1950
    expect(total('MONTH_AVG')).toBeCloseTo(1950, 4)
  })
})
