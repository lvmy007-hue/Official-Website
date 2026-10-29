import type { AwdFreshness, AwdInventoryResponse, AwdOrderDetail, AwdOrderListResponse, AwdOrderRow, AwdShipmentRow, AwdWriteStatus } from '@nova/api-contracts'

// 上游仓储页面测试用的假数据；字段与服务端响应一致。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const allowed: AwdWriteStatus = { allowed: true, step: null, reason: null, remedyPath: null }
export const switchOff: AwdWriteStatus = { allowed: false, step: 'SWITCH', reason: '“上游仓储写入”开关还没有打开', remedyPath: '/app/switches' }

export const freshness: AwdFreshness = { status: 'NORMAL', statusLabel: '正常', lastSuccessAt: '2026-10-22T08:00:00.000Z', errorMessage: null }

export const inventory = (over: Partial<AwdInventoryResponse> = {}): AwdInventoryResponse => ({
  state: 'OK',
  note: null,
  items: [
    {
      sellerAccountId: 'st1',
      storeName: 'Northstar US',
      sku: 'SKU-A',
      snapshotDate: '2026-10-22',
      onhandQty: 120,
      availableQty: 100,
      reservedForReplenishment: null,
      inboundToAwdQty: 30,
      outboundToFbaInTransit: null,
      expiryDate: null,
      expirations: [],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  snapshotDate: '2026-10-22',
  totals: { onhandQty: 120, availableQty: 100, reservedForReplenishment: null, inboundToAwdQty: 30, outboundToFbaInTransit: null },
  freshness,
  ...over,
})

export const orderRow = (over: Partial<AwdOrderRow> = {}): AwdOrderRow => ({
  id: 'o1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  orderId: 'AWD-1001',
  externalReferenceId: 'NOVA-AAAA',
  status: 'DRAFT',
  statusLabel: '亚马逊草稿',
  pendingAction: null,
  expectedUnits: 240,
  receivedUnits: null,
  packageDeliveryMode: 'CASE',
  destinationRegion: null,
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-22T08:00:00.000Z',
  version: 3,
  lastErrorMessage: null,
  ...over,
})

export const orderList = (items: AwdOrderRow[] = [orderRow()], write: AwdWriteStatus = allowed): AwdOrderListResponse => ({
  state: 'OK',
  note: null,
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
  write,
  freshness,
})

export const shipment = (over: Partial<AwdShipmentRow> = {}): AwdShipmentRow => ({
  id: 'sh1',
  shipmentId: 'SHIP-1',
  orderId: 'AWD-1001',
  orderRowId: 'o1',
  status: 'IN_TRANSIT',
  statusLabel: '运输中',
  carrier: null,
  trackingNumber: null,
  destination: 'us-west',
  shipBy: null,
  createdAt: null,
  updatedAt: null,
  labelStatus: null,
  expectedUnits: 240,
  receivedUnits: null,
  items: [{ sku: 'SKU-A', expectedQty: 240, receivedQty: null, unit: 'PRODUCT_UNITS', expiryDate: null, prepInfo: null }],
  ...over,
})

export const orderDetail = (over: Partial<AwdOrderDetail> = {}): AwdOrderDetail => ({
  ...orderRow(),
  originAddress: { name: '鸿洛仓', addressLine1: '建设路 1 号', city: '许昌', stateOrRegion: '河南', postalCode: '461000', countryCode: 'CN' } as AwdOrderDetail['originAddress'],
  packages: [
    {
      type: 'CASE',
      count: 10,
      measurements: { weight: { value: 12, unit: 'KILOGRAMS' }, dimensions: { length: 50, width: 40, height: 30, unit: 'CENTIMETERS' } },
      products: [{ sku: 'SKU-A', quantity: 24 }],
    } as AwdOrderDetail['packages'][number],
  ],
  preferredRegion: null,
  note: null,
  draft: null,
  shipments: [],
  timeline: [{ at: '2026-10-21T08:00:00.000Z', title: '创建入库订单', detail: null }],
  write: allowed,
  actions: ['EDIT', 'CONFIRM', 'CANCEL'],
  ...over,
})
