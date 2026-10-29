import { describe, expect, it } from 'vitest'
import { buildTimeline, parseRemovalId, reconcile, removalId, removalTypeOf } from './removal-math'

describe('移除订单编号与类型', () => {
  it('编号 = 店铺:订单号；订单号里带冒号也能还原；缺一边的编号无效', () => {
    expect(removalId('s1', 'RO-1')).toBe('s1:RO-1')
    expect(parseRemovalId('s1:RO-1')).toEqual({ sellerAccountId: 's1', orderId: 'RO-1' })
    expect(parseRemovalId('s1:a:b')).toEqual({ sellerAccountId: 's1', orderId: 'a:b' })
    for (const bad of ['', 'RO-1', ':RO-1', 's1:']) expect(parseRemovalId(bad), bad).toBeNull()
  })

  it('类型归一：不认识的归“其他”', () => {
    expect(removalTypeOf('RETURN')).toBe('RETURN')
    expect(removalTypeOf('DISPOSAL')).toBe('DISPOSAL')
    expect(removalTypeOf('x')).toBe('OTHER')
    expect(removalTypeOf(null)).toBe('OTHER')
  })
})

describe('退回件收货核对', () => {
  const lines = [
    { sku: 'B', shippedQty: 5 },
    { sku: 'A', shippedQty: 6 },
    { sku: 'A', shippedQty: 4 },
  ]

  it('应收按 SKU 合计；没有登记时实收为 null、状态待登记', () => {
    expect(reconcile('RETURN', lines, [])).toEqual([
      { sku: 'A', expectedQty: 10, receivedQty: null, sellableQty: null, damagedQty: null, difference: null, state: 'PENDING' },
      { sku: 'B', expectedQty: 5, receivedQty: null, sellableQty: null, damagedQty: null, difference: null, state: 'PENDING' },
    ])
  })

  it('多次登记累计：少收、一致、多收', () => {
    const rows = reconcile('RETURN', lines, [
      { sku: 'A', receivedQty: 4, sellableQty: 3, damagedQty: 1 },
      { sku: 'A', receivedQty: 5, sellableQty: 5, damagedQty: 0 },
      { sku: 'B', receivedQty: 5, sellableQty: 5, damagedQty: 0 },
    ])
    expect(rows[0]).toMatchObject({ sku: 'A', receivedQty: 9, sellableQty: 8, damagedQty: 1, difference: -1, state: 'SHORT' })
    expect(rows[1]).toMatchObject({ sku: 'B', difference: 0, state: 'MATCHED' })
    expect(reconcile('RETURN', [{ sku: 'A', shippedQty: 1 }], [{ sku: 'A', receivedQty: 2, sellableQty: 2, damagedQty: 0 }])[0].state).toBe('OVER')
  })

  it('弃置订单无需核对', () => {
    expect(reconcile('DISPOSAL', lines, [])[0].state).toBe('NOT_APPLICABLE')
  })
})

describe('移除订单时间线', () => {
  it('只列有日期的事实并按日期排序；没有日期的发货不列', () => {
    const items = buildTimeline({
      requestDate: '2026-10-01',
      requestedQty: 12,
      typeLabel: '退回',
      status: 'Completed',
      lastUpdatedDate: '2026-10-09',
      shipments: [
        { shipDate: '2026-10-05', shippedQty: 10, carrier: 'UPS', trackingNumber: '1Z', sku: 'A' },
        { shipDate: null, shippedQty: 2, carrier: null, trackingNumber: null, sku: 'B' },
      ],
      receipts: [{ receivedAt: '2026-10-08', sku: 'A', receivedQty: 9 }],
    })
    expect(items.map(item => item.at)).toEqual(['2026-10-01', '2026-10-05', '2026-10-08', '2026-10-09'])
    expect(items[0]).toMatchObject({ title: '提交移除订单', detail: '退回，请求 12 件' })
    expect(items[1]).toMatchObject({ title: '已发货 10 件', detail: 'A；UPS 1Z' })
    expect(items[2].title).toBe('登记收货 9 件')
    expect(items[3].title).toContain('已完成')
  })
})
