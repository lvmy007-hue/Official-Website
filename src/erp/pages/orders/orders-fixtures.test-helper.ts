import type { OrderIdentityResponse, OrderListResponse, OrderListRow, PiiRevealResponse } from '@nova/api-contracts'

// 订单页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

/** 表格里某一行（按订单 id）的全部文字；订单列表是 AG Grid 骨架，行不是 <tr>。 */
export const rowText = (id: string) =>
  Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(el => el.textContent ?? '')
    .join(' ')

export const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['orders.api'], qualityIssues: 0 }

export const orderRow = (over: Partial<OrderListRow> = {}): OrderListRow => ({
  id: 'o1',
  amazonOrderId: '111-2223334-5556667',
  purchaseDate: '2026-10-20T10:00:00.000Z',
  sellerAccountId: 's1',
  storeName: '美国主店',
  amount: 59.9,
  currency: 'USD',
  units: 2,
  status: 'Shipped',
  statusLabel: '已发货',
  fulfillmentStatus: 'SHIPPED',
  fulfillmentLabel: '已发货',
  earliestDelivery: null,
  latestDelivery: '2026-10-25T00:00:00.000Z',
  carrier: 'UPS',
  trackingNumber: '1Z999AA10123456784',
  trackingCount: 1,
  refund: { state: 'NONE', amount: null },
  returnCount: 0,
  isReplacement: false,
  settlement: { state: 'RELEASED', label: '已释放' },
  risks: [],
  ...over,
})

export const orderList = (items: OrderListRow[] = [orderRow()], over: Partial<OrderListResponse> = {}): OrderListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: items.length ? null : '所选日期范围内尚无订单记录',
  items,
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
  range: { from: '2026-09-23', to: '2026-10-23', defaulted: true },
  filterLimited: false,
  freshness,
  ...over,
})

export const identity = (over: Partial<OrderIdentityResponse> = {}): OrderIdentityResponse => ({
  order: {
    id: 'o1',
    amazonOrderId: '111-2223334-5556667',
    sellerAccountId: 's1',
    storeName: '美国主店',
    marketplaceId: 'ATVPDKIKX0DER',
    salesChannel: 'Amazon.com',
    programs: [],
    purchaseDate: '2026-10-20T10:00:00.000Z',
    status: 'Shipped',
    statusLabel: '已发货',
    fulfillmentStatus: 'SHIPPED',
    fulfillmentLabel: '已发货',
    fulfillmentNetwork: 'AFN',
    amount: 59.9,
    currency: 'USD',
    units: 2,
    lineCount: 1,
    isReplacement: false,
    replacedOrderId: null,
    replacementReason: null,
  },
  settlement: { state: 'RELEASED', label: '已释放' },
  refund: { state: 'NONE', amount: null },
  returnCount: 0,
  risks: [],
  overview: {
    promise: { latestShipDate: '2026-10-21T00:00:00.000Z', earliestDelivery: null, latestDelivery: '2026-10-25T00:00:00.000Z' },
    basis: { carriers: ['UPS'], services: ['Ground'], note: '承诺来自订单接口；承运商与服务来自包裹记录。' },
    keyTimes: [
      { key: 'purchase', label: '下单', at: '2026-10-20T10:00:00.000Z' },
      { key: 'shipped', label: '发货', at: null },
    ],
  },
  buyerInfo: { access: 'ALLOWED', state: 'AVAILABLE', expiresAt: '2026-12-01T00:00:00.000Z' },
  freshness,
  ...over,
})

export const piiOk: PiiRevealResponse = {
  objectType: 'ORDER',
  objectId: 'o1',
  state: 'OK',
  values: { buyerName: '张三', buyerEmail: 'zs@example.com', buyerPhone: null, addressLine1: '1 Main St', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' },
  expiresAt: '2026-12-01T00:00:00.000Z',
  retainedUntil: '2026-12-01T00:00:00.000Z',
  note: null,
}
