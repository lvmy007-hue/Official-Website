import { LISTING_ANOMALY_INFO, LISTING_PENDING_COLUMNS, LISTING_PERF_BASIS, type ListingPerfResponse, type ListingPerfRow } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'

// 刊登表现页测试用的假服务端数据（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const perfRow = (patch: Partial<ListingPerfRow> = {}): ListingPerfRow => ({
  id: 'p1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0TEST0001',
  sku: 'SKU-1',
  title: '玻璃保鲜盒套装',
  imageUrl: null,
  brand: 'Acme',
  listingStatus: 'ACTIVE',
  fulfillmentChannel: 'AFN',
  price: 19.9,
  currency: 'USD',
  sessions: 200,
  pageViews: 300,
  units: 20,
  sales: 400,
  conversion: 0.1,
  buyBox: 0.8,
  sessionsPrev: 200,
  conversionPrev: 0.2,
  adsSales: 100,
  returnRate: 0.05,
  daysOfSupply: 10,
  salesShared: true,
  anomalies: [],
  ownerUserId: 'u1',
  ownerName: '林然',
  updatedAt: '2026-10-20T08:00:00Z',
  ...patch,
})

export const noTrafficRow = (patch: Partial<ListingPerfRow> = {}): ListingPerfRow =>
  perfRow({
    id: 'p3',
    sku: 'SKU-C',
    asin: 'B0CCCCCCCC',
    title: '没有流量的商品',
    brand: null,
    price: null,
    sessions: null,
    pageViews: null,
    units: null,
    sales: null,
    conversion: null,
    buyBox: null,
    sessionsPrev: null,
    conversionPrev: null,
    adsSales: null,
    returnRate: null,
    daysOfSupply: null,
    salesShared: false,
    ownerUserId: null,
    ownerName: null,
    ...patch,
  })

export const dropRow = () =>
  perfRow({ id: 'p5', sku: 'SKU-E', asin: 'B0EEEEEEEE', title: '转化率下降的商品', salesShared: false, conversion: 0.05, conversionPrev: 0.1, anomalies: ['CONVERSION_DROP'] })

const anomalies = (drop: number | null): ListingPerfResponse['anomalies'] => [
  {
    kind: 'CONVERSION_DROP',
    label: LISTING_ANOMALY_INFO.CONVERSION_DROP.label,
    state: drop === null ? 'NO_DATA' : 'OK',
    count: drop,
    note: LISTING_ANOMALY_INFO.CONVERSION_DROP.basis,
  },
  ...(['OFFER_LOST', 'ISSUE_NEW', 'SUPPRESSED'] as const).map(kind => ({
    kind,
    label: LISTING_ANOMALY_INFO[kind].label,
    state: 'NOT_CONNECTED' as const,
    count: null,
    note: `${LISTING_ANOMALY_INFO[kind].basis}（由 ${LISTING_ANOMALY_INFO[kind].pendingWorkPackage} 交付）`,
  })),
]

export const perfResponse = (patch: Partial<ListingPerfResponse> = {}): ListingPerfResponse => ({
  state: 'OK',
  note: null,
  items: [perfRow(), noTrafficRow()],
  pageInfo: { hasMore: false, nextCursor: null, approxTotal: 2 } as ListingPerfResponse['pageInfo'],
  range: { from: '2026-09-23', to: '2026-10-22', days: 30, defaulted: true },
  previousRange: { from: '2026-08-24', to: '2026-09-22', days: 30 },
  currency: 'USD',
  trend: {
    state: 'OK',
    note: null,
    points: [
      { date: '2026-10-21', sessions: 100, pageViews: 150, units: 10, sales: 200, conversion: 0.1, buyBox: 0.9 },
      { date: '2026-10-22', sessions: null, pageViews: null, units: null, sales: null, conversion: null, buyBox: null },
    ],
  },
  anomalies: anomalies(1),
  gates: { traffic: { state: 'OK', note: null }, ads: { state: 'OK', note: null }, returns: { state: 'OK', note: null }, stock: { state: 'OK', note: null } },
  pending: LISTING_PENDING_COLUMNS,
  filterOptions: { brands: ['Acme', 'Zeta'], categories: ['Home > Kitchen'], statuses: ['ACTIVE', 'INACTIVE'], owners: [{ id: 'u1', name: '林然' }] },
  truncated: false,
  freshness: { lastSuccessAt: '2026-10-22T02:00:00Z', sources: ['销售与流量'], qualityIssues: 0 } as ListingPerfResponse['freshness'],
  basis: LISTING_PERF_BASIS,
  ...patch,
})

export const emptyPerf = () =>
  perfResponse({
    state: 'NOT_CONNECTED',
    note: '可见范围内还没有同步到商品；连接店铺并同步商品目录后才会出现',
    items: [],
    pageInfo: { hasMore: false, nextCursor: null, approxTotal: 0 } as ListingPerfResponse['pageInfo'],
    trend: { state: 'NO_DATA', note: '所选日期范围内没有销售与流量记录', points: [] },
    anomalies: anomalies(null),
  })

export const perfHandlers = (response: () => ListingPerfResponse): Record<string, Handler> => ({
  '/listings/performance': () => ok(response()),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
})
