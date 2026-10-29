import {
  ASIN_ISSUE_NOTE,
  ASIN_METRIC_KEYS,
  ASIN_NO_ADS_NOTE,
  ASIN_NO_REVIEWS_NOTE,
  ASIN_RANK_PARENT_NOTE,
  ASIN_TREE_NOTE,
  type AsinAnalyticsResponse,
  type AsinPoint,
  type AsinSelection,
  type AsinValues,
  type MatrixRow,
  type ParentAdsResponse,
  type ParentChangesResponse,
  type ParentIdentityResponse,
  type ParentInventoryResponse,
  type ParentMatrixResponse,
  type ParentReviewsResponse,
  type ParentTrafficResponse,
  type ParentTrendResponse,
} from '@nova/api-contracts'

// ASIN 与父体分析页测试用的接口返回（真实形状；数值取整，便于核对）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const freshness = { lastSuccessAt: '2026-10-22T01:00:00.000Z', sources: ['销售与流量'], qualityIssues: 0 }
const stores = [
  { sellerAccountId: 's1', storeName: '美国主店', state: 'AVAILABLE' as const, stateLabel: '已同步', note: '数据中心的销售与流量每天同步一次', lastSuccessAt: '2026-10-22T01:00:00.000Z' },
]
const common = {
  state: 'OK' as const,
  note: null,
  range: { from: '2026-10-08', to: '2026-10-10', days: 3, defaulted: false },
  currency: 'USD' as const,
  stores,
  latestDate: '2026-10-10',
  truncated: false,
  basis: '销售额与件数是官方订购口径（下单时计）；日期是亚马逊美国站的日历日。',
  freshness,
}
export const PARENT = 'B0PARENT01'

const EMPTY = Object.fromEntries(ASIN_METRIC_KEYS.map(key => [key, null])) as AsinValues
export const values = (over: Partial<AsinValues> = {}): AsinValues => ({ ...EMPTY, ...over })
const DATES = ['2026-10-08', '2026-10-09', '2026-10-10']
const pointOf = (date: string, over: Partial<AsinValues> = {}): AsinPoint => ({ date, ...values(over) })

export const selectionOf = (kind: 'parent' | 'asin', asin: string, over: Partial<AsinSelection> = {}): AsinSelection => ({
  key: `${kind}:${asin}`,
  kind,
  asin,
  title: kind === 'parent' ? null : `商品 ${asin}`,
  productId: kind === 'asin' ? `prod-${asin}` : null,
  memberCount: kind === 'parent' ? 3 : 1,
  points: [pointOf(DATES[0]!), pointOf(DATES[1]!, { sales: 150, sessions: 300 }), pointOf(DATES[2]!, { sales: 50 })],
  totals: values({ sales: 200, units: 20, sessions: 300, conversion: 0.05, adsSales: null, daysOfSupply: 20.5 }),
  gaps: { adsSales: ASIN_NO_ADS_NOTE, salesRank: kind === 'parent' ? ASIN_RANK_PARENT_NOTE : '商品目录没有给出销售排名' },
  ...over,
})

export function asinAnalytics(over: Partial<AsinAnalyticsResponse> = {}): AsinAnalyticsResponse {
  return {
    ...common,
    filters: { brands: ['甲牌'], categories: ['家居'], tags: ['主推'], owners: [{ id: 'u1', name: '王运营' }] },
    treeNote: ASIN_TREE_NOTE,
    tree: [
      { key: 'asin:B0SINGLE01', kind: 'asin', asin: 'B0SINGLE01', title: '单品台灯', brand: '甲牌', childCount: 0, sales: 500, sessions: 1000, children: [] },
      {
        key: `parent:${PARENT}`,
        kind: 'parent',
        asin: PARENT,
        title: null,
        brand: '甲牌',
        childCount: 2,
        sales: 190,
        sessions: null,
        children: [
          { asin: 'B0CHILD001', title: '红色大号', productId: 'prod-c1', sales: 140, sessions: 300 },
          { asin: 'B0CHILD002', title: null, productId: null, sales: 50, sessions: null },
        ],
      },
    ],
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
    selectionDefaulted: true,
    selection: [selectionOf('asin', 'B0SINGLE01')],
    selectionNote: null,
    issueNote: ASIN_ISSUE_NOTE,
    ...over,
  }
}

export const identity = (over: Partial<ParentIdentityResponse> = {}): ParentIdentityResponse => ({
  ...common,
  parentAsin: PARENT,
  title: null,
  imageUrl: null,
  brand: '甲牌',
  category: '家居',
  variationTheme: 'COLOR_SIZE',
  childCount: 4,
  storeNames: ['美国主店'],
  sales: 200,
  conversion: 0.05,
  netProfit: { state: 'RESTRICTED', value: null, note: '需要“利润”读取权限才能查看净利润' },
  riskChildren: { state: 'NOT_CONNECTED', value: null, note: '还没有生效的补货策略，库存风险无法计算；先在补货策略里配置' },
  membersTruncated: false,
  ...over,
})

const row = (asin: string, attributes: Record<string, string>, over: Partial<MatrixRow> = {}): MatrixRow => ({
  asin,
  title: `商品 ${asin}`,
  productId: `prod-${asin}`,
  attributes,
  sales: null,
  units: null,
  sessions: null,
  conversion: null,
  share: null,
  risk: null,
  ...over,
})

