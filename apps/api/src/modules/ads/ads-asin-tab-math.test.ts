import type { AdsSearchTermRow, AdsTargetRow, AdsTotals } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import {
  adGroupRowsOf,
  bySpendDesc,
  campaignRowsOf,
  dailyPoints,
  mergeTargetRows,
  mergeTerms,
  profileCampaignKey,
  recordMap,
  summaryOf,
  type AdGroupRecord,
  type CampaignRecord,
} from './ads-asin-tab-math'

// ASIN 360 广告页签的纯函数（P3-19）：空值不是 0、占比与自然销售额的口径、活动行与广告组行的装配、跨档案合并与稳定排序。

const totals = (spend: number | null, sales: number | null, orders = 1): AdsTotals => ({ impressions: 100, clicks: 10, spend, sales, orders })

describe('bySpendDesc', () => {
  it('花费从高到低，空值在最后；并列按名称（不分大小写）再按键，顺序稳定', () => {
    const items = [
      { spend: null, name: 'z', key: '1' },
      { spend: 5, name: 'b', key: '2' },
      { spend: 9, name: 'a', key: '3' },
      { spend: 5, name: 'A', key: '4' },
      { spend: 5, name: 'a', key: '0' },
    ]
    const sorted = [...items].sort(
      bySpendDesc(
        item => item.spend,
        item => item.name,
        item => item.key,
      ),
    )
    expect(sorted.map(item => item.key)).toEqual(['3', '0', '4', '2', '1'])
  })
})

describe('dailyPoints', () => {
  it('每一天一个点：没有广告行的日子广告列全空、没有销售汇总的日子销售额与占比为空；有行但销售额为空的日子占比也为空', () => {
    const points = dailyPoints(
      ['2026-10-01', '2026-10-02', '2026-10-03'],
      new Map([
        ['2026-10-01', totals(10, 50, 2)],
        ['2026-10-03', totals(4, null)],
      ]),
      new Map([['2026-10-01', 200]]),
    )
    expect(points[0]).toMatchObject({ date: '2026-10-01', spend: 10, sales: 50, orders: 2, totalSales: 200, adsShare: 0.05 })
    expect(points[0].acos).toBeCloseTo(0.2)
    expect(points[1]).toEqual({ date: '2026-10-02', impressions: null, clicks: null, spend: null, sales: null, orders: null, totalSales: null, acos: null, adsShare: null })
    expect(points[2]).toMatchObject({ spend: 4, sales: null, acos: null, totalSales: null, adsShare: null })
  })
})

describe('summaryOf', () => {
  it('合计、广告占总销售比与自然销售额', () => {
    const summary = summaryOf({
      ads: new Map([
        ['d1', totals(20, 60)],
        ['d2', totals(10, 30)],
      ]),
      totalSales: 300,
      campaigns: 2,
      adCount: { enabled: 1, total: 2 },
    })
    expect(summary.totals).toMatchObject({ spend: 30, sales: 90, orders: 2 })
    expect(summary.adsShare).toBeCloseTo(0.1)
    expect(summary).toMatchObject({ organicSales: 210, organicIssue: null, campaigns: 2, ads: { enabled: 1, total: 2 } })
  })

  it('广告销售额大于全部销售额：不给自然销售额并标出原因', () => {
    const summary = summaryOf({ ads: new Map([['d1', totals(20, 500)]]), totalSales: 300, campaigns: 1, adCount: null })
    expect(summary).toMatchObject({ organicSales: null, organicIssue: 'ATTRIBUTION_EXCEEDS_TOTAL', ads: null })
  })

  it('没有广告行也没有销售汇总：全部为空，不是 0', () => {
    const summary = summaryOf({ ads: new Map(), totalSales: null, campaigns: 0, adCount: null })
    expect(summary.totals).toMatchObject({ spend: null, sales: null, orders: 0 })
    expect(summary).toMatchObject({ totalSales: null, adsShare: null, organicSales: null, organicIssue: null })
    expect(summary.ratios.acos).toBeNull()
  })
})

const campaign = (over: Partial<CampaignRecord>): CampaignRecord => ({
  id: 'cam-1',
  adsProfileId: 'ap-a',
  externalCampaignId: 'c1',
  adProduct: 'SPONSORED_BRANDS',
  name: '活动一',
  state: 'ENABLED',
  ...over,
})

