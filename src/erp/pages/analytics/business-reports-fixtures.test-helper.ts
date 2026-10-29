import {
  BR_DEVICE_SPLIT_NOTE,
  BR_METRIC_INFO,
  BR_METRIC_KEYS,
  BR_NO_DATA_NOTE,
  type BrAsinResponse,
  type BrAsinRow,
  type BrCard,
  type BrDateResponse,
  type BrFigures,
  type BrPoint,
  type BrSummaryResponse,
  type BrTrendsResponse,
} from '@nova/api-contracts'

// 业务报告页测试用的接口返回（真实形状；数值取整，便于核对）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const EMPTY: BrFigures = {
  orderedSales: null,
  unitsOrdered: null,
  ordersCount: null,
  sessions: null,
  pageViews: null,
  unitSessionPct: null,
  avgPrice: null,
  buyBoxPct: null,
  unitsRefunded: null,
  refundRate: null,
}
export const figures = (over: Partial<BrFigures> = {}): BrFigures => ({ ...EMPTY, ...over })

const FULL: BrFigures = {
  orderedSales: 1200,
  unitsOrdered: 60,
  ordersCount: 50,
  sessions: 2000,
  pageViews: 3000,
  unitSessionPct: 0.03,
  avgPrice: 20,
  buyBoxPct: 0.9,
  unitsRefunded: 3,
  refundRate: 0.05,
}

export const point = (date: string, over: Partial<BrPoint> = {}): BrPoint => ({ date, source: 'DATA_KIOSK', ...FULL, ...over })
export const gap = (date: string): BrPoint => ({ date, source: null, ...EMPTY })

