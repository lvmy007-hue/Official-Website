import {
  ASIN360_PENDING_SECTIONS,
  ASIN360_COMPETITORS_BASIS,
  ASIN360_CONTENT_BASIS,
  ASIN360_LISTING_BASIS,
  ASIN360_PRICING_BASIS,
  ASIN360_REVIEWS_BASIS,
  ASIN360_TRAFFIC_BASIS,
  type Asin360CompetitorsResponse,
  type Asin360ContentResponse,
  type Asin360ListingResponse,
  type Asin360PricingResponse,
  type Asin360ReviewsResponse,
  type Asin360TrafficResponse,
  type BaFunnelStage,
} from '@nova/api-contracts'

// ASIN 360 流量转化、刊登、评价、定价、竞品、内容页签的测试数据。

const freshness = { lastSuccessAt: '2026-10-22T02:00:00Z', sources: ['数据中心·ASIN 销售与流量'], qualityIssues: 0 }
const RANGE = { from: '2026-10-01', to: '2026-10-03', defaulted: false }
const stage = (key: BaFunnelStage['key'], label: string, market: number, own: number, share: number, previousShare: number | null): BaFunnelStage => ({
  key,
  label,
  market,
  own,
  share,
  previousShare,
  shareChange: previousShare === null ? null : share - previousShare,
})

export const trafficFixture = (over: Partial<Asin360TrafficResponse> = {}): Asin360TrafficResponse => ({
  range: RANGE,
  daily: {
    state: 'OK',
    note: null,
    points: [
      { date: '2026-10-01', sessions: 100, pageViews: 150, units: 5, sales: 100, buyBoxPct: 0.9, unitSessionPct: 0.05 },
      { date: '2026-10-03', sessions: 300, pageViews: 450, units: 0, sales: 0, buyBoxPct: 0.5, unitSessionPct: 0 },
    ],
    summary: { sessions: 400, pageViews: 600, units: 5, sales: 100, unitSessionPct: 0.0125, buyBoxPct: 0.6, pageViewsPerSession: 1.5, days: 2 },
    truncated: false,
  },
  searchFunnel: {
    state: 'OK',
    note: null,
    period: { kind: 'WEEK', start: '2026-10-18', end: '2026-10-24', previousStart: '2026-10-11', available: ['2026-10-18', '2026-10-11'] },
    stages: [
      stage('impressions', '展示', 600, 300, 0.5, 0.5),
      stage('clicks', '点击', 200, 60, 0.3, 0.25),
      stage('cartAdds', '加购', 80, 20, 0.25, null),
      stage('purchases', '购买', 40, 8, 0.2, null),
    ],
    terms: [
      { searchQuery: '低点击词', searchVolume: 5000, shares: { impression: 0.5, click: 0.1, cartAdd: 0.1, purchase: 0.1 }, ownPurchases: 3, breakpoint: 'CLICK' },
      { searchQuery: 'yoga mat', searchVolume: 3000, shares: { impression: 0.5, click: 0.5, cartAdd: 0.5, purchase: 0.5 }, ownPurchases: 5, breakpoint: null },
    ],
    termCount: 6,
    breakpoints: { state: 'OK', note: '', counts: { CLICK: 1, CART: 0, PURCHASE: 0 }, medians: { impression: 0.5, click: 0.5, cartAdd: 0.5, purchase: 0.5 } },
    truncated: false,
  },
  catalogFunnel: {
    state: 'OK',
    note: null,
    period: { kind: 'WEEK', start: '2026-10-18', end: '2026-10-24', previousStart: '2026-10-11' },
    current: { impressions: 1000, clicks: 50, cartAdds: 10, purchases: 4, clickRate: 0.05, conversionRate: 0.08, searchTrafficSales: 80, currency: 'USD' },
    previous: null,
  },
  pending: [...ASIN360_PENDING_SECTIONS.traffic],
  freshness,
  basis: ASIN360_TRAFFIC_BASIS,
  ...over,
})

export const listingFixture = (over: Partial<Asin360ListingResponse> = {}): Asin360ListingResponse => ({
  facts: [
    { label: '标题', value: '示例商品标题' },
    { label: '品牌', value: '示例品牌' },
    { label: '商品类型', value: null },
    { label: '目录同步时间', value: '2026-10-22T02:00:00Z', kind: 'time' },
  ],
  pending: [...ASIN360_PENDING_SECTIONS.listing],
  basis: ASIN360_LISTING_BASIS,
  ...over,
})

