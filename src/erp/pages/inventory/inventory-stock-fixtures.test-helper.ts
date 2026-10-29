import type {
  LedgerDetailResponse,
  LedgerDetailRow,
  LedgerSummaryResponse,
  LedgerSummaryRow,
  RecommendedRemovalResponse,
  RemovalDetailResponse,
  RemovalGuide,
  RemovalListResponse,
  RemovalOrderRow,
  StorageCapacityResponse,
} from '@nova/api-contracts'

// 库存台账、移除与弃置、仓储容量页面测试用的假数据；字段与服务端响应一致。

export const ok = (data: unknown) => ({ body: { success: true, data } })
export const freshness = { lastSuccessAt: '2026-10-22T08:00:00Z', sources: ['库存台账报告'], qualityIssues: 0 }

export const guide: RemovalGuide = { title: '移除订单只能在亚马逊卖家后台创建', steps: ['打开卖家后台的库存管理', '选择要移除的 SKU 并创建移除订单'], url: 'https://sellercentral.amazon.com/' }

export const summaryRow = (over: Partial<LedgerSummaryRow> = {}): LedgerSummaryRow => ({
  key: 'st1|FN1|2026-10',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  fnsku: 'FN1',
  sku: 'SKU-1',
  asin: 'B0AAAAAAAA',
  month: '2026-10',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  startingQty: 10,
  receipts: 20,
  customerShipments: -3,
  customerReturns: 1,
  vendorReturns: 0,
  transfers: 0,
  found: 0,
  lost: 0,
  damaged: 0,
  disposed: 0,
  other: 0,
  unknownEvents: 0,
  endingQty: 28,
  expectedEnding: 28,
  difference: 0,
  balanced: true,
  live: null,
  ...over,
})

export const summary = (over: Partial<LedgerSummaryResponse> = {}): LedgerSummaryResponse => ({
  view: 'summary',
  state: 'OK',
  note: null,
  items: [summaryRow()],
  page: 1,
  pageSize: 20,
  total: 1,
  from: '2026-08-01',
  to: '2026-10-22',
  unbalancedCount: 0,
  truncated: false,
  freshness,
  ...over,
})

export const detailRow = (over: Partial<LedgerDetailRow> = {}): LedgerDetailRow => ({
  id: 'e1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  eventDate: '2026-10-05',
  eventTime: null,
  fnsku: 'FN1',
  sku: 'SKU-1',
  asin: 'B0AAAAAAAA',
  fulfillmentCenter: 'PHX7',
  disposition: 'SELLABLE',
  reasonCode: '',
  eventType: 'Receipts',
  group: 'receipt',
  groupLabel: '接收',
  adjustmentLabel: null,
  quantity: 20,
  referenceId: 'FBA15AAA',
  referenceKind: 'INBOUND_SHIPMENT',
  reconciledQty: null,
  unreconciledQty: null,
  ...over,
})

export const detail = (over: Partial<LedgerDetailResponse> = {}): LedgerDetailResponse => ({
  view: 'detail',
  state: 'OK',
  note: null,
  items: [detailRow()],
  pageInfo: { pageSize: 20, hasMore: false, nextCursor: null, approxTotal: null },
  freshness,
  ...over,
})

export const removalRow = (over: Partial<RemovalOrderRow> = {}): RemovalOrderRow => ({
  id: 'st1:RO-1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  orderId: 'RO-1',
  type: 'RETURN',
  typeLabel: '退回',
  status: 'Completed',
  statusLabel: '已完成',
  requestDate: '2026-10-01',
  lastUpdatedDate: '2026-10-09',
  skuCount: 2,
  requestedQty: 15,
  shippedQty: 14,
  disposedQty: 0,
  cancelledQty: 1,
  inProcessQty: 0,
  fee: 2,
  currency: 'USD',
  carriers: ['UPS'],
  trackingNumbers: ['1Z1'],
  receiptState: 'PENDING',
  receivedQty: null,
  ...over,
})

export const removals = (over: Partial<RemovalListResponse> = {}): RemovalListResponse => ({
  state: 'OK',
  note: null,
  items: [removalRow()],
  page: 1,
  pageSize: 20,
  total: 1,
  guide,
  freshness,
  ...over,
})