const freshness = { lastSuccessAt: '2026-10-22T01:00:00.000Z', sources: ['销售与流量'], qualityIssues: 0 }
const stores = [
  { sellerAccountId: 's1', storeName: '美国主店', state: 'AVAILABLE' as const, stateLabel: '已同步', note: '数据中心的销售与流量每天同步一次', lastSuccessAt: '2026-10-22T01:00:00.000Z' },
  { sellerAccountId: 's2', storeName: '美国二店', state: 'NO_BRAND' as const, stateLabel: '未授权', note: '未授权：需要品牌分析角色', lastSuccessAt: null },
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

const cardOf = (key: (typeof BR_METRIC_KEYS)[number], value: number | null, compareValue: number | null, change: number | null): BrCard => {
  const info = BR_METRIC_INFO[key]
  return { key, label: info.label, format: info.format, goodWhen: info.goodWhen, value, compareValue, change, changeKind: info.format === 'percent' ? 'points' : 'ratio', basis: info.basis }
}

export function summary(over: Partial<BrSummaryResponse> = {}): BrSummaryResponse {
  const compare = { mode: 'previous' as const, from: '2026-10-05', to: '2026-10-07', days: 3 }
  const prior: BrFigures = { ...FULL, orderedSales: 1000, sessions: 2500, unitSessionPct: 0.02, refundRate: 0.04 }
  return {
    ...common,
    compare,
    coverage: { days: 3, withData: 2, reportOnly: 1 },
    cards: BR_METRIC_KEYS.map(key => {
      const value = FULL[key]
      const before = prior[key]
      const ratio = value !== null && before !== null && before > 0 ? value / before - 1 : null
      return cardOf(key, value, before, BR_METRIC_INFO[key].format === 'percent' && value !== null && before !== null ? value - before : ratio)
    }),
    deviceSplit: { state: 'NOT_CONNECTED', note: BR_DEVICE_SPLIT_NOTE },
    trend: [point('2026-10-08'), gap('2026-10-09'), point('2026-10-10', { source: 'REPORT', sessions: null })],
    compareTrend: [point('2026-10-05'), point('2026-10-06'), point('2026-10-07')],
    funnel: [
      { key: 'sessions', label: '会话', value: 2000, rate: null, rateKind: 'per', rateLabel: '' },
      { key: 'pageViews', label: '页面浏览量', value: 3000, rate: 1.5, rateKind: 'per', rateLabel: '每个会话的页面浏览量' },
      { key: 'ordersCount', label: '订单商品数', value: 50, rate: 0.016667, rateKind: 'percent', rateLabel: '订单商品数 ÷ 页面浏览量' },
      { key: 'unitsOrdered', label: '订购件数', value: 60, rate: 1.2, rateKind: 'per', rateLabel: '每个订单商品的件数' },
    ],
    attribution: {
      mode: 'THREE_FACTOR',
      factors: [
        { key: 'sessions', label: '会话', before: 2500, after: 2000 },
        { key: 'conversion', label: '转化率（件数 ÷ 会话）', before: 0.02, after: 0.03 },
        { key: 'unitPrice', label: '件单价', before: 20, after: 20 },
      ],
      sales: { before: 1000, after: 1200 },
    },
    attributionNote: null,
    split: { state: 'OK', note: null, adsSales: 300, organicSales: 900, adsShare: 0.25 },
    ...over,
  }
}

export const emptySummary = (): BrSummaryResponse =>
  summary({
    state: 'NO_DATA',
    note: BR_NO_DATA_NOTE,
    compare: null,
    latestDate: null,
    coverage: { days: 3, withData: 0, reportOnly: 0 },
    cards: BR_METRIC_KEYS.map(key => cardOf(key, null, null, null)),
    trend: [gap('2026-10-08'), gap('2026-10-09'), gap('2026-10-10')],
    compareTrend: null,
    funnel: summary().funnel.map(step => ({ ...step, value: null, rate: null })),
    attribution: null,
    attributionNote: '没有选择对比期，无法做变化归因（在顶部范围栏选择“环比”“同比”或自定义对比期）。',
    split: { state: 'NO_DATA', note: '所选范围内没有广告销售额：广告账户没有绑定店铺、广告报告还没同步', adsSales: null, organicSales: null, adsShare: null },
  })

export function byDate(over: Partial<BrDateResponse> = {}): BrDateResponse {
  return {
    ...common,
    granularity: 'DAY',
    compare: null,
    compareNote: null,
    points: [point('2026-10-08'), gap('2026-10-09'), point('2026-10-10', { orderedSales: 800 })],
    comparePoints: null,
    totals: figures({ orderedSales: 2000, unitsOrdered: 120, sessions: 4000, unitSessionPct: 0.03 }),
    ...over,
  }
}

const row = (over: Partial<BrAsinRow>): BrAsinRow => ({
  key: 's1|B000000001|',
  asin: 'B000000001',
  sku: null,
  parentAsin: null,
  title: null,
  storeName: '美国主店',
  productId: null,
  orderedSales: 500,
  unitsOrdered: 25,
  ordersCount: 20,
  sessions: 1000,
  pageViews: 1500,
  unitSessionPct: 0.025,
  avgPrice: 20,
  buyBoxPct: 0.8,
  ...over,
})

export function asinList(over: Partial<BrAsinResponse> = {}): BrAsinResponse {
  return {
    ...common,
    level: 'CHILD',
    items: [
      row({ title: '护眼台灯', productId: 'p1', parentAsin: 'B00000000P' }),
      row({ key: 's1|B000000002|', asin: 'B000000002', orderedSales: 300, unitsOrdered: 10, sessions: null, pageViews: null, unitSessionPct: null, avgPrice: 30, buyBoxPct: null }),
    ],
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
    ...over,
  }
}

export function trends(over: Partial<BrTrendsResponse> = {}): BrTrendsResponse {
  return {
    ...common,
    asin: 'B000000001',
    title: '护眼台灯',
    productId: 'p1',
    points: [point('2026-10-08'), gap('2026-10-09'), point('2026-10-10')],
    totals: figures({ orderedSales: 900, unitsOrdered: 45, sessions: 1800, unitSessionPct: 0.025 }),
    ...over,
  }
}
