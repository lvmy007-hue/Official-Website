import { describe, expect, it } from 'vitest'
import { orders, stores } from './data'

describe('ERP fixture semantics', () => {
  it('keeps order and store identifiers non-empty', () => {
    expect(stores.every(store => store.id && store.sellerId)).toBe(true)
    expect(orders.every(order => order.id && order.amount)).toBe(true)
  })
  it('contains operational states instead of placeholder labels', () => {
    expect(orders.some(order => order.status === '待发货')).toBe(true)
    expect(stores.some(store => store.health === '待处理')).toBe(true)
  })
})
