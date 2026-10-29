import type {
  BaBasketResponse,
  BaBreakpointSummary,
  BaCatalogResponse,
  BaCommon,
  BaFunnelStage,
  BaQuadrantSummary,
  BaRepeatResponse,
  BaSearchQueryResponse,
  BaShareSet,
  BaTermsResponse,
} from '@nova/api-contracts'

// 品牌分析页测试用的接口返回（真实形状；数值取整，便于核对）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const pageInfo = (hasMore = false) => ({ pageSize: 20, nextCursor: hasMore ? 'cursor-2' : null, hasMore, approxTotal: null })
export const shares = (over: Partial<BaShareSet> = {}): BaShareSet => ({ impression: null, click: null, cartAdd: null, purchase: null, ...over })

export const common = (over: Partial<BaCommon> = {}): BaCommon => ({
  state: 'OK',
  note: null,
  period: { kind: 'WEEK', start: '2026-10-11', end: '2026-10-17', previousStart: '2026-10-04', available: ['2026-10-11', '2026-10-04'], defaulted: true },
  stores: [
    { sellerAccountId: 's1', storeName: '美国主店', state: 'AVAILABLE', stateLabel: '已同步', note: '品牌分析每周同步一次', lastSuccessAt: '2026-10-22T01:00:00.000Z' },
    { sellerAccountId: 's2', storeName: '美国二店', state: 'NO_BRAND', stateLabel: '未授权', note: '未授权：需要品牌分析角色', lastSuccessAt: null },
  ],
  truncated: false,
  basis: '品牌分析是亚马逊按周、月、季给出的汇总；份额由次数重算',
  freshness: { lastSuccessAt: '2026-10-22T01:00:00.000Z', sources: ['品牌分析·搜索查询表现'], qualityIssues: 0 },
  ...over,
})

const stage = (key: BaFunnelStage['key'], label: string, market: number, own: number, share: number, previousShare: number): BaFunnelStage => ({
  key,
  label,
  market,
  own,
  share,
  previousShare,
  shareChange: share - previousShare,
})

const quadrant: BaQuadrantSummary = {
  state: 'OK',
  note: '',
  medians: { volume: 5000, purchaseShare: 0.1 },
  counts: { STAR: 1, OPPORTUNITY: 1, NICHE: 0, WATCH: 0 },
  points: [
    { searchQuery: 'yoga mat', volume: 12000, purchaseShare: 0.1, quadrant: 'STAR' },
    { searchQuery: 'yoga block', volume: 3000, purchaseShare: 0.1, quadrant: 'NICHE' },
  ],
}
const breakpoints: BaBreakpointSummary = {
  state: 'OK',
  note: '',
  medians: shares({ impression: 0.2, click: 0.1, cartAdd: 0.1, purchase: 0.1 }),
  counts: { CLICK: 1, CART: 0, PURCHASE: 0 },
  examples: { CLICK: [{ searchQuery: 'yoga block', searchVolume: 3000, shares: shares({ impression: 0.1, click: 0.1, purchase: 0.1 }) }], CART: [], PURCHASE: [] },
}

