import { PRODUCT_BASIS, PRODUCT_NOT_CONNECTED_NOTE, type ProductListResponse, type ProductListRow } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'

// 商品主数据页测试用的假服务端数据（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const productRow = (patch: Partial<ProductListRow> = {}): ProductListRow => ({
  id: 'p1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0TEST0001',
  sku: 'SKU-1',
  fnsku: 'X0TEST0001',
  title: '玻璃保鲜盒套装',
  imageUrl: null,
  parentAsin: 'B0PARENT01',
  brand: 'Acme',
  categoryPath: 'Home > Kitchen',
  fulfillmentChannel: 'AFN',
  listingStatus: 'ACTIVE',
  price: 19.9,
  currency: 'USD',
  sellable: 100,
  sales30: 580,
  units30: 290,
  salesShared: true,
  margin30: 0.25,
  marginState: 'OK',
  ownerUserId: 'u1',
  ownerName: '林然',
  tags: ['热销'],
  watched: false,
  version: 1,
  updatedAt: '2026-10-20T08:00:00Z',
  catalogState: 'OK',
  ...patch,
})

export const noSalesRow = (patch: Partial<ProductListRow> = {}): ProductListRow =>
  productRow({
    id: 'p3',
    sku: 'SKU-C',
    asin: 'B0CCCCCCCC',
    title: '没有销售的商品',
    sellable: null,
    sales30: null,
    units30: null,
    salesShared: false,
    margin30: null,
    marginState: 'COST_MISSING',
    ownerUserId: null,
    ownerName: null,
    tags: [],
    catalogState: 'NOT_SYNCED',
    ...patch,
  })

export const listResponse = (patch: Partial<ProductListResponse> = {}): ProductListResponse => ({
  state: 'OK',
  note: null,
  items: [productRow(), noSalesRow()],
  pageInfo: { hasMore: false, nextCursor: null, approxTotal: 2 } as ProductListResponse['pageInfo'],
  window: { from: '2026-09-23', to: '2026-10-22', days: 30 },
  currency: 'USD',
  stock: { state: 'OK', note: null },
  profit: { state: 'OK', note: null },
  filterOptions: { brands: ['Acme', 'Zeta'], categories: ['Home > Kitchen'], statuses: ['ACTIVE', 'INACTIVE'], tags: ['热销'], owners: [{ id: 'u1', name: '林然' }] },
  members: [{ id: 'u1', name: '林然' }],
  canWrite: true,
  truncated: false,
  riskTruncated: false,
  freshness: { lastSuccessAt: '2026-10-22T02:00:00Z', sources: ['订单', '商品目录'], qualityIssues: 0 } as ProductListResponse['freshness'],
  notConnected: PRODUCT_NOT_CONNECTED_NOTE,
  basis: PRODUCT_BASIS,
  ...patch,
})

export const emptyList = () =>
  listResponse({
    state: 'NOT_CONNECTED',
    note: '可见范围内还没有同步到商品；连接店铺并同步商品目录后才会出现',
    items: [],
    pageInfo: { hasMore: false, nextCursor: null, approxTotal: 0 } as ProductListResponse['pageInfo'],
  })

export const listHandlers = (response: () => ProductListResponse): Record<string, Handler> => ({ '/products': () => ok(response()) })
