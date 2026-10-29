import type { MatrixRow } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { assemblePoints, buildTree, childrenOf, limitChildren, pivotOf, scaleOf, trafficRows, type PointInputs, type ProductLite } from './asin-analytics-math'

// ASIN 与父体分析的纯计算（P4-03）：家族归并、父体树、逐日指标装配、变体属性透视、流量占比。

const product = (id: string, asin: string, parentAsin: string | null, over: Partial<ProductLite> = {}): ProductLite => ({
  id,
  sellerAccountId: 's1',
  sellerSku: `SKU-${id}`,
  asin,
  parentAsin,
  title: `商品 ${asin}`,
  brand: null,
  imageUrl: null,
  categoryPath: null,
  listingStatus: 'ACTIVE',
  catalogStatus: null,
  variantAttributes: null,
  ownerUserId: null,
  tagIds: [],
  ...over,
})

describe('家族与父体树', () => {
  it('同一 ASIN 的多个 SKU、多个店铺合成一个子体；父体自己的商品行不算子体；只在关系表里的子体也算', () => {
    const kids = childrenOf(
      [product('1', 'B0A', 'P'), product('2', 'B0A', 'P', { sellerAccountId: 's2' }), product('3', 'P', null), product('4', 'B0B', 'P', { variantAttributes: { color: 'Red', size: 3 } })],
      'P',
      ['B0C', 'B0A', 'P'],
    )
    expect(kids.map(kid => kid.asin)).toEqual(['B0A', 'B0B', 'B0C'])
    expect(kids[0]).toMatchObject({ skuCount: 2, storeIds: ['s1', 's2'] })
    expect(kids[1]!.attributes).toEqual({ color: 'Red' })
    expect(kids[2]).toMatchObject({ title: null, productId: null, skuCount: 0 })
  })

  it('超过上限时按销售额从高到低保留，没有销售额的在后', () => {
    const items = ['A', 'B', 'C', 'D'].map(asin => ({ asin }))
    const { kept, truncated } = limitChildren(
      items,
      new Map([
        ['B', 5],
        ['C', 9],
        ['D', null],
      ]),
      2,
    )
    expect(truncated).toBe(true)
    expect(kept.map(item => item.asin)).toEqual(['C', 'B'])
    expect(limitChildren(items, new Map(), 9)).toMatchObject({ truncated: false })
  })

  it('没有父体也没人把它当父体的 ASIN 单独成项；父体销售额只加有值的子体，全没有值就是 null', () => {
    const tree = buildTree(
      [product('1', 'B0A', 'P'), product('2', 'B0B', 'P'), product('3', 'B0S', null), product('4', 'B0X', 'Q')],
      new Map([
        ['B0A', { sales: 10, sessions: null }],
        ['B0S', { sales: 3, sessions: 7 }],
      ]),
    )
    expect(tree.map(node => node.key)).toEqual(['parent:P', 'asin:B0S', 'parent:Q'])
    expect(tree[0]).toMatchObject({ childCount: 2, sales: 10, sessions: null })
    expect(tree[2]).toMatchObject({ sales: null, sessions: null })
    expect(tree[1]).toMatchObject({ kind: 'asin', childCount: 0, children: [] })
  })
})

const inputs = (over: Partial<PointInputs> = {}): PointInputs => ({
  days: ['2026-10-01', '2026-10-02', '2026-10-03'],
  daily: new Map([['2026-10-02', { sales: 100, units: 10, sessions: 200, pageViews: 400, buyBox: 0.9 }]]),
  adsByDay: null,
  returnsByDay: null,
  stock: new Map(),
  rankByDay: null,
  ratios: { conversion: 0.05, price: 10, buyBox: 0.9 },
  ...over,
})

describe('逐日指标', () => {
  it('没有记录的日子各项为 null；比率只在分子分母都有值时给', () => {
    const { points, totals } = assemblePoints(inputs())
    expect(points[0]).toMatchObject({ sales: null, conversion: null, price: null, adsSales: null, returnRate: null })
    expect(points[1]).toMatchObject({ sales: 100, conversion: 0.05, price: 10 })
    expect(totals).toMatchObject({ sales: 100, units: 10, adsSales: null, organicSales: null, returnRate: null, daysOfSupply: null, salesRank: null })
  })

  it('自然销售 = 销售额 − 广告销售额；广告大于销售额那天不给；整段没有广告来源时都是 null', () => {
    const { points, totals } = assemblePoints(
      inputs({
        adsByDay: new Map([
          ['2026-10-02', 30],
          ['2026-10-03', 5],
        ]),
      }),
    )
    expect(points[1]).toMatchObject({ adsSales: 30, organicSales: 70 })
    expect(points[2]).toMatchObject({ adsSales: 5, organicSales: null })
    expect(totals).toMatchObject({ adsSales: 35, organicSales: 65 })
  })

  it('可售天数 = 当天可售 ÷ 近 7 天日均件数；没有销量或没有库存时是 null', () => {
    const stock = new Map([
      ['2026-10-02', { units: 4, available: 20 }],
      ['2026-10-03', { units: 0, available: 20 }],
    ])
    const { points, totals } = assemblePoints(inputs({ stock }))
    expect(points[1]!.daysOfSupply).toBe(10)
    expect(points[2]!.daysOfSupply).toBeCloseTo(20 / (4 / 3), 1)
    expect(points[0]!.daysOfSupply).toBeNull()
    expect(totals.daysOfSupply).toBe(points[2]!.daysOfSupply)
    expect(assemblePoints(inputs({ stock: new Map([['2026-10-02', { units: 0, available: 20 }]]) })).totals.daysOfSupply).toBeNull()
    expect(assemblePoints(inputs({ stock: new Map([['2026-10-02', { units: 5, available: null }]]) })).totals.daysOfSupply).toBeNull()
  })

  it('退货率近 7 天滚动，没有退货的日子按 0 件；退货记录没有同步（null）时整段为 null；排名取最近一天', () => {
    const synced = assemblePoints(
      inputs({
        returnsByDay: new Map([['2026-10-02', 1]]),
        rankByDay: new Map([
          ['2026-10-01', 9],
          ['2026-10-03', 7],
        ]),
      }),
    )
    expect(synced.points[1]!.returnRate).toBeCloseTo(0.1, 6)
    expect(synced.totals).toMatchObject({ returnRate: 0.1, salesRank: 7 })
    expect(assemblePoints(inputs()).points.every(point => point.returnRate === null)).toBe(true)
  })
})

