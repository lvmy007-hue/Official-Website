import { describe, expect, it } from 'vitest'
import { buildProductRows, compareProductRows, distinctTags, salesKey, skuKey, type ProductRecord } from './product-list-math'

const record = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  id: 'p1',
  sellerAccountId: 's1',
  storeName: '店铺一',
  asin: 'B0AAAAAAAA',
  sellerSku: 'SKU-A',
  fnsku: null,
  title: '商品',
  imageUrl: null,
  parentAsin: null,
  brand: null,
  categoryPath: null,
  fulfillmentChannel: 'AFN',
  listingStatus: 'ACTIVE',
  price: 10,
  currency: 'USD',
  ownerUserId: null,
  tagIds: [],
  version: 1,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  catalogStatus: null,
  ...over,
})

const build = (records: ProductRecord[], over: Partial<Parameters<typeof buildProductRows>[0]> = {}) =>
  buildProductRows({ records, sales: new Map(), stock: null, margins: null, names: new Map(), watched: new Set(), formerLabel: '已离开', ...over })

describe('buildProductRows', () => {
  it('没有销售记录是 null，不是 0；有记录按店铺 × ASIN 取', () => {
    const rows = build([record()], { sales: new Map([[salesKey('s1', 'B0AAAAAAAA'), { amount: 50, units: 5 }]]) })
    expect(rows[0]).toMatchObject({ sales30: 50, units30: 5, salesShared: false })
    const none = build([record()])
    expect(none[0]).toMatchObject({ sales30: null, units30: null })
    // 别的店铺的同 ASIN 不串
    expect(build([record({ sellerAccountId: 's2' })], { sales: new Map([[salesKey('s1', 'B0AAAAAAAA'), { amount: 50, units: 5 }]]) })[0].sales30).toBeNull()
  })

  it('同店同 ASIN 的多个 SKU 标为共用销售；不同店铺不算', () => {
    const rows = build([record({ id: 'p1' }), record({ id: 'p2', sellerSku: 'SKU-A2' }), record({ id: 'p3', sellerAccountId: 's2' })])
    expect(rows.map(row => row.salesShared)).toEqual([true, true, false])
  })

  it('库存：没有权限时为 null；有权限但没有这个 SKU 的记录也是 null；有记录取可售数量（包括 0）', () => {
    expect(build([record()])[0].sellable).toBeNull()
    expect(build([record()], { stock: new Map() })[0].sellable).toBeNull()
    expect(build([record()], { stock: new Map([[skuKey('s1', 'SKU-A'), 0]]) })[0].sellable).toBe(0)
  })

  it('利润率：没有权限时不出现字段；有记录算比例；缺成本、没有销售额、没有记录各有原因', () => {
    expect(build([record()])[0]).not.toHaveProperty('margin30')
    const margins = new Map([
      [skuKey('s1', 'SKU-A'), { rows: 2, revenue: 200, profit: 50 }],
      [skuKey('s1', 'SKU-B'), { rows: 1, revenue: 80, profit: null }],
      [skuKey('s1', 'SKU-C'), { rows: 1, revenue: 0, profit: -3 }],
    ])
    const rows = build([record(), record({ id: 'p2', sellerSku: 'SKU-B' }), record({ id: 'p3', sellerSku: 'SKU-C' }), record({ id: 'p4', sellerSku: 'SKU-D' })], { margins })
    expect(rows.map(row => [row.marginState, row.margin30])).toEqual([
      ['OK', 0.25],
      ['COST_MISSING', null],
      ['NO_SALES', null],
      ['NO_RECORD', null],
    ])
  })

  it('负责人：查得到显示名；查不到显示“已离开”；没有负责人是 null', () => {
    const rows = build([record({ ownerUserId: 'u1' }), record({ id: 'p2', ownerUserId: 'gone' }), record({ id: 'p3' })], { names: new Map([['u1', '张三']]) })
    expect(rows.map(row => row.ownerName)).toEqual(['张三', '已离开', null])
  })

  it('目录状态与已关注', () => {
    const rows = build([record({ catalogStatus: 'FOUND' }), record({ id: 'p2', catalogStatus: 'NOT_FOUND' }), record({ id: 'p3' })], { watched: new Set(['p3']) })
    expect(rows.map(row => [row.catalogState, row.watched])).toEqual([
      ['OK', false],
      ['NOT_FOUND', false],
      ['NOT_SYNCED', true],
    ])
  })
})

describe('compareProductRows', () => {
  const rows = build([record({ id: 'a', sellerSku: 'sku-b', price: 5 }), record({ id: 'b', sellerSku: 'SKU-A', price: null }), record({ id: 'c', sellerSku: 'sku-c', price: 9 })], {})
  const sorted = (field: Parameters<typeof compareProductRows>[2], dir: 'asc' | 'desc') => [...rows].sort((x, y) => compareProductRows(x, y, field, dir)).map(row => row.id)

  it('数值列空值永远在最后，不论升降序', () => {
    expect(sorted('price', 'asc')).toEqual(['a', 'c', 'b'])
    expect(sorted('price', 'desc')).toEqual(['c', 'a', 'b'])
  })

  it('文本按码点比较（大写排在小写前，与区域设置无关）；并列按编号稳定', () => {
    expect(sorted('sku', 'asc')).toEqual(['b', 'a', 'c'])
    expect(sorted('updatedAt', 'desc')).toEqual(['a', 'b', 'c'])
  })
})

describe('distinctTags', () => {
  it('不分大小写去重，保留先出现的写法，按码点排序并限制个数', () => {
    expect(distinctTags([{ tagIds: ['b', 'A'] }, { tagIds: ['a', 'C'] }], 10)).toEqual(['A', 'C', 'b'])
    expect(distinctTags([{ tagIds: ['x', 'y', 'z'] }], 2)).toEqual(['x', 'y'])
  })
})
