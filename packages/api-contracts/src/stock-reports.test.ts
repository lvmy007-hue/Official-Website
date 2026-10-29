import { describe, expect, it } from 'vitest'
import {
  addAwCells,
  awTotalsOf,
  bucketsBetween,
  bucketStartOf,
  costVersionAt,
  daysInRange,
  emptyAwCells,
  landedUnitCost,
  movementFlowsOf,
  sellThroughOf,
  sumKnown,
  turnoverDaysOf,
} from './stock-reports.js'
import { AllWarehousesQuerySchema, MovementQuerySchema, SalesStatQuerySchema } from './stock-reports-query.js'

describe('分桶', () => {
  it('日、周、月三种粒度的桶起始日；周按业务口径的周起始日', () => {
    expect(bucketStartOf('2026-10-28', 'DAY', 'MON')).toBe('2026-10-28')
    expect(bucketStartOf('2026-10-28', 'WEEK', 'MON')).toBe('2026-10-26')
    expect(bucketStartOf('2026-10-28', 'WEEK', 'SUN')).toBe('2026-10-25')
    expect(bucketStartOf('2026-10-28', 'WEEK', 'SAT')).toBe('2026-10-24')
    expect(bucketStartOf('2026-10-28', 'MONTH', 'MON')).toBe('2026-10-01')
  })

  it('范围内的桶含首尾、升序、不重复；范围倒置为空', () => {
    expect(bucketsBetween('2026-10-01', '2026-10-03', 'DAY', 'MON')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(bucketsBetween('2026-10-01', '2026-10-14', 'WEEK', 'MON')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12'])
    expect(bucketsBetween('2026-08-20', '2026-10-02', 'MONTH', 'MON')).toEqual(['2026-08-01', '2026-09-01', '2026-10-01'])
    expect(bucketsBetween('2026-10-05', '2026-10-01', 'DAY', 'MON')).toEqual([])
    expect(daysInRange('2026-10-01', '2026-10-30')).toBe(30)
  })
})

describe('周转与合计', () => {
  it('周转天数 = 可用库存 ÷ 日均销量；没有库存或没有销量没有值', () => {
    expect(turnoverDaysOf(70, 30, 30)).toBe(70)
    expect(turnoverDaysOf(100, 7, 14)).toBe(200)
    expect(turnoverDaysOf(null, 30, 30)).toBeNull()
    expect(turnoverDaysOf(70, 0, 30)).toBeNull()
    expect(turnoverDaysOf(70, null, 30)).toBeNull()
    expect(turnoverDaysOf(0, 10, 30)).toBe(0)
  })

  it('合计只加有值的格，全空是 null，0 是 0', () => {
    expect(sumKnown([1, null, 2.5])).toBe(3.5)
    expect(sumKnown([null, undefined])).toBeNull()
    expect(sumKnown([0, null])).toBe(0)
  })
})

describe('跨仓总览合计', () => {
  it('已到仓与在途互斥，“仅展示”列不进合计', () => {
    const cells = { ...emptyAwCells(), fbaSellable: 10, fbaReserved: 2, awdOnhand: 5, fbaInbound: 7, firstMileTransit: 3, awdToFba: 99 }
    expect(awTotalsOf(cells)).toEqual({ onHand: 17, inTransit: 10, total: 27 })
  })

  it('只有在途有值时已到仓为 null，合计等于在途；全空合计为 null', () => {
    expect(awTotalsOf({ ...emptyAwCells(), firstMileTransit: 4 })).toEqual({ onHand: null, inTransit: 4, total: 4 })
    expect(awTotalsOf(emptyAwCells()).total).toBeNull()
  })

  it('累加单元格时空值不覆盖已有值', () => {
    const base = addAwCells(emptyAwCells(), { fbaSellable: 3 })
    expect(addAwCells(base, { fbaSellable: 4, fbaReserved: null }).fbaSellable).toBe(7)
    expect(addAwCells(base, { fbaReserved: null }).fbaReserved).toBeNull()
  })
})

describe('成本版本取价', () => {
  const versions = [
    { sku: 'A', versionNo: 1, effectiveFrom: '2026-01-01' },
    { sku: 'A', versionNo: 2, effectiveFrom: '2026-09-01' },
    { sku: 'A', versionNo: 3, effectiveFrom: '2026-09-01' },
  ]
  it('取生效日不晚于当天的最新一版，同一天取版本号大的', () => {
    expect(costVersionAt(versions, '2026-08-31')?.versionNo).toBe(1)
    expect(costVersionAt(versions, '2026-09-01')?.versionNo).toBe(3)
    expect(costVersionAt(versions, '2025-12-31')).toBeNull()
  })

  it('单件总成本四项相加，空项不计，全空是 null', () => {
    expect(landedUnitCost({ unitProductCost: 10, unitFirstMileCost: 2, unitDutyCost: null, unitOtherCost: 0.5 })).toBe(12.5)
    expect(landedUnitCost({ unitProductCost: null, unitFirstMileCost: null, unitDutyCost: null, unitOtherCost: null })).toBeNull()
  })
})

describe('进销存', () => {
  it('台账 11 类变动归并成 6 类，总和不变', () => {
    const flows = { receipts: 100, customerShipments: -60, customerReturns: 5, vendorReturns: -2, transfers: 3, found: 1, lost: -2, damaged: -1, disposed: -1, other: 4, unknownEvents: -1 }
    const grouped = movementFlowsOf(flows)
    expect(grouped).toEqual({ receipts: 100, shipments: -60, returns: 3, transfers: 3, adjustments: -3, other: 3 })
    expect(Object.values(grouped).reduce((a, b) => a + b, 0)).toBe(Object.values(flows).reduce((a, b) => a + b, 0))
  })

  it('存销比 = 期末 ÷ 发货件数；没有发货没有值', () => {
    expect(sellThroughOf(120, 60)).toBe(2)
    expect(sellThroughOf(120, 0)).toBeNull()
  })
})

describe('请求校验', () => {
  it('销量统计：默认按 ASIN、按日、销量、合计倒序；非法值给中文提示', () => {
    const parsed = SalesStatQuerySchema.parse({})
    expect(parsed).toMatchObject({ dimension: 'asin', granularity: 'DAY', metric: 'units', page: 1, sort: { field: 'total', dir: 'desc' } })
    const bad = SalesStatQuerySchema.safeParse({ dimension: 'brand' })
    expect(bad.success).toBe(false)
    expect(SalesStatQuerySchema.safeParse({ sort: 'sessions:asc' }).success).toBe(false)
    expect(SalesStatQuerySchema.parse({ from: '2026-10-01', sort: 'title:asc' }).sort).toEqual({ field: 'title', dir: 'asc' })
  })

  it('跨仓与进销存：排序白名单；unbalanced 只认 true', () => {
    expect(AllWarehousesQuerySchema.parse({ sort: 'sku:asc', q: ' ab ' })).toMatchObject({ q: 'ab', sort: { field: 'sku', dir: 'asc' } })
    expect(AllWarehousesQuerySchema.safeParse({ sort: 'value:asc' }).success).toBe(false)
    expect(MovementQuerySchema.parse({ unbalanced: 'true' }).unbalanced).toBe(true)
    expect(MovementQuerySchema.parse({}).unbalanced).toBe(false)
    expect(MovementQuerySchema.safeParse({ unbalanced: 'yes' }).success).toBe(false)
  })
})
