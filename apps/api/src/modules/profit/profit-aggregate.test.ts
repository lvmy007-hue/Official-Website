import { describe, expect, it } from 'vitest'
import { bridgeViewOf, coverageOf, marginOf, mergeTotals, perUnitOf, totalsOf } from './profit-aggregate'
import { decodeOffset, pageOf, sortRows } from './profit-page'

// 利润分析的汇总纯函数：合并分组、利润率、单位经济、利润桥视图与游标分页。口径与 P2b-09 的 profit-math 一致，这里只验证汇总层。

const sum = (over: Record<string, number | null> = {}) => ({
  units: 10,
  costedUnits: 10,
  revenue: 200,
  refunds: 10,
  feeCommission: 30,
  feeFulfillment: 40,
  productCost: 60,
  firstMileCost: 10,
  profit: 50,
  ...over,
})

describe('合计', () => {
  it('有一行算不出利润，整组净利润就不给，已能算出的部分另列', () => {
    const complete = totalsOf(sum(), 2, 0)
    expect(complete).toMatchObject({ profit: 50, coveredProfit: 50, incompleteRows: 0, revenue: 200 })
    const partial = totalsOf(sum(), 2, 1)
    expect(partial).toMatchObject({ profit: null, coveredProfit: 50, incompleteRows: 1 })
  })

  it('可空列：数据库没有合计（全为空）时仍是 null，不是 0；必有列缺省 0', () => {
    const totals = totalsOf({ revenue: 5 }, 1, 0)
    expect(totals).toMatchObject({ revenue: 5, refunds: 0, productCost: null, firstMileCost: null, adsUnallocated: null, adsSpendAllocated: null, coveredProfit: null })
    expect(totals.profit).toBeNull()
    expect(totalsOf({}, 0, 0).profit).toBeNull()
  })

  it('合并分组：可空列只要一边有数就有数；任一边算不出利润则整体算不出；小数不累积误差', () => {
    const a = totalsOf(sum({ productCost: 60, profit: 50 }), 1, 0)
    const b = totalsOf(sum({ productCost: null, costedUnits: 0, profit: null, revenue: 80, feeCommission: 0.1 }), 1, 1)
    const merged = mergeTotals(a, b)
    expect(merged).toMatchObject({ units: 20, costedUnits: 10, revenue: 280, productCost: 60, profit: null, coveredProfit: 50, rows: 2, incompleteRows: 1 })
    expect(merged.feeCommission).toBe(30.1)
    const both = mergeTotals(totalsOf(sum({ productCost: null, profit: 1 }), 1, 0), totalsOf(sum({ productCost: null, profit: 2 }), 1, 0))
    expect(both.productCost).toBeNull()
    expect(both.profit).toBe(3)
  })
})

describe('利润率、覆盖率、单位经济', () => {
  it('利润率：净利润算不出或销售额不为正时没有利润率', () => {
    expect(marginOf(50, 200)).toBe(0.25)
    expect(marginOf(null, 200)).toBeNull()
    expect(marginOf(50, 0)).toBeNull()
    expect(marginOf(-20, 100)).toBe(-0.2)
  })

  it('成本覆盖率：没有销量为 null', () => {
    expect(coverageOf(5, 10)).toBe(0.5)
    expect(coverageOf(0, 0)).toBeNull()
  })

  it('单位经济：没有销量 null；成本没算全时不给每件成本；没有成本字段权限时不含成本键', () => {
    expect(perUnitOf(totalsOf(sum(), 1, 0), true)).toEqual({ revenue: 20, fees: 7, productCost: 6, profit: 5 })
    expect(perUnitOf(totalsOf(sum(), 1, 0), false)).toEqual({ revenue: 20, fees: 7, profit: 5 })
    expect(perUnitOf(totalsOf(sum({ costedUnits: 4 }), 1, 0), true)?.productCost).toBeNull()
    expect(perUnitOf(totalsOf(sum({ units: 0, costedUnits: 0 }), 1, 0), true)).toBeNull()
    expect(perUnitOf(totalsOf(sum({ profit: null }), 1, 1), true)?.profit).toBeNull()
  })
})