export const reviewsFixture = (over: Partial<Asin360ReviewsResponse> = {}): Asin360ReviewsResponse => ({
  rating: {
    state: 'OK',
    note: null,
    sourceLabel: '文件导入',
    latest: { date: '2026-10-20', avgRating: 4.4, ratingCount: 1280, distribution: { '1': 40, '2': 30, '3': 100, '4': 300, '5': 810 }, sourceFileName: 'rating.csv' },
    points: [
      { date: '2026-10-13', avgRating: 4.3, ratingCount: 1200 },
      { date: '2026-10-20', avgRating: 4.4, ratingCount: 1280 },
    ],
  },
  topics: {
    state: 'OK',
    note: null,
    snapshotDate: '2026-10-20',
    positive: [{ rank: 1, topicKey: 'Easy to use', mentionRange: '100-200', reviewCountBucket: '50-100' }],
    negative: [{ rank: 1, topicKey: 'Battery life', mentionRange: '20-50', reviewCountBucket: '10-50' }],
  },
  category: {
    state: 'OK',
    note: null,
    browseNodeName: 'Headphones',
    month: '2026-09-01',
    previousMonth: '2026-08-01',
    rows: [{ topicKey: 'Easy to use', sentiment: 'POSITIVE', productRank: 1, allRate: 0.12, allPrevious: 0.1, top25Rate: 0.2, top25Previous: null }],
  },
  pending: [...ASIN360_PENDING_SECTIONS.reviews],
  basis: ASIN360_REVIEWS_BASIS,
  ...over,
})

export const contentFixture = (over: Partial<Asin360ContentResponse> = {}): Asin360ContentResponse => ({
  facts: [
    { label: '标题', value: '示例商品标题' },
    { label: '变体维度', value: null },
  ],
  imageUrl: null,
  aplus: {
    state: 'OK',
    note: null,
    items: [{ contentId: 'ap1', name: '品牌故事 A+', status: 'APPROVED', locale: 'en_US', publishedAt: '2026-10-01T00:00:00.000Z', amazonUpdatedAt: null, rejectionReason: null }],
    truncated: false,
  },
  pending: [...ASIN360_PENDING_SECTIONS.content],
  basis: ASIN360_CONTENT_BASIS,
  ...over,
})

export const pricingFixture = (over: Partial<Asin360PricingResponse> = {}): Asin360PricingResponse => ({
  range: RANGE,
  currency: 'USD',
  listPrice: { value: 19.9, currency: 'USD', updatedAt: '2026-10-22T02:00:00Z' },
  daily: {
    state: 'OK',
    note: null,
    points: [
      { date: '2026-10-01', units: 5, sales: 100, avgPrice: 20, buyBoxPct: 0.9 },
      { date: '2026-10-03', units: null, sales: null, avgPrice: null, buyBoxPct: 0.5 },
    ],
    avgPrice: 20,
    buyBoxPct: 0.6,
  },
  pending: [...ASIN360_PENDING_SECTIONS.pricing],
  basis: ASIN360_PRICING_BASIS,
  ...over,
})

export const competitorsFixture = (over: Partial<Asin360CompetitorsResponse> = {}): Asin360CompetitorsResponse => ({
  terms: {
    state: 'OK',
    note: null,
    period: { kind: 'WEEK', start: '2026-10-18', end: '2026-10-24', previousStart: null, available: ['2026-10-18'] },
    rows: [
      {
        searchTerm: 'yoga mat',
        frequencyRank: 120,
        slots: [
          { rank: 1, asin: 'B0RIVAL001', title: '对手一', clickShare: 0.3, conversionShare: 0.2, isSelf: false, isOwn: false },
          { rank: 2, asin: 'B0TEST0001', title: '示例商品标题', clickShare: 0.2, conversionShare: 0.1, isSelf: true, isOwn: true },
          { rank: 3, asin: 'B0OWN00001', title: '我方另一个', clickShare: 0.1, conversionShare: 0.1, isSelf: false, isOwn: true },
        ],
        selfRank: 2,
      },
    ],
  },
  pending: [...ASIN360_PENDING_SECTIONS.competitors],
  basis: ASIN360_COMPETITORS_BASIS,
  ...over,
})
