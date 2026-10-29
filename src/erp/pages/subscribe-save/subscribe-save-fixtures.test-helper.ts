import {
  SNS_BASIS,
  SNS_CANCEL_NOTE,
  SNS_REPLENISH_NOTE,
  type SnsAsinListResponse,
  type SnsAsinRow,
  type SnsCard,
  type SnsOfferListResponse,
  type SnsOfferRow,
  type SnsOverviewResponse,
  type SnsSync,
} from '@nova/api-contracts'

// 订阅省页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const freshness = { lastSuccessAt: '2026-10-24T08:00:00.000Z', sources: ['补货与订阅省'], qualityIssues: 0 }
export const normalSync: SnsSync = { status: 'NORMAL', statusLabel: '正常', lastSuccessAt: '2026-10-24T08:00:00.000Z', errorCode: null, errorMessage: null, rolePending: false }
export const pendingSync: SnsSync = { status: 'UNAUTHORIZED', statusLabel: '未授权', lastSuccessAt: null, errorCode: 'ROLE_MISSING', errorMessage: '补货接口角色未获批', rolePending: true }

const card = (over: Partial<SnsCard> & Pick<SnsCard, 'key' | 'label'>): SnsCard => ({ unit: 'count', value: null, currency: null, others: [], previous: null, state: 'OK', note: null, ...over })

export const cards = (): SnsCard[] => [
  card({ key: 'activeSubscribers', label: '活跃订阅数', value: 50, note: '截至 2026-10-22' }),
  card({ key: 'shippedUnits', label: '订阅出货件数', value: 27, previous: 18, note: '范围内 2 / 30 天有日级记录' }),
  card({ key: 'revenue', label: '订阅销售额', unit: 'money', value: 489.78, currency: 'USD', previous: 300, others: [{ currency: 'CAD', amount: 50 }] }),
  card({ key: 'cancellations', label: '订阅取消数', state: 'NOT_CONNECTED', note: SNS_CANCEL_NOTE }),
  card({ key: 'forecast30', label: '未来 30 天预计订阅出货件数', value: 36 }),
  card({ key: 'forecast60', label: '未来 60 天预计订阅出货件数', value: 70 }),
  card({ key: 'forecast90', label: '未来 90 天预计订阅出货件数', state: 'STALE', note: '快照已超过 7 天' }),
  card({ key: 'offers', label: '参与订阅省的报价', value: 3, note: '可订阅 2，不可订阅或已暂停 1' }),
]

export const overview = (over: Partial<SnsOverviewResponse> = {}): SnsOverviewResponse => ({
  state: 'OK',
  note: null,
  range: { from: '2026-09-25', to: '2026-10-24', days: 30, defaulted: true },
  compare: { from: '2026-08-26', to: '2026-09-24', days: 30 },
  sync: normalSync,
  cards: cards(),
  trend: {
    currency: 'USD',
    points: [
      { date: '2026-10-22', activeSubscribers: 50, shippedUnits: 17, revenue: 289.88 },
      { date: '2026-10-23', activeSubscribers: null, shippedUnits: null, revenue: null },
    ],
    months: [{ month: '2026-09', activeSubscribers: 38, shippedUnits: 300, revenue: 5000 }],
    coverage: { dataDays: 2, rangeDays: 30 },
  },
  forecast: { snapshotDate: '2026-10-23', offers: 3, offersWithForecast: 2, staleStores: [], usedInReplenishment: 1 },
  truncated: false,
  freshness,
  basis: SNS_BASIS,
  replenishNote: SNS_REPLENISH_NOTE,
  ...over,
})

export const asinRow = (over: Partial<SnsAsinRow> = {}): SnsAsinRow => ({
  key: 's1|B0AAAAAAA1',
  asin: 'B0AAAAAAA1',
  skus: ['SKU-A', 'SKU-B'],
  sellerAccountId: 's1',
  storeName: '美国主店',
  snapshotDate: '2026-10-23',
  subscriptions: 41,
  shippedUnitsPrevMonth: 30,
  forecastNext30: 36,
  forecastNext60: 70,
  forecastNext90: null,
  replenishment: { used: true, reason: null },
  productId: 'p1',
  ...over,
})

export const offerRow = (over: Partial<SnsOfferRow> = {}): SnsOfferRow => ({
  key: 's1|SKU-A',
  sku: 'SKU-A',
  asin: 'B0AAAAAAA1',
  sellerAccountId: 's1',
  storeName: '美国主店',
  snapshotDate: '2026-10-23',
  eligibility: 'ELIGIBLE',
  eligibilityLabel: '可订阅',
  fulfillment: 'AMAZON',
  discountPct: 5,
  price: 19.99,
  currency: 'USD',
  inventory: 320,
  stockRisk: null,
  subscriptions: 41,
  forecastNext30: 36,
  replenishment: { used: true, reason: null },
  ...over,
})

const page = { pageSize: 25, hasMore: false, nextCursor: null, approxTotal: 1 }
const listBase = { state: 'OK' as const, note: null, truncated: false, snapshotDate: '2026-10-23', staleStores: [] as string[], sync: normalSync, freshness, basis: SNS_BASIS }

export const asinList = (items: SnsAsinRow[] = [asinRow()], over: Partial<SnsAsinListResponse> = {}): SnsAsinListResponse => ({
  ...listBase,
  state: items.length ? 'OK' : 'NO_DATA',
  items,
  pageInfo: { ...page, approxTotal: items.length },
  ...over,
})

export const offerList = (items: SnsOfferRow[] = [offerRow()], over: Partial<SnsOfferListResponse> = {}): SnsOfferListResponse => ({
  ...listBase,
  state: items.length ? 'OK' : 'NO_DATA',
  items,
  pageInfo: { ...page, approxTotal: items.length },
  ...over,
})