describe('利润桥视图', () => {
  const item = (view: ReturnType<typeof bridgeViewOf>, key: string) => view.items.find(entry => entry.key === key)!

  it('净利润、各项与状态：关税与汇兑损益尚未接入；没有数据的项目有说明', () => {
    const view = bridgeViewOf(totalsOf(sum(), 1, 0), true)
    expect(view).toMatchObject({ netProfit: 50, coveredProfit: 50, incompleteRows: 0, rows: 1 })
    expect(item(view, 'REVENUE')).toMatchObject({ value: 200, contribution: 200, state: 'OK' })
    expect(item(view, 'COMMISSION')).toMatchObject({ value: 30, contribution: -30 })
    expect(item(view, 'PRODUCT_COST')).toMatchObject({ value: 60, state: 'OK' })
    expect(item(view, 'DUTY')).toMatchObject({ value: null, state: 'NO_DATA', note: expect.stringContaining('没有关税') })
    expect(item(view, 'ADS')).toMatchObject({ value: null, state: 'NO_DATA', note: expect.stringContaining('广告') })
    expect(item(view, 'NET_PROFIT')).toMatchObject({ value: 50, state: 'OK', note: null })
  })

  it('缺成本时净利润整体不给，并写明几行算不出与已能计算的部分', () => {
    const view = bridgeViewOf(totalsOf(sum(), 3, 2), true)
    expect(view.netProfit).toBeNull()
    expect(item(view, 'NET_PROFIT')).toMatchObject({ value: null, state: 'NO_DATA', note: expect.stringContaining('2 行因缺少成本算不出利润') })
    expect(item(view, 'NET_PROFIT').note).toContain('50.00')
    expect(bridgeViewOf(totalsOf({}, 0, 0), true).items.find(entry => entry.key === 'NET_PROFIT')?.note).toBe('范围内没有利润日表数据')
  })

  it('没有成本字段权限：三项成本是“无权限”，值与贡献都为空，其余项不受影响', () => {
    const view = bridgeViewOf(totalsOf(sum(), 1, 0), false)
    for (const key of ['PRODUCT_COST', 'FIRST_MILE', 'OTHER_COST']) expect(item(view, key)).toMatchObject({ value: null, contribution: null, state: 'RESTRICTED' })
    expect(item(view, 'REVENUE').value).toBe(200)
    expect(view.netProfit).toBe(50)
  })
})

describe('排序与游标', () => {
  const row = (key: string, over: Record<string, number | null>) => ({ key, totals: totalsOf(sum({ units: 1, costedUnits: 1, ...over }), 1, over.profit === null ? 1 : 0) })

  it('没有值的（利润算不出）排在最后，不管升降序；并列按键稳定排序', () => {
    const rows = [row('c', { revenue: 10, profit: null }), row('b', { revenue: 10, profit: 5 }), row('a', { revenue: 10, profit: 5 }), row('d', { revenue: 10, profit: 9 })]
    expect(sortRows(rows, { field: 'profit', dir: 'desc' }).map(item => item.key)).toEqual(['d', 'a', 'b', 'c'])
    expect(sortRows(rows, { field: 'profit', dir: 'asc' }).map(item => item.key)).toEqual(['a', 'b', 'd', 'c'])
    expect(sortRows(rows, { field: 'margin', dir: 'desc' }).map(item => item.key)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('没有游标从头开始；翻页信息给出是否还有下一页与总数', () => {
    process.env.JWT_SECRET ??= 'x'.repeat(40)
    expect(decodeOffset(undefined, 'binding')).toBe(0)
    const items = [1, 2, 3, 4, 5]
    const first = pageOf(items, 0, 2, 'binding')
    expect(first.page).toEqual([1, 2])
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 5, pageSize: 2 })
    const offset = decodeOffset(first.pageInfo.nextCursor ?? undefined, 'binding')
    expect(offset).toBe(2)
    const last = pageOf(items, 4, 2, 'binding')
    expect(last.page).toEqual([5])
    expect(last.pageInfo).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('游标绑定查询条件：换条件或伪造都被拒绝', () => {
    process.env.JWT_SECRET ??= 'x'.repeat(40)
    const cursor = pageOf([1, 2, 3], 0, 1, 'binding-a').pageInfo.nextCursor ?? ''
    expect(() => decodeOffset(cursor, 'binding-b')).toThrow(/游标无效/)
    expect(() => decodeOffset('forged.value', 'binding-a')).toThrow(/游标无效/)
  })
})
