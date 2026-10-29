import { describe, expect, it } from 'vitest'
import {
  attributionOf,
  cardsOf,
  coverageOf,
  defaultRangeFor,
  figuresOf,
  funnelOf,
  monthStartOf,
  pointsOf,
  preferredRows,
  readFromOf,
  splitOf,
  weekStartSunday,
  type BrRow,
} from './business-reports-math'

// 业务报告纯计算（P4-02）：来源取舍、空值不当 0、比率口径、归因乘积、广告拆分、周与月的日期边界。

const row = (over: Partial<BrRow> = {}): BrRow => ({
  sellerAccountId: 's1',
  date: '2026-10-01',
  source: 'DATA_KIOSK',
  orderedSales: 100,
  unitsOrdered: 10,
  ordersCount: 8,
  sessions: 200,
  pageViews: 400,
  buyBoxPct: 0.9,
  unitSessionPct: 0.05,
  unitsRefunded: 1,
  ...over,
})

describe('来源取舍', () => {
  it('同店同日两个来源都有只用数据中心，不逐列混合；只有报告时用报告', () => {
    const rows = preferredRows([row({ source: 'REPORT', orderedSales: 90 }), row({ source: 'DATA_KIOSK', orderedSales: 100 }), row({ date: '2026-10-02', source: 'REPORT', orderedSales: 50 })])
    expect(rows.map(item => [item.date, item.source, item.orderedSales])).toEqual([
      ['2026-10-01', 'DATA_KIOSK', 100],
      ['2026-10-02', 'REPORT', 50],
    ])
  })

  it('不同店铺同一天各算各的', () => {
    expect(preferredRows([row(), row({ sellerAccountId: 's2' })])).toHaveLength(2)
  })
})

describe('合计与比率', () => {
  it('没有行：全部为空，不是 0', () => {
    expect(Object.values(figuresOf([])).every(value => value === null)).toBe(true)
  })

  it('空值不当 0：只加有值的行；整列都没有值才是空', () => {
    const figures = figuresOf([row({ sessions: null, pageViews: null, unitsRefunded: null }), row({ date: '2026-10-02', sessions: 300, pageViews: null, unitsRefunded: null })])
    expect(figures.sessions).toBe(300)
    expect(figures.pageViews).toBeNull()
    expect(figures.unitsRefunded).toBeNull()
    expect(figures.refundRate).toBeNull()
    expect(figures.orderedSales).toBe(200)
  })

  it('转化率、件单价、退款率只用同一行分子分母都有值的行相除', () => {
    const figures = figuresOf([row(), row({ date: '2026-10-02', sessions: null, orderedSales: 1000, unitsOrdered: 10, unitsRefunded: 3 })])
    expect(figures.unitSessionPct).toBe(0.05)
    expect(figures.avgPrice).toBe(55)
    expect(figures.refundRate).toBe(0.2)
  })

  it('没有会话时转化率退回官方值的平均；分母为 0 时比率为空', () => {
    expect(figuresOf([row({ sessions: null, unitSessionPct: 0.04 }), row({ date: '2026-10-02', sessions: null, unitSessionPct: 0.06 })]).unitSessionPct).toBe(0.05)
    expect(figuresOf([row({ unitsOrdered: 0, unitsRefunded: 0 })]).avgPrice).toBeNull()
    expect(figuresOf([row({ unitsOrdered: 0, unitsRefunded: 0 })]).refundRate).toBeNull()
  })

  it('购物车获得率按页面浏览量加权', () => {
    const figures = figuresOf([row({ buyBoxPct: 1, pageViews: 100 }), row({ date: '2026-10-02', buyBoxPct: 0.5, pageViews: 300 })])
    expect(figures.buyBoxPct).toBe(0.625)
  })
})