export function sqp(over: Partial<BaSearchQueryResponse> = {}): BaSearchQueryResponse {
  return {
    ...common(),
    dimension: 'BRAND',
    selection: { asin: null, brand: null },
    asinOptions: [{ asin: 'B0AAAAAAA1', title: '瑜伽垫', brand: 'Acme', terms: 2 }],
    brandOptions: ['Acme'],
    funnel: [
      stage('impressions', '展示', 1500, 300, 0.2, 0.15),
      stage('clicks', '点击', 600, 100, 0.2, 0.15),
      stage('cartAdds', '加购', 150, 20, 0.133, 0.1),
      stage('purchases', '购买', 70, 7, 0.1, 0.08),
    ],
    trend: [
      { periodStart: '2026-10-04', volume: 11000, shares: shares({ impression: 0.15, purchase: 0.08 }) },
      { periodStart: '2026-10-11', volume: 15000, shares: shares({ impression: 0.2, purchase: 0.1 }) },
    ],
    trendNote: '趋势取搜索量最高的 500 个词',
    price: [
      { stage: 'click', label: '点击', own: 22, market: 20, gap: 0.1 },
      { stage: 'cartAdd', label: '加购', own: null, market: null, gap: null },
      { stage: 'purchase', label: '购买', own: 21, market: 20, gap: 0.05 },
    ],
    priceNote: '价格是各词中位价按搜索量加权的平均',
    shipping: [
      { speed: 'SAME_DAY', label: '当日达', own: 1, market: 5, share: 0.2 },
      { speed: 'ONE_DAY', label: '次日达', own: null, market: null, share: null },
      { speed: 'TWO_DAY', label: '两日达', own: 2, market: 25, share: 0.08 },
    ],
    quadrant,
    breakpoints,
    overview: {
      state: 'OK',
      note: '',
      rows: [{ root: 'yoga', forms: ['yoga mat', 'yoga block'], terms: 2, marketClicks: 600, ownClicks: 100, clickShare: 0.1667, marketPurchases: 70, ownPurchases: 7, purchaseShare: 0.1 }],
    },
    items: [
      {
        key: 'yoga mat',
        searchQuery: 'yoga mat',
        searchVolume: 12000,
        searchScore: 1,
        shares: shares({ impression: 0.25, click: 0.2, cartAdd: 0.15, purchase: 0.1 }),
        changes: shares({ purchase: 0.02, click: -0.012 }),
        ownPurchases: 5,
        marketPurchases: 50,
        advertising: 'NONE',
        quadrant: 'STAR',
        breakpoint: null,
      },
      {
        key: 'yoga block',
        searchQuery: 'yoga block',
        searchVolume: 3000,
        searchScore: null,
        shares: shares({ impression: 0.1, click: 0.1, purchase: null }),
        changes: shares(),
        ownPurchases: null,
        marketPurchases: 20,
        advertising: 'ADVERTISED',
        quadrant: null,
        breakpoint: 'CLICK',
      },
    ],
    pageInfo: pageInfo(),
    ...over,
  }
}

export function catalog(over: Partial<BaCatalogResponse> = {}): BaCatalogResponse {
  return {
    ...common(),
    summary: { impressions: 10000, clicks: 400, cartAdds: 60, purchases: 30, clickRate: 0.04, cartAddRate: 0.15, purchaseRate: 0.5, searchTrafficSales: 660 },
    items: [
      {
        key: 'B0AAAAAAA1',
        asin: 'B0AAAAAAA1',
        title: '瑜伽垫',
        productId: 'p1',
        brand: 'Acme',
        impressions: 10000,
        clicks: 400,
        cartAdds: 60,
        purchases: 30,
        clickRate: 0.04,
        cartAddRate: 0.15,
        purchaseRate: 0.5,
        searchTrafficSales: 660,
        previous: { clickRate: 0.03, cartAddRate: null, purchaseRate: 0.5 },
        allSales: 3300,
        sessions: 800,
        searchSalesShare: 0.2,
        clicksPerSession: 0.5,
      },
      {
        key: 'B0AAAAAAA2',
        asin: 'B0AAAAAAA2',
        title: null,
        productId: null,
        brand: null,
        impressions: null,
        clicks: null,
        cartAdds: null,
        purchases: null,
        clickRate: null,
        cartAddRate: null,
        purchaseRate: null,
        searchTrafficSales: null,
        previous: null,
        allSales: null,
        sessions: null,
        searchSalesShare: null,
        clicksPerSession: null,
      },
    ],
    pageInfo: pageInfo(),
    compareNote: '目录表现的点击率等由次数重算；业务报告的销售额与会话是另一个口径，只作对照',
    ...over,
  }
}

