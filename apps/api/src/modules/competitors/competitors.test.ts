import type { CompetitorRow } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import type { SnapshotRow, WatchRow } from './competitors-load'
import { buildRow, compareRows, matchesQuery, rankGapFor, summaryOf } from './competitors-rows'
import { shareOf, type HotMap } from './competitors-terms'
import { buildCompare, buildTrend, fulfillmentLabel } from './competitors-trend'

// 竞品列表行装配、排序、点击份额与趋势对齐（P4-12）：纯函数。数据读取、写入与权限见 competitors.http.test.ts 与 testing/competitors.db.test.ts。

const T0 = new Date(Date.UTC(2026, 5, 1, 0, 0))
const watch = (extra: Partial<WatchRow> = {}): WatchRow => ({ id: 'w1', sellerAccountId: 's1', asin: 'B0COMPET01', ownAsin: 'B0OWN00001', reason: 'MANUAL', note: null, createdAt: T0, ...extra })
const snapshot = (extra: Partial<SnapshotRow> = {}): SnapshotRow => ({
  id: 'n1',
  sellerAccountId: 's1',
  asin: 'B0COMPET01',
  title: '竞品',
  brand: 'Acme',
  imageCount: 6,
  price: 25,
  currency: 'USD',
  featured: 'HAS_FEATURED',
  fulfillment: 'FBA',
  memberEligible: true,
  rank: 80,
  rankClassificationId: 'c1',
  rankName: '行李箱',
  observedAt: T0,
  ...extra,
})
const input = (extra: Partial<Parameters<typeof buildRow>[0]> = {}): Parameters<typeof buildRow>[0] => ({
  watch: watch(),
  storeName: '店铺',
  snapshot: snapshot(),
  own: { asin: 'B0OWN00001', title: '我方', brand: 'Mine', fulfillmentChannel: 'AFN' },
  ownPrice: { price: 20, currency: 'USD', observedAt: T0 },
  ownRanks: [{ classificationId: 'c1', name: '行李箱', rank: 100 }],
  share: null,
  ...extra,
})

describe('列表行装配', () => {
  it('有快照、我方价格与同分类排名：算出价格差与名次差', () => {
    const row = buildRow(input())
    expect(row).toMatchObject({ price: 25, ownPrice: 20, priceGap: 5, priceGapPct: 0.25, ownRank: 100, rank: 80, rankGap: -20, rankNote: null, ownTitle: '我方' })
  })

  it('还没有快照：所有数据字段都是 null（不是 0），观察时间为 null', () => {
    const row = buildRow(input({ snapshot: undefined }))
    expect(row).toMatchObject({ title: null, brand: null, price: null, rank: null, featured: null, observedAt: null, priceGap: null, rankGap: null })
    expect(row.rankNote).toContain('竞品')
  })

  it('没有指定我方对应商品：没有价格差与名次差，并说明原因', () => {
    const row = buildRow(input({ watch: watch({ ownAsin: '' }), own: undefined, ownPrice: undefined, ownRanks: [] }))
    expect(row).toMatchObject({ ownAsin: null, ownPrice: null, priceGap: null, rankGap: null, rankNote: '没有指定我方对应商品' })
  })

  it('币种不同不比较价格；我方分类不同不比较名次并说明', () => {
    expect(buildRow(input({ ownPrice: { price: 20, currency: 'EUR', observedAt: T0 } })).priceGap).toBeNull()
    const row = buildRow(input({ ownRanks: [{ classificationId: 'c9', name: '别的', rank: 5 }] }))
    expect(row.rankGap).toBeNull()
    expect(row.ownRank).toBeNull()
    expect(row.rankNote).toContain('分类不同')
  })

  it('点击份额带命中词数；没有份额结果时为 null', () => {
    expect(buildRow(input({ share: { share: 0.42, hit: 3, total: 10, terms: [] } }))).toMatchObject({ clickShare: 0.42, clickShareTerms: { hit: 3, total: 10 } })
    expect(buildRow(input()).clickShare).toBeNull()
    expect(buildRow(input()).clickShareTerms).toBeNull()
  })

  it('名次差的计算入口：缺我方 ASIN、缺竞品排名各有说明', () => {
    expect(rankGapFor(null, snapshot(), []).note).toBe('没有指定我方对应商品')
    expect(rankGapFor('B0OWN00001', snapshot({ rank: null, rankClassificationId: null }), [{ classificationId: 'c1', name: 'x', rank: 3 }]).gap).toBeNull()
    expect(rankGapFor('B0OWN00001', snapshot(), []).note).toContain('我方')
  })
})