export const recommended = (over: Partial<RecommendedRemovalResponse> = {}): RecommendedRemovalResponse => ({
  state: 'OK',
  note: null,
  items: [
    {
      id: 'r1',
      sellerAccountId: 'st1',
      storeName: 'Northstar US',
      sku: 'SKU-A',
      fnsku: 'FN-A',
      asin: 'B0A',
      productName: null,
      removalQty: 20,
      reason: '库龄过长',
      available: 40,
      estimatedSavings: null,
      snapshotDate: '2026-10-20',
      reportUpdatedAt: null,
    },
  ],
  page: 1,
  pageSize: 20,
  total: 1,
  guide,
  freshness,
  ...over,
})

export const removalDetail = (over: Partial<RemovalDetailResponse> = {}): RemovalDetailResponse => {
  const { carriers: _carriers, trackingNumbers: _tracking, ...order } = removalRow()
  return {
    order: { ...order, serviceSpeed: 'Standard' },
    lines: [
      { sku: 'SKU-A', fnsku: 'F-A', disposition: 'Sellable', requestedQty: 10, shippedQty: 10, disposedQty: 0, cancelledQty: 0, inProcessQty: 0, fee: 1.5, currency: 'USD' },
      { sku: 'SKU-B', fnsku: 'F-B', disposition: 'Sellable', requestedQty: 5, shippedQty: 4, disposedQty: 0, cancelledQty: 1, inProcessQty: 0, fee: null, currency: null },
    ],
    shipments: [{ shipmentId: '1Z1', sku: 'SKU-A', fnsku: 'F-A', disposition: 'Sellable', carrier: 'UPS', trackingNumber: '1Z1', shippedQty: 10, shipDate: '2026-10-05' }],
    timeline: [
      { at: '2026-10-01', title: '提交移除订单', detail: null },
      { at: '2026-10-05', title: '发货 10 件', detail: 'UPS 1Z1' },
    ],
    returnAddress: { state: 'NOT_CONNECTED', note: '亚马逊的移除订单报告不含退回地址。' },
    reconciliation: [
      { sku: 'SKU-A', expectedQty: 10, receivedQty: null, sellableQty: null, damagedQty: null, difference: null, state: 'PENDING' },
      { sku: 'SKU-B', expectedQty: 4, receivedQty: null, sellableQty: null, damagedQty: null, difference: null, state: 'PENDING' },
    ],
    receipts: [],
    canReceive: { allowed: true, reason: null },
    guide,
    freshness,
    ...over,
  }
}

export const capacity = (over: Partial<StorageCapacityResponse> = {}): StorageCapacityResponse => ({
  state: 'OK',
  note: null,
  utilization: [
    {
      sellerAccountId: 'st1',
      storeName: 'Northstar US',
      storageType: 'STANDARD',
      storageTypeLabel: '标准尺寸',
      report: { utilization: 0.85, month: '2026-09' },
      limit: null,
    },
  ],
  fees: {
    months: [
      { month: '2026-05', storage: null, overage: null, longTerm: null, utilization: null },
      { month: '2026-09', storage: 15, overage: 7, longTerm: null, utilization: null },
    ],
    latestMonth: '2026-09',
  },
  forecast: {
    nextMonthStorage: 12.34,
    storageSkuCount: 1,
    ageSurchargeEstimate: null,
    crossings: [
      {
        sellerAccountId: 'st1',
        storeName: 'Northstar US',
        sku: 'SKU-SLOW',
        boundaryDays: 181,
        toLabel: '181-270 天',
        qty: 20,
        earliestDate: '2026-10-13',
        latestDate: '2026-11-20',
        likelyCrossed: false,
        estimatedIncrease: 10,
      },
    ],
    crossingTotal: 10,
  },
  suggestions: [
    {
      sellerAccountId: 'st1',
      storeName: 'Northstar US',
      sku: 'SKU-SLOW',
      title: '慢销商品',
      occupiedVolume: 50,
      volumeUnit: 'cubic feet',
      sellable: 100,
      daysOfCover: 200,
      nextMonthStorage: 12.34,
      action: 'REMOVE',
      actionLabel: '建议移除',
      reason: '可售天数 200 天',
    },
  ],
  notConnected: [
    { key: 'age-surcharge-actual', label: '实际发生的库龄附加费', note: '实际扣费请到“费用事件”页的“库龄附加费”页签查看', workPackage: '' },
    { key: 'low-inventory-fee-actual', label: '实际发生的低库存水平费', note: '实际扣费请到“费用事件”页的“仓储费”页签查看', workPackage: '' },
  ],
  freshness,
  ...over,
})