export const matrix = (over: Partial<ParentMatrixResponse> = {}): ParentMatrixResponse => ({
  ...common,
  parentAsin: PARENT,
  metric: 'sales',
  rows: [
    row('B0CHILD001', { color: 'Red', size: 'L' }, { sales: 140, sessions: 300, conversion: 0.05, share: 0.7 }),
    row('B0CHILD002', { color: 'Red', size: 'S' }, { sales: 60, sessions: 100, conversion: 0.04, share: 0.3 }),
    row('B0CHILD004', {}, { title: null, productId: null }),
  ],
  scale: { min: 60, max: 140 },
  riskState: { state: 'RESTRICTED', note: '需要“库存”读取权限才能查看库存风险' },
  pivot: {
    state: 'OK',
    note: null,
    dimensions: ['color', 'size'],
    rowDim: 'color',
    colDim: 'size',
    rowValues: ['Red', '未填写'],
    colValues: ['L', 'S', '未填写'],
    cells: [
      { row: 'Red', col: 'L', asins: ['B0CHILD001'], sales: 140, units: 14, sessions: 300, conversion: 0.05, risk: null },
      { row: 'Red', col: 'S', asins: ['B0CHILD002'], sales: 60, units: 4, sessions: 100, conversion: 0.04, risk: null },
      { row: '未填写', col: '未填写', asins: ['B0CHILD004'], sales: null, units: null, sessions: null, conversion: null, risk: null },
    ],
  },
  ...over,
})

export const trend = (): ParentTrendResponse => ({
  ...common,
  parentAsin: PARENT,
  dates: DATES,
  series: [{ asin: 'B0CHILD001', title: '红色大号', sales: [null, 100, 40], sessions: [null, 200, 100], units: [null, 10, 4] }],
  others: null,
})

export const traffic = (compare = false): ParentTrafficResponse => ({
  ...common,
  parentAsin: PARENT,
  compareRange: compare ? { from: '2026-10-05', to: '2026-10-07' } : null,
  totalSessions: 400,
  compareTotalSessions: compare ? 500 : null,
  rows: [
    { asin: 'B0CHILD001', title: '红色大号', sessions: 300, share: 0.75, compareSessions: compare ? 300 : null, compareShare: compare ? 0.6 : null, shareChange: compare ? 0.15 : null },
    { asin: 'B0CHILD002', title: null, sessions: null, share: null, compareSessions: null, compareShare: null, shareChange: null },
  ],
})

export const inventory = (over: Partial<ParentInventoryResponse> = {}): ParentInventoryResponse => ({
  ...common,
  parentAsin: PARENT,
  policyState: 'NOT_CONNECTED',
  policyNote: '还没有生效的补货策略，风险与可售天数无法计算；先在补货策略里配置',
  replenishmentState: 'NO_DATA',
  replenishmentNote: '还没有生成过补货建议（在补货页重新计算后显示）',
  rows: [
    {
      asin: 'B0CHILD001',
      title: '红色大号',
      productId: 'prod-c1',
      skuCount: 2,
      sellable: 30,
      inboundCounted: 10,
      daysOfCover: null,
      stockoutDate: null,
      risk: null,
      recommendedQty: null,
      recommendedDue: null,
      recommendedChannel: null,
    },
  ],
  truncated: false,
  ...over,
})

export const ads = (over: Partial<ParentAdsResponse> = {}): ParentAdsResponse => ({
  ...common,
  parentAsin: PARENT,
  adsState: 'OK',
  adsNote: '广告销售按广告归因窗口计，与订购口径的销售额时点不同，占比只是估算',
  coveredCount: 1,
  gapCount: 1,
  totalSpend: 10,
  totalAdsSales: 50,
  rows: [
    { asin: 'B0CHILD001', title: '红色大号', coverage: 'COVERED', spend: 10, adsSales: 50, orders: 4, acos: 0.2, totalSales: 100, adsShare: 0.5, enabledAds: 2, totalAds: 3, gap: false },
    { asin: 'B0CHILD003', title: null, coverage: 'NO_ADS', spend: null, adsSales: null, orders: null, acos: null, totalSales: 30, adsShare: null, enabledAds: null, totalAds: null, gap: true },
  ],
  ...over,
})

export const reviews = (): ParentReviewsResponse => ({
  ...common,
  note: ASIN_NO_REVIEWS_NOTE,
  parentAsin: PARENT,
  reviewsState: 'NOT_CONNECTED',
  reviewsNote: ASIN_NO_REVIEWS_NOTE,
  positive: [],
  negative: [],
})

export const changes = (over: Partial<ParentChangesResponse> = {}): ParentChangesResponse => ({
  parentAsin: PARENT,
  items: [
    {
      id: 'e2',
      occurredAt: '2026-10-12T01:00:00.000Z',
      kind: 'variation.attribute_change',
      kindLabel: '变体属性变化',
      title: '变体属性 color 由「Red」变为「Rose」',
      childAsin: 'B0CHILD001',
      before: 'Red',
      after: 'Rose',
      actor: '亚马逊',
    },
    {
      id: 'e1',
      occurredAt: '2026-10-11T01:00:00.000Z',
      kind: 'variation.child_added',
      kindLabel: '新增子体',
      title: '新增子体 B0CHILD003',
      childAsin: 'B0CHILD003',
      before: null,
      after: PARENT,
      actor: '亚马逊',
    },
  ],
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
  truncated: false,
  note: null,
  ...over,
})
