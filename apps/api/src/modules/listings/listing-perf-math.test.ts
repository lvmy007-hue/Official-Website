import { describe, expect, it } from 'vitest'
import { anomalySummary, buildListingRows, demandDaysOf, preferTraffic, trendPoints, type ProductRecord, type TrafficFact } from './listing-perf-math'

const record = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  id: 'p1',
  sellerAccountId: 's1',
  storeName: '店铺 1',
  asin: 'B0A',
  sellerSku: 'SKU-1',
  title: '商品',
  imageUrl: null,
  brand: null,
  listingStatus: 'ACTIVE',
  fulfillmentChannel: 'AFN',
  price: null,
  currency: 'USD',
  ownerUserId: null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
})
const fact = (over: Partial<TrafficFact> = {}): TrafficFact => ({ sessions: 200, pageViews: 300, units: 20, sales: 400, buyBox: 0.8, ...over })
const build = (over: Partial<Parameters<typeof buildListingRows>[0]> = {}) =>
  buildListingRows({
    records: [record()],
    current: new Map(),
    previous: new Map(),
    ads: null,
    returns: null,
    recentUnits: new Map(),
    stock: null,
    demandDays: 7,
    names: new Map(),
    formerLabel: '已离开的成员',
    ...over,
  })

describe('preferTraffic：同店同 ASIN 整段范围只用一个来源', () => {
  it('两个来源都有时用数据中心，不混合；只有报告时用报告', () => {
    const base = { sellerAccountId: 's1', pageViews: null, units: null, sales: null, buyBox: null }
    const result = preferTraffic([
      { ...base, asin: 'B0A', source: 'REPORT', sessions: 9999 },
      { ...base, asin: 'B0A', source: 'DATA_KIOSK', sessions: 100 },
      { ...base, asin: 'B0B', source: 'REPORT', sessions: 5 },
    ])
    expect(result.get('s1|B0A')?.sessions).toBe(100)
    expect(result.get('s1|B0B')?.sessions).toBe(5)
  })
})

describe('buildListingRows：装配', () => {
  it('没有流量记录：销量、转化率都是 null，不是 0；退货表为 null 时退货率也是 null', () => {
    const [row] = build()
    expect(row).toMatchObject({ sessions: null, units: null, sales: null, conversion: null, returnRate: null, adsSales: null, daysOfSupply: null, salesShared: false, anomalies: [] })
  })

  it('有流量：转化率、退货率（退货表已同步但这个 ASIN 没有退货算 0）、可售天数、广告销售额', () => {
    const [row] = build({
      current: new Map([['s1|B0A', fact()]]),
      returns: new Map(),
      ads: new Map([['s1|B0A', 12.345]]),
      stock: new Map([['s1\u001fSKU-1', 20]]),
      recentUnits: new Map([['s1|B0A', 14]]),
    })
    expect(row).toMatchObject({ conversion: 0.1, returnRate: 0, adsSales: 12.35, daysOfSupply: 10, buyBox: 0.8 })
  })

  it('同店同 ASIN 有多个 SKU 时标记共用销售；负责人不在成员表里显示“已离开”', () => {
    const rows = build({
      records: [record(), record({ id: 'p2', sellerSku: 'SKU-2', ownerUserId: 'gone' })],
      current: new Map([['s1|B0A', fact()]]),
    })
    expect(rows.map(row => row.salesShared)).toEqual([true, true])
    expect(rows[1]?.ownerName).toBe('已离开的成员')
  })

  it('转化率骤降：两期会话 ≥ 100 且相对下降 ≥ 30%；样本不足不报', () => {
    const drop = build({ current: new Map([['s1|B0A', fact({ units: 10 })]]), previous: new Map([['s1|B0A', fact()]]) })
    expect(drop[0]?.anomalies).toEqual(['CONVERSION_DROP'])
    const small = build({ current: new Map([['s1|B0A', fact({ sessions: 50, units: 1 })]]), previous: new Map([['s1|B0A', fact()]]) })
    expect(small[0]?.anomalies).toEqual([])
  })
})

describe('anomalySummary', () => {
  it('没有可比较的商品：转化率骤降是“无数据”；另外三类固定“尚未接入”且计数是 null', () => {
    const [drop, ...rest] = anomalySummary(build())
    expect(drop).toMatchObject({ kind: 'CONVERSION_DROP', state: 'NO_DATA', count: null })
    expect(rest.map(item => [item.state, item.count])).toEqual([
      ['NOT_CONNECTED', null],
      ['NOT_CONNECTED', null],
      ['NOT_CONNECTED', null],
    ])
  })
})

describe('demandDaysOf、trendPoints', () => {
  it('日均件数用最后 7 天，范围更短就用范围天数', () => {
    expect([demandDaysOf(30), demandDaysOf(7), demandDaysOf(3), demandDaysOf(1)]).toEqual([7, 7, 3, 1])
  })

  it('趋势：同店同日数据中心优先；跨店相加；转化率只用件数与会话成对的；没有记录的日期是 null', () => {
    const group = (over: Record<string, unknown>) => ({
      sellerAccountId: 's1',
      date: '2026-10-01',
      source: 'DATA_KIOSK',
      sessions: 100,
      pageViews: 150,
      units: 10,
      sales: 200,
      buyBoxSum: 0.9,
      buyBoxCount: 1,
      ...over,
    })
    const points = trendPoints(
      ['2026-10-01', '2026-10-02'],
      [group({}), group({ source: 'REPORT', sessions: 9999 }), group({ sellerAccountId: 's2', sessions: 50, units: 5, sales: 50, buyBoxSum: null, buyBoxCount: 0 })],
    )
    expect(points[0]).toMatchObject({ sessions: 150, units: 15, sales: 250, conversion: 0.1, buyBox: 0.9 })
    expect(points[1]).toMatchObject({ sessions: null, units: null, sales: null, conversion: null, buyBox: null })
  })
})