describe('逐日点', () => {
  it('给了 days 就补齐：没有记录的日子各项为空、来源为空；两个来源同日都用到标混合', () => {
    const points = pointsOf([row()], ['2026-09-30', '2026-10-01', '2026-10-02'])
    expect(points.map(point => [point.date, point.source, point.orderedSales])).toEqual([
      ['2026-09-30', null, null],
      ['2026-10-01', 'DATA_KIOSK', 100],
      ['2026-10-02', null, null],
    ])
    expect(pointsOf([row({ sellerAccountId: 's1' }), row({ sellerAccountId: 's2', source: 'REPORT' })])[0]!.source).toBe('MIXED')
  })

  it('不给 days 只返回有记录的日期并按日期排序', () => {
    expect(pointsOf([row({ date: '2026-10-03' }), row({ date: '2026-10-01' })]).map(point => point.date)).toEqual(['2026-10-01', '2026-10-03'])
  })

  it('覆盖：几天有数据、几天只有报告', () => {
    const points = pointsOf([row(), row({ date: '2026-10-02', source: 'REPORT' })], ['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(coverageOf(points)).toEqual({ days: 3, withData: 2, reportOnly: 1 })
  })
})

describe('指标卡、漏斗', () => {
  it('金额类用变化比率，百分比类用百分点差；没有对比期变化为空', () => {
    const current = figuresOf([row({ orderedSales: 120, unitSessionPct: 0.06, unitsOrdered: 12, sessions: 200 })])
    const previous = figuresOf([row()])
    const cards = cardsOf(current, previous)
    const sales = cards.find(card => card.key === 'orderedSales')!
    expect(sales).toMatchObject({ value: 120, compareValue: 100, changeKind: 'ratio' })
    expect(sales.change).toBeCloseTo(0.2, 6)
    expect(cards.find(card => card.key === 'unitSessionPct')!.changeKind).toBe('points')
    expect(cardsOf(current, null).every(card => card.compareValue === null && card.change === null)).toBe(true)
  })

  it('漏斗每一步写相对上一步的比值，缺任何一边就没有比值', () => {
    const steps = funnelOf(figuresOf([row()]))
    expect(steps.map(step => step.rate)).toEqual([null, 2, 0.02, 1.25])
    expect(funnelOf(figuresOf([row({ sessions: null })]))[1]!.rate).toBeNull()
  })
})

describe('归因', () => {
  it('三个因子相乘等于销售额', () => {
    const { attribution } = attributionOf(figuresOf([row({ orderedSales: 150, unitsOrdered: 15, sessions: 300 })]), figuresOf([row()]))
    expect(attribution?.mode).toBe('THREE_FACTOR')
    for (const [factors, sales] of [
      [attribution!.factors.map(factor => factor.after), attribution!.sales.after],
      [attribution!.factors.map(factor => factor.before), attribution!.sales.before],
    ] as const) {
      expect(factors.reduce((product, value) => product * value, 1)).toBeCloseTo(sales, 6)
    }
  })

  it('没有对比期、缺会话或销售额为 0 时不归因并给原因', () => {
    const figures = figuresOf([row()])
    expect(attributionOf(figures, null)).toMatchObject({ attribution: null, note: expect.stringContaining('没有选择对比期') })
    expect(attributionOf(figures, figuresOf([row({ sessions: null })]))).toMatchObject({ attribution: null, note: expect.stringContaining('不用 0 补') })
    expect(attributionOf(figuresOf([row({ orderedSales: 0 })]), figures).attribution).toBeNull()
  })
})

describe('广告拆分', () => {
  it('自然销售 = 订购销售额 − 广告销售额', () => {
    expect(splitOf(1000, 250)).toEqual({ state: 'OK', note: null, adsSales: 250, organicSales: 750, adsShare: 0.25 })
  })

  it('没有广告销售额或订购销售额不拆；广告大于订购标口径不符，不夹成 0', () => {
    expect(splitOf(1000, null)).toMatchObject({ state: 'NO_DATA', organicSales: null })
    expect(splitOf(null, 100)).toMatchObject({ state: 'NO_DATA', adsSales: 100, organicSales: null })
    expect(splitOf(100, 120)).toMatchObject({ state: 'MISMATCH', organicSales: null, adsShare: null })
  })
})

describe('日期', () => {
  it('周从周日开始、月从 1 号开始', () => {
    expect(weekStartSunday('2026-10-24')).toBe('2026-10-18')
    expect(weekStartSunday('2026-10-18')).toBe('2026-10-18')
    expect(monthStartOf('2026-10-24')).toBe('2026-10-01')
  })

  it('默认范围：日 30 天、周 12 周、月 12 个月；读数据的起点退到包含起点的周或月', () => {
    expect(defaultRangeFor('DAY', '2026-10-24')).toEqual({ from: '2026-09-25', to: '2026-10-24' })
    expect(defaultRangeFor('WEEK', '2026-10-24')).toEqual({ from: '2026-08-02', to: '2026-10-24' })
    expect(defaultRangeFor('MONTH', '2026-10-24')).toEqual({ from: '2025-11-01', to: '2026-10-24' })
    expect(readFromOf('DAY', '2026-10-24')).toBe('2026-10-24')
    expect(readFromOf('WEEK', '2026-10-24')).toBe('2026-10-18')
    expect(readFromOf('MONTH', '2026-10-24')).toBe('2026-10-01')
  })
})