export function terms(over: Partial<BaTermsResponse> = {}): BaTermsResponse {
  return {
    ...common(),
    groupCounts: { top3: 1, OPPORTUNITY: 1, RISK: 0 },
    groupBasis: '机会词：我方没进前三且排名上升至少 20%',
    competitorNote: '尚未接入：竞品监控随“竞品监控”工作包（P4-12）交付',
    items: [
      {
        key: 'Sports|yoga mat',
        department: 'Sports',
        searchTerm: 'yoga mat',
        rank: 120,
        previousRank: 100,
        rankChange: -20,
        slots: [
          { rank: 1, asin: 'B0AAAAAAA1', title: '瑜伽垫', clickShare: 0.3, conversionShare: 0.2, own: true },
          { rank: 2, asin: 'B0XXXXXXX1', title: null, clickShare: 0.2, conversionShare: null, own: false },
        ],
        inTop3: true,
        group: null,
      },
      { key: '|tea cup', department: '', searchTerm: 'tea cup', rank: 300, previousRank: 400, rankChange: 100, slots: [], inTop3: false, group: 'OPPORTUNITY' },
    ],
    pageInfo: pageInfo(),
    history: null,
    ownAsinCount: 2,
    ...over,
  }
}

export function basket(over: Partial<BaBasketResponse> = {}): BaBasketResponse {
  return {
    ...common(),
    matrix: { rows: ['B0AAAAAAA1'], columns: ['B0AAAAAAA2', 'B0XXXXXXX1', 'B0XXXXXXX2'], cells: [[0.12, 0.06, null]], max: 0.12 },
    adviceBasis: '同篮率不低于 10% 且两个都是我方 ASIN → 捆绑销售候选',
    adviceCounts: { BUNDLE: 1, PRODUCT_TARGETING: 1 },
    items: [
      {
        key: 'a',
        asin: 'B0AAAAAAA1',
        asinTitle: '瑜伽垫',
        asinProductId: 'p1',
        pairedAsin: 'B0AAAAAAA2',
        pairedTitle: '瑜伽砖',
        pairedOwn: true,
        combinationPct: 0.12,
        previousPct: 0.1,
        change: 0.02,
        purchaseRank: 1,
        advice: 'BUNDLE',
      },
      {
        key: 'b',
        asin: 'B0AAAAAAA1',
        asinTitle: '瑜伽垫',
        asinProductId: 'p1',
        pairedAsin: 'B0XXXXXXX1',
        pairedTitle: null,
        pairedOwn: false,
        combinationPct: 0.06,
        previousPct: null,
        change: null,
        purchaseRank: null,
        advice: 'PRODUCT_TARGETING',
      },
    ],
    pageInfo: pageInfo(),
    ...over,
  }
}

export function repeat(over: Partial<BaRepeatResponse> = {}): BaRepeatResponse {
  return {
    ...common(),
    dimension: 'ASIN',
    summary: { orders: 150, uniqueCustomers: 100, repeatCustomersPct: 0.18, repeatRevenue: 600, repeatRevenuePct: null },
    trend: [
      { periodStart: '2026-10-04', orders: 100, uniqueCustomers: 80, repeatCustomersPct: 0.15, repeatRevenue: 400, repeatRevenuePct: null },
      { periodStart: '2026-10-11', orders: 150, uniqueCustomers: 100, repeatCustomersPct: 0.18, repeatRevenue: 600, repeatRevenuePct: null },
    ],
    items: [
      {
        key: 'B0AAAAAAA1',
        label: 'B0AAAAAAA1',
        asin: 'B0AAAAAAA1',
        title: '瑜伽垫',
        productId: 'p1',
        asins: 1,
        orders: 100,
        uniqueCustomers: 80,
        repeatCustomersPct: 0.2,
        repeatRevenue: 500,
        repeatRevenuePct: 0.25,
        previousRepeatCustomersPct: 0.15,
        repeatCustomersChange: 0.05,
      },
      {
        key: 'B0AAAAAAA3',
        label: 'B0AAAAAAA3',
        asin: 'B0AAAAAAA3',
        title: null,
        productId: null,
        asins: 1,
        orders: 10,
        uniqueCustomers: null,
        repeatCustomersPct: null,
        repeatRevenue: null,
        repeatRevenuePct: null,
        previousRepeatCustomersPct: null,
        repeatCustomersChange: null,
      },
    ],
    pageInfo: pageInfo(),
    repeatNote: '官方给的是“复购买家占比”，不是复购订单占比；汇总按独立买家数加权',
    ...over,
  }
}