const matrixRow = (asin: string, attributes: Record<string, string>, over: Partial<MatrixRow> = {}): MatrixRow => ({
  asin,
  title: null,
  productId: null,
  attributes,
  sales: null,
  units: null,
  sessions: null,
  conversion: null,
  share: null,
  risk: null,
  ...over,
})

describe('变体属性透视', () => {
  it('目录没有变体属性时是“尚未接入”，不去猜', () => {
    const pivot = pivotOf([matrixRow('A', {}), matrixRow('B', {})], null)
    expect(pivot).toMatchObject({ state: 'NOT_CONNECTED', dimensions: [], cells: [] })
    expect(pivot.note).toContain('不用 SKU 或标题去猜')
  })

  it('只有一个维度时是一维；格子里销售额只加有值的，风险取最差的', () => {
    const pivot = pivotOf(
      [matrixRow('A', { color: 'Red' }, { sales: 5, units: 2, sessions: 10, risk: 'NORMAL' }), matrixRow('B', { color: 'Red' }, { sales: null, risk: 'HIGH' }), matrixRow('C', { color: 'Blue' })],
      null,
    )
    expect(pivot).toMatchObject({ state: 'OK', rowDim: 'color', colDim: null, rowValues: ['Red', 'Blue'], colValues: ['全部'] })
    const red = pivot.cells.find(cell => cell.row === 'Red')!
    expect(red).toMatchObject({ sales: 5, units: 2, conversion: 0.2, risk: 'HIGH', asins: ['A', 'B'] })
    expect(pivot.cells.find(cell => cell.row === 'Blue')).toMatchObject({ sales: null, conversion: null, risk: null })
  })

  it('维度按出现的子体数从多到少；所选维度可用就用，不可用回退并说明', () => {
    const rows = [matrixRow('A', { size: 'L', color: 'Red', style: 'x' }), matrixRow('B', { size: 'S', color: 'Red' }), matrixRow('C', { size: 'S' })]
    expect(pivotOf(rows, null)).toMatchObject({ dimensions: ['size', 'color', 'style'], rowDim: 'size', colDim: 'color' })
    expect(pivotOf(rows, ['color', 'style'])).toMatchObject({ rowDim: 'color', colDim: 'style', note: null })
    expect(pivotOf(rows, ['nope', 'size']).note).toContain('已改用 size × color')
  })

  it('配色刻度：销售额与转化率取最小最大，风险没有刻度，全没有值为 null', () => {
    const rows = [matrixRow('A', {}, { sales: 3 }), matrixRow('B', {}, { sales: 9 }), matrixRow('C', {})]
    expect(scaleOf(rows, 'sales')).toEqual({ min: 3, max: 9 })
    expect(scaleOf(rows, 'risk')).toBeNull()
    expect(scaleOf(rows, 'conversion')).toBeNull()
  })
})

describe('流量分布', () => {
  it('占比 = 会话 ÷ 父体总会话；对比期任一期缺失变化为 null；总数为 0 时占比为 null', () => {
    const kids = [
      { asin: 'A', title: null },
      { asin: 'B', title: null },
      { asin: 'C', title: null },
    ]
    const rows = trafficRows(
      kids,
      new Map([
        ['A', 30],
        ['B', 70],
        ['C', null],
      ]),
      new Map([
        ['A', 50],
        ['B', null],
        ['C', null],
      ]),
    )
    expect(rows.map(row => row.asin)).toEqual(['B', 'A', 'C'])
    expect(rows[0]).toMatchObject({ share: 0.7, compareShare: null, shareChange: null })
    expect(rows[1]).toMatchObject({ share: 0.3, compareShare: 1, shareChange: -0.7 })
    expect(rows[2]).toMatchObject({ sessions: null, share: null })
    expect(trafficRows(kids.slice(0, 1), new Map([['A', 0]]), null)[0]).toMatchObject({ sessions: 0, share: null })
  })
})
