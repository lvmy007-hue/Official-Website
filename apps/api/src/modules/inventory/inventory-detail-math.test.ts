import { describe, expect, it } from 'vitest'
import { forecastSeries, ledgerReferenceKind, pickStructure, snapshotValues, structurePoints, type DailyRow } from './inventory-detail-math'
import { quantityOf } from './inventory-detail.service'
import { demand, TODAY } from './inventory-fixtures.test-helper'

const daily = (date: string, source: string, over: Partial<DailyRow> = {}): DailyRow => ({
  snapshotDate: new Date(`${date}T00:00:00Z`),
  source,
  sellable: null,
  inbound: null,
  reserved: null,
  unsellable: null,
  researching: null,
  ...over,
})

describe('库存结构：同一天多个来源取优先级最高的整行，不相加', () => {
  it('接口 > 未抑制报告 > 全部报告 > 亚马逊物流报告', () => {
    const rows = [daily('2026-10-20', 'AFN', { sellable: 1 }), daily('2026-10-20', 'MYI_ALL', { sellable: 2 }), daily('2026-10-20', 'API', { sellable: 9, inbound: 3 })]
    expect(pickStructure(rows)).toMatchObject({ source: 'API', sellable: 9, inbound: 3 })
    expect(pickStructure(rows.slice(0, 2))).toMatchObject({ source: 'MYI_ALL', sellable: 2 })
  })

  it('优先来源整行没有数量时跳到下一个来源；预留缺失时用预留库存报告补', () => {
    const rows = [daily('2026-10-20', 'API'), daily('2026-10-20', 'AFN', { sellable: 4 }), daily('2026-10-20', 'RESERVED', { reserved: 7 })]
    expect(pickStructure(rows)).toMatchObject({ source: 'AFN', sellable: 4, reserved: 7 })
  })

  it('只有预留或滞留来源时不产生结构点；按日期升序', () => {
    const points = structurePoints([daily('2026-10-21', 'API', { sellable: 2 }), daily('2026-10-19', 'STRANDED'), daily('2026-10-20', 'API', { sellable: 1 })])
    expect(points.map(point => point.date)).toEqual(['2026-10-20', '2026-10-21'])
  })
})

describe('历史快照字段', () => {
  it('缺少的来源整组为 null，不是 0', () => {
    const values = snapshotValues([], null, null)
    expect(Object.values(values).every(value => value === null)).toBe(true)
  })

  it('合并库存数量、规划报告与库龄列', () => {
    const values = snapshotValues(
      [daily('2026-10-20', 'API', { sellable: 5, inbound: 2 })],
      { unitsShippedT30: 90, daysOfSupply: { toString: () => '12.5' }, estimatedStorageCostNextMonth: null },
      { age0to90: 5, age91to180: null, age181to270: 0, age271to365: null, age365plus: null, ageSurchargeEstimate: { toString: () => '1.2' } },
    )
    expect(values).toMatchObject({
      sellable: 5,
      inbound: 2,
      source: 'API',
      unitsShippedT30: 90,
      daysOfSupply: 12.5,
      nextMonthStorage: null,
      ageSurcharge: 1.2,
      age0to90: 5,
      age181to270: 0,
      age91to180: null,
    })
  })
})

describe('预测序列与台账单据', () => {
  it('预测未来 30 天逐日相同；没有日销时为空', () => {
    const series = forecastSeries(demand({ low: 1, mid: 2, high: 3 }), TODAY)
    expect(series).toHaveLength(30)
    expect(series[0]).toEqual({ date: TODAY, low: 1, mid: 2, high: 3 })
    expect(series[29].date).toBe('2026-11-20')
    expect(forecastSeries(demand({ mid: null }), TODAY)).toEqual([])
  })

  it('发货与退货对应订单，接收对应货件，其余没有单据页', () => {
    expect(ledgerReferenceKind('Shipments')).toBe('ORDER')
    expect(ledgerReferenceKind('CustomerReturns')).toBe('ORDER')
    expect(ledgerReferenceKind('Receipts')).toBe('INBOUND_SHIPMENT')
    expect(ledgerReferenceKind('Adjustments')).toBeNull()
    expect(ledgerReferenceKind('')).toBeNull()
  })

  it('入仓计划商品行里取指定 SKU 的计划数量，格式不对的忽略', () => {
    expect(quantityOf([{ sellerSku: 'A', quantity: 5 }, { sellerSku: 'B', quantity: 1 }, { sellerSku: 'A', quantity: 2 }, null, { sellerSku: 'A', quantity: '3' }], 'A')).toBe(7)
    expect(quantityOf(null, 'A')).toBe(0)
    expect(quantityOf({ sellerSku: 'A' }, 'A')).toBe(0)
  })
})
