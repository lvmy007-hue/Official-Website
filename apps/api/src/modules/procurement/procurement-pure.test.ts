import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { costDraftsOf } from './cost-drafts'
import { costDiffOf, deliveryDeviation } from './po-hints'
import { orderRowOf, totalOf } from './po-rows'
import { computeSupplierMetrics, supplierTrend } from './supplier-metrics'
import { summarizeStock } from './warehouse-math'

const d = (text: string) => new Date(`${text}T00:00:00.000Z`)
const dec = (value: string | number) => new Prisma.Decimal(value)

describe('供应商表现指标', () => {
  it('不足 3 张已完成采购单时不评级，也不返回 0', () => {
    const metrics = computeSupplierMetrics([{ expectedDate: d('2026-01-10'), orderedAt: d('2026-01-01'), completedAt: d('2026-01-09') }], [])
    expect(metrics.completedOrders).toBe(1)
    expect(metrics.rating).toBeNull()
    expect(metrics.qualityPassRate).toBeNull()
    expect(metrics.onTimeRate).toBe(1)
  })

  it('准时率按“完成日 ≤ 预计到货日”计，没有预计到货日的单不参与', () => {
    const metrics = computeSupplierMetrics(
      [
        { expectedDate: d('2026-01-10'), orderedAt: d('2026-01-01'), completedAt: d('2026-01-10') },
        { expectedDate: d('2026-02-10'), orderedAt: d('2026-02-01'), completedAt: d('2026-02-12') },
        { expectedDate: null, orderedAt: d('2026-03-01'), completedAt: d('2026-03-05') },
        { expectedDate: d('2026-04-10'), orderedAt: d('2026-04-01'), completedAt: null },
      ],
      [{ sampleQty: 100, defectQty: 4 }],
    )
    expect(metrics.completedOrders).toBe(3)
    expect(metrics.onTimeRate).toBeCloseTo(0.5)
    expect(metrics.qualityPassRate).toBeCloseTo(0.96)
    expect(metrics.avgLeadDays).toBe(Math.round((9 + 11 + 4) / 3))
  })

  it('没有任何已完成的单，趋势为空', () => {
    expect(supplierTrend([{ expectedDate: null, orderedAt: null, completedAt: null }])).toEqual([])
  })

  it('趋势按完成月份升序汇总', () => {
    const trend = supplierTrend([
      { expectedDate: d('2026-02-10'), orderedAt: d('2026-02-01'), completedAt: d('2026-02-12') },
      { expectedDate: d('2026-01-10'), orderedAt: d('2026-01-01'), completedAt: d('2026-01-09') },
    ])
    expect(trend.map(point => point.month)).toEqual(['2026-01', '2026-02'])
    expect(trend[0].onTimeRate).toBe(1)
    expect(trend[1].onTimeRate).toBe(0)
  })
})

describe('国内仓库存汇总与计价', () => {
  const now = d('2026-03-01')
  const move = (at: string, quantity: number, unitCost: number | null, currency: string | null = 'CNY', lockedForShipment = 0) => ({
    occurredAt: d(at),
    quantity,
    unitCost,
    currency,
    lockedForShipment,
  })

  it('在库、占用、可用与库龄', () => {
    const summary = summarizeStock([move('2026-01-01', 100, 10), move('2026-02-01', -30, null, null), move('2026-02-10', 0, null, null, 20)], 'FIFO', now)
    expect(summary).toMatchObject({ onHand: 70, locked: 20, available: 50, ageDays: 59 })
  })

  it('先进先出：出库冲减最早批次，库龄取剩余最早批次', () => {
    const summary = summarizeStock([move('2026-01-01', 10, 10), move('2026-02-01', 10, 20), move('2026-02-05', -15, null, null)], 'FIFO', now)
    expect(summary.value).toBe(100)
    expect(summary.ageDays).toBe(28)
    expect(summary.unitCost).toBe(20)
  })

  it('移动加权平均：在库数量 × 滚动平均成本', () => {
    const summary = summarizeStock([move('2026-01-01', 10, 10), move('2026-02-01', 10, 20), move('2026-02-05', -10, null, null)], 'WEIGHTED_AVERAGE', now)
    expect(summary.onHand).toBe(10)
    expect(summary.value).toBe(150)
    expect(summary.currency).toBe('CNY')
  })

  it('缺入库成本、币种混杂、库存为负时货值为 null 并说明原因', () => {
    expect(summarizeStock([move('2026-01-01', 10, null, null)], 'FIFO', now)).toMatchObject({ value: null, valueNote: expect.stringContaining('没有入库成本') })
    expect(summarizeStock([move('2026-01-01', 10, 10, 'CNY'), move('2026-01-02', 10, 2, 'USD')], 'FIFO', now)).toMatchObject({ value: null, valueNote: expect.stringContaining('币种') })
    expect(summarizeStock([move('2026-01-01', -5, null, null)], 'FIFO', now)).toMatchObject({ onHand: -5, value: null, valueNote: expect.stringContaining('为负') })
  })

  it('没有任何流水时全部为 0，库龄为 null', () => {
    expect(summarizeStock([], 'FIFO', now)).toMatchObject({ onHand: 0, available: 0, ageDays: null })
  })
})

