import type { AdsEntityMetrics, Asin360AdsDailyPoint, Asin360AdsResponse } from '@nova/api-contracts'

// ASIN 360 广告页签的测试数据：数字与服务端真实数据库测试的种子一致（花费 30、广告销售额 90、全部销售额 400、广告占比 7.5%）。

const metrics = (spend: number | null, sales: number | null, orders = 1): AdsEntityMetrics => ({ impressions: 400, clicks: 40, spend, sales, orders })
const point = (date: string, spend: number | null, sales: number | null, totalSales: number | null): Asin360AdsDailyPoint => ({
  date,
  impressions: spend === null ? null : 100,
  clicks: spend === null ? null : 10,
  spend,
  sales,
  orders: spend === null ? null : 1,
  totalSales,
  acos: spend !== null && sales ? spend / sales : null,
  adsShare: spend !== null && totalSales ? spend / totalSales : null,
})

const NOT_CONNECTED_NOTE = '这个商品所在的店铺还没有绑定广告账户，没有广告数据可显示；请在连接中心把广告账户绑定到这个店铺'
const SHARED = '广告活动一行的数字是这个 ASIN 自己的。广告组、投放对象与搜索词的数字是它们各自的合计，亚马逊没有按 ASIN 拆开。'
const BRAND = '品牌分析的搜索词份额在品牌分析模块（P4-04）上线后接入；在此之前不显示这份清单。'

export const adsFixture = (over: Partial<Asin360AdsResponse> = {}): Asin360AdsResponse => ({
  state: 'OK',
  note: null,
  range: { from: '2026-10-01', to: '2026-10-03', defaulted: false },
  currency: 'USD',
  summary: {
    totals: { impressions: 400, clicks: 40, spend: 30, sales: 90, orders: 4 },
    ratios: { acos: 1 / 3, roas: 3, ctr: 0.1, cpc: 0.75, cvr: 0.1 },
    totalSales: 400,
    adsShare: 0.075,
    organicSales: 310,
    organicIssue: null,
    campaigns: 2,
    ads: { enabled: 3, total: 4 },
  },
  trend: [point('2026-10-01', null, null, null), point('2026-10-02', 8, 20, 100), point('2026-10-03', 22, 70, 300)],
  halo: { state: 'OK', note: null, sales: 15 },
  stock: { stock: 'OUT_OF_STOCK', sellable: 0, snapshotDate: '2026-10-03', spend: 30 },
  campaigns: {
    state: 'OK',
    note: null,
    truncated: false,
    items: [
      { key: 'ap-a|c1', id: 'cam-1', adsProfileId: 'ap-a', externalCampaignId: 'c1', name: '春季推广', state: 'ENABLED', productLabel: '商品推广', metrics: metrics(20, 80, 3) },
      { key: 'ap-a|c2', id: null, adsProfileId: 'ap-a', externalCampaignId: 'c2', name: null, state: null, productLabel: null, metrics: metrics(5, 0, 0) },
      { key: 'ap-a|c8', id: 'cam-8', adsProfileId: 'ap-a', externalCampaignId: 'c8', name: '秋季推广', state: 'PAUSED', productLabel: '商品推广', metrics: null },
    ],
  },
  adGroups: {
    state: 'OK',
    note: null,
    truncated: false,
    items: [
      {
        id: 'ag-1',
        adsProfileId: 'ap-a',
        adGroupId: 'AG1',
        name: '核心词组',
        state: 'ENABLED',
        defaultBid: 1.2,
        externalCampaignId: 'c1',
        campaignName: '春季推广',
        campaignId: 'cam-1',
        asinAds: { enabled: 1, total: 2 },
        groupAsins: 2,
        metrics: metrics(30, 90, 4),
      },
    ],
  },
  targets: {
    state: 'OK',
    note: null,
    truncated: false,
    items: [
      {
        id: 'kw-1',
        key: 'KEYWORD:K1',
        targetId: 'K1',
        kind: 'KEYWORD',
        expression: 'yoga mat',
        matchType: 'EXACT',
        bid: 1.5,
        state: 'ENABLED',
        adGroupId: 'AG1',
        adGroupName: '核心词组',
        suggestedBid: null,
        metrics: null,
      },
    ],
  },
  searchTerms: {
    state: 'OK',
    note: null,
    truncated: false,
    matchBasis: '已投放与已否定按完全相同判断（不分大小写）',
    items: [
      { searchTerm: 'cheap yoga mat', status: 'NEGATED', metrics: { impressions: 400, clicks: 40, spend: 25, sales: 0, orders: 0 } },
      { searchTerm: 'yoga mat', status: 'TARGETED', metrics: { impressions: 200, clicks: 10, spend: 18, sales: 100, orders: 4 } },
    ],
  },
  brandGaps: { state: 'NOT_CONNECTED', note: BRAND },
  sharedNote: SHARED,
  basis: '花费、广告销售额、订单来自被推广商品日报表（只含美元）；没有记录的日子留空，不当 0。',
  ...over,
})

const none = { state: 'NOT_CONNECTED' as const, note: NOT_CONNECTED_NOTE, items: [], truncated: false }

/** 店铺没有绑定广告账户。 */
export const unboundFixture = (): Asin360AdsResponse =>
  adsFixture({
    state: 'NOT_CONNECTED',
    note: NOT_CONNECTED_NOTE,
    summary: {
      ...adsFixture().summary,
      totals: { impressions: 0, clicks: 0, spend: null, sales: null, orders: 0 },
      ratios: { acos: null, roas: null, ctr: null, cpc: null, cvr: null },
      totalSales: null,
      adsShare: null,
      organicSales: null,
      campaigns: 0,
      ads: null,
    },
    trend: [],
    halo: { state: 'NOT_CONNECTED', note: NOT_CONNECTED_NOTE, sales: null },
    stock: { stock: 'UNKNOWN', sellable: null, snapshotDate: null, spend: null },
    campaigns: none,
    adGroups: none,
    targets: none,
    searchTerms: { ...none, matchBasis: '' },
  })