describe('recordMap 与 campaignRowsOf', () => {
  it('同一外部编号有多条记录时优先取商品推广；活动记录没同步下来的行没有名称与链接编号', () => {
    const map = recordMap([campaign({ id: 'brand' }), campaign({ id: 'sp', adProduct: 'SPONSORED_PRODUCTS' }), campaign({ id: 'late', adProduct: 'SPONSORED_PRODUCTS' })])
    expect(map.get(profileCampaignKey('ap-a', 'c1'))?.id).toBe('sp')
    const rows = campaignRowsOf(
      [
        { adsProfileId: 'ap-a', campaignId: 'c1', totals: totals(12, 30) },
        { adsProfileId: 'ap-a', campaignId: 'c9', totals: totals(3, null) },
      ],
      [],
      map,
    )
    expect(rows[0]).toMatchObject({ key: 'ap-a|c1', id: 'sp', name: '活动一', state: 'ENABLED', metrics: { spend: 12, sales: 30 } })
    expect(rows[1]).toMatchObject({ key: 'ap-a|c9', id: null, name: null, state: null, productLabel: null, metrics: { spend: 3, sales: null } })
  })

  it('只有广告关联、范围内没有报表行的活动排在后面，指标为空而不是 0；已有报表行的不重复', () => {
    const map = recordMap([campaign({}), campaign({ id: 'cam-2', externalCampaignId: 'c2', name: 'Beta' }), campaign({ id: 'cam-3', externalCampaignId: 'c3', name: 'alpha' })])
    const rows = campaignRowsOf(
      [{ adsProfileId: 'ap-a', campaignId: 'c1', totals: totals(5, 5) }],
      [
        { adsProfileId: 'ap-a', campaignId: 'c1' },
        { adsProfileId: 'ap-a', campaignId: 'c2' },
        { adsProfileId: 'ap-a', campaignId: 'c3' },
        { adsProfileId: 'ap-a', campaignId: 'c3' },
      ],
      map,
    )
    expect(rows.map(row => row.key)).toEqual(['ap-a|c1', 'ap-a|c3', 'ap-a|c2'])
    expect(rows[1].metrics).toBeNull()
    expect(rows[2].metrics).toBeNull()
  })
})

describe('adGroupRowsOf', () => {
  const group = (adGroupId: string, name: string, over: Partial<AdGroupRecord> = {}): AdGroupRecord => ({
    id: `id-${adGroupId}`,
    adsProfileId: 'ap-a',
    adGroupId,
    campaignId: 'c1',
    name,
    state: 'ENABLED',
    defaultBid: 1.2,
    ...over,
  })

  it('带出所属活动、本 ASIN 的广告数、广告组内商品数与自己的指标；按花费从高到低，没有指标的在最后', () => {
    const rows = adGroupRowsOf([group('G1', '无指标'), group('G2', '花得多'), group('G3', '花得少', { defaultBid: null })], {
      asinAds: new Map([['ap-a|G2', { enabled: 1, total: 2 }]]),
      groupAsins: new Map([['ap-a|G2', 3]]),
      campaigns: recordMap([campaign({ adProduct: 'SPONSORED_PRODUCTS' })]),
      metrics: new Map([
        ['ap-a|G2', { impressions: 9, clicks: 3, spend: 20, sales: 60, orders: 2 }],
        ['ap-a|G3', { impressions: 1, clicks: 1, spend: 2, sales: null, orders: 0 }],
      ]),
    })
    expect(rows.map(row => row.adGroupId)).toEqual(['G2', 'G3', 'G1'])
    expect(rows[0]).toMatchObject({ campaignName: '活动一', campaignId: 'cam-1', asinAds: { enabled: 1, total: 2 }, groupAsins: 3, metrics: { spend: 20 } })
    expect(rows[1]).toMatchObject({ defaultBid: null, asinAds: { enabled: 0, total: 0 }, groupAsins: 0, metrics: { sales: null } })
    expect(rows[2].metrics).toBeNull()
  })

  it('所属活动记录没同步下来：活动名称与编号为空', () => {
    const [row] = adGroupRowsOf([group('G1', 'x')], { asinAds: new Map(), groupAsins: new Map(), campaigns: new Map(), metrics: new Map() })
    expect(row).toMatchObject({ externalCampaignId: 'c1', campaignName: null, campaignId: null })
  })
})

const target = (key: string, expression: string, spend: number | null) => ({ key, expression, metrics: { impressions: 1, clicks: 1, spend, sales: null, orders: 0 } }) as unknown as AdsTargetRow
const term = (searchTerm: string, spend: number | null, sales: number | null, status: AdsSearchTermRow['status'] = 'UNTARGETED'): AdsSearchTermRow => ({
  searchTerm,
  status,
  metrics: { impressions: 10, clicks: 2, spend, sales, orders: 1 },
})

describe('跨档案合并', () => {
  it('投放对象按花费从高到低合并，空值在最后', () => {
    const merged = mergeTargetRows([[target('a|1', 'x', 1), target('a|2', 'y', null)], [target('b|1', 'z', 7)]])
    expect(merged.map(row => row.key)).toEqual(['b|1', 'a|1', 'a|2'])
  })

  it('同一个搜索词合并：数量相加，金额只要有一边给了就算已知，两边都没有仍为空；状态取第一个', () => {
    const merged = mergeTerms([
      [term('yoga mat', 4, null), term('block', null, null)],
      [term('yoga mat', 6, 30, 'TARGETED'), term('block', null, null), term('strap', 1, 2)],
    ])
    expect(merged.map(row => row.searchTerm)).toEqual(['yoga mat', 'strap', 'block'])
    expect(merged[0]).toMatchObject({ status: 'UNTARGETED', metrics: { impressions: 20, clicks: 4, spend: 10, sales: 30, orders: 2 } })
    expect(merged[2].metrics).toMatchObject({ spend: null, sales: null })
  })

  it('合并不改动传入的行', () => {
    const first = term('a', 1, 1)
    mergeTerms([[first], [term('a', 2, 2)]])
    expect(first.metrics.spend).toBe(1)
  })
})