describe('成本版本草稿', () => {
  it('按 SKU 用已收数量加权平均采购单价；没有单价或没收到的行不生成', () => {
    const drafts = costDraftsOf([
      { sellerSku: 'A', receivedQuantity: 10, unitCost: dec(2), currency: 'CNY' },
      { sellerSku: 'A', receivedQuantity: 30, unitCost: dec(4), currency: 'CNY' },
      { sellerSku: 'B', receivedQuantity: 0, unitCost: dec(5), currency: 'CNY' },
      { sellerSku: 'C', receivedQuantity: 5, unitCost: null, currency: 'CNY' },
    ])
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ sku: 'A', currency: 'CNY' })
    expect(drafts[0].unitProductCost.toString()).toBe('3.5')
  })
})

describe('交期偏差与成本差异', () => {
  const needBy = [
    { sku: 'A', needByDate: d('2026-03-01'), batchNo: 'B1' },
    { sku: 'B', needByDate: d('2026-03-10'), batchNo: 'B1' },
  ]

  it('预计到货日晚于需要日期时给出最严重的一条', () => {
    expect(deliveryDeviation({ status: 'ORDERED', expectedDate: d('2026-03-08') }, needBy)).toMatchObject({ sku: 'A', lateDays: 7, needByDate: '2026-03-01' })
  })

  it('已到齐、关闭、取消、没有预计到货日或没有关联补货建议时不提醒', () => {
    expect(deliveryDeviation({ status: 'RECEIVED', expectedDate: d('2026-03-20') }, needBy)).toBeNull()
    expect(deliveryDeviation({ status: 'CANCELLED', expectedDate: d('2026-03-20') }, needBy)).toBeNull()
    expect(deliveryDeviation({ status: 'ORDERED', expectedDate: null }, needBy)).toBeNull()
    expect(deliveryDeviation({ status: 'ORDERED', expectedDate: d('2026-03-20') }, [])).toBeNull()
    expect(deliveryDeviation({ status: 'ORDERED', expectedDate: d('2026-02-20') }, needBy)).toBeNull()
  })

  it('成本差异：相同不提示、没有生效成本不提示、币种不同标为不可比较', () => {
    const current = { unitProductCost: dec(10), currency: 'CNY' }
    expect(costDiffOf(dec(10), current, 'CNY')).toBeNull()
    expect(costDiffOf(dec(12), undefined, 'CNY')).toBeNull()
    expect(costDiffOf(null, current, 'CNY')).toBeNull()
    expect(costDiffOf(dec(12), current, 'CNY')).toMatchObject({ comparable: true, ratio: 0.2 })
    expect(costDiffOf(dec(12), current, 'USD')).toMatchObject({ comparable: false, ratio: null })
  })
})

describe('采购单合计', () => {
  it('任何一行没有单价，合计为 null 而不是 0', () => {
    expect(totalOf([{ quantity: 2, unitCost: 3 }, { quantity: 1 }])).toBeNull()
    expect(
      totalOf([
        { quantity: 2, unitCost: 3 },
        { quantity: 1, unitCost: 1.5 },
      ])?.toString(),
    ).toBe('7.5')
  })

  it('已付金额只统计已付款的记录', () => {
    const row = orderRowOf(
      {
        id: 'o1',
        tenantId: 't',
        number: 'PO-1',
        supplierId: 's',
        status: 'ORDERED',
        currency: 'CNY',
        totalAmount: dec(100),
        expectedDate: null,
        supplier: { id: 's', name: '供应商', code: 'S1' },
        lines: [{ quantity: 10, receivedQuantity: 4 }],
        payments: [
          { amount: dec(30), status: 'PAID' },
          { amount: dec(20), status: 'PLANNED' },
        ],
        version: 1,
        approvalStatus: 'APPROVED',
        paymentStatus: 'PARTIAL',
        createdAt: d('2026-01-01'),
      } as unknown as Parameters<typeof orderRowOf>[0],
      null,
    )
    expect(row.paidAmount).toBe('30')
    expect(row.receivedQty).toBe(4)
    expect(row.receiveRatio).toBeCloseTo(0.4)
  })
})