describe('排序与筛选', () => {
  const rows: CompetitorRow[] = [
    buildRow(input({ watch: watch({ id: 'a', asin: 'B0AAAAAAAA' }), snapshot: snapshot({ price: 30 }) })),
    buildRow(input({ watch: watch({ id: 'b', asin: 'B0BBBBBBBB' }), snapshot: undefined })),
    buildRow(input({ watch: watch({ id: 'c', asin: 'B0CCCCCCCC' }), snapshot: snapshot({ price: 10 }) })),
  ]
  const order = (dir: 'asc' | 'desc') => [...rows].sort((x, y) => compareRows(x, y, 'price', dir)).map(row => row.id)

  it('没有值的行不论升降序都排在最后', () => {
    expect(order('asc')).toEqual(['c', 'a', 'b'])
    expect(order('desc')).toEqual(['a', 'c', 'b'])
  })

  it('值相同按竞品 ASIN 稳定排序', () => {
    const same = [rows[2]!, rows[0]!].map(row => ({ ...row, price: 5 }))
    expect([...same].sort((x, y) => compareRows(x, y, 'price', 'asc')).map(row => row.id)).toEqual(['a', 'c'])
  })

  it('汇总区分已有快照与等待首次同步；关键字匹配 ASIN、标题、品牌、备注，不区分大小写', () => {
    expect(summaryOf(rows)).toEqual({ watched: 3, withSnapshot: 2, waiting: 1 })
    expect(matchesQuery(rows[0]!, 'b0aaaa')).toBe(true)
    expect(matchesQuery(rows[0]!, 'acme')).toBe(true)
    expect(matchesQuery(rows[0]!, 'nomatch')).toBe(false)
    expect(matchesQuery(rows[0]!, undefined)).toBe(true)
  })
})

describe('核心词点击份额', () => {
  const hot: HotMap = new Map([
    ['luggage', [{ slot: 1, asin: 'B0COMPET01', title: null, clickShare: 0.5, conversionShare: 0.2 }]],
    ['suitcase', [{ slot: 3, asin: 'B0OTHER001', title: null, clickShare: 0.1, conversionShare: null }]],
  ])
  const core = [
    { term: 'Luggage', volume: 900 },
    { term: 'suitcase', volume: 100 },
  ]

  it('按我方搜索量加权，词不区分大小写；没进前三的词按 0 计，命中词按搜索量从高到低', () => {
    const result = shareOf(core, hot, 'B0COMPET01')
    expect(result).toMatchObject({ share: 0.45, hit: 1, total: 2 })
    expect(result.terms).toEqual([{ term: 'Luggage', slot: 1, clickShare: 0.5, conversionShare: 0.2, volume: 900 }])
  })

  it('没有热门搜索词数据时没有结果，不当 0', () => {
    expect(shareOf(core, undefined, 'B0COMPET01')).toMatchObject({ share: 0, hit: 0, total: 2 })
    expect(shareOf([], hot, 'B0COMPET01')).toMatchObject({ share: null, total: 0 })
  })
})

describe('趋势对齐', () => {
  const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000)

  it('时间取并集，各序列沿用最近一次已知值；还没有记录的是 null；只输出起点之后的点', () => {
    const { points, truncated } = buildTrend(
      {
        price: [
          { at: at(-48), value: 10 },
          { at: at(6), value: 12 },
        ],
        rank: [{ at: at(6), value: 100 }],
        ownPrice: [{ at: at(0), value: 9 }],
        ownRank: [],
      },
      at(0),
    )
    expect(truncated).toBe(false)
    expect(points.map(point => [point.at, point.price, point.ownPrice, point.rank, point.ownRank])).toEqual([
      [at(0).toISOString(), 10, 9, null, null],
      [at(6).toISOString(), 12, 9, 100, null],
    ])
  })

  it('超过上限保留最近的并标记截断', () => {
    const series = Array.from({ length: 5 }, (_, index) => ({ at: at(index), value: index + 1 }))
    const result = buildTrend({ price: series, rank: [], ownPrice: [], ownRank: [] }, at(0), 3)
    expect(result.truncated).toBe(true)
    expect(result.points.map(point => point.price)).toEqual([3, 4, 5])
  })
})

describe('并排对照', () => {
  it('配送方式统一叫法；两边缺的字段为 null，排名带分类与原因', () => {
    expect(fulfillmentLabel('AFN')).toBe('FBA')
    expect(fulfillmentLabel('MERCHANT')).toBe('FBM')
    expect(fulfillmentLabel('X')).toBe('X')
    expect(fulfillmentLabel(null)).toBeNull()
    const rows = buildCompare({
      competitor: snapshot(),
      own: { asin: 'B0OWN00001', title: '我方', brand: null, fulfillmentChannel: 'MFN' },
      ownPrice: { price: 20, currency: 'USD', observedAt: T0 },
      ownSummary: { featuredIsOwn: true, featuredPrice: 20, viewWeightMember: 0.5 },
      ownRank: { rank: 100, name: '行李箱' },
      rankNote: null,
    })
    const get = (key: string) => rows.find(row => row.key === key)!
    expect(get('price')).toMatchObject({ own: '20.00 USD', competitor: '25.00 USD' })
    expect(get('brand')).toMatchObject({ own: null, competitor: 'Acme' })
    expect(get('featured')).toMatchObject({ own: '我方持有推荐报价', competitor: '有推荐报价' })
    expect(get('fulfillment')).toMatchObject({ own: 'FBM', competitor: 'FBA' })
    expect(get('member')).toMatchObject({ own: '会员可享', competitor: '会员可享' })
    expect(get('rank')).toMatchObject({ own: '第 100 名（行李箱）', competitor: '第 80 名（行李箱）' })
  })

  it('竞品还没有快照、我方没有摘要：对应格子为 null', () => {
    const rows = buildCompare({ competitor: null, own: undefined, ownPrice: undefined, ownSummary: undefined, ownRank: null, rankNote: '原因' })
    expect(rows.every(row => row.own === null && row.competitor === null)).toBe(true)
    expect(rows.find(row => row.key === 'rank')?.note).toBe('原因')
  })
})
