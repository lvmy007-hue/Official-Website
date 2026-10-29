import { SUPPLIER_METRIC_BASIS } from '@nova/api-contracts'
import type { PurchaseOrderDetail, PurchaseOrderRow, StockCountRow, SupplierDetail, SupplierRow, WarehouseMovementRow, WarehouseStockResponse } from '@nova/api-contracts'

// 采购、供应商、国内仓页面测试用的假数据；字段与服务端响应一致。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const orderRow = (over: Partial<PurchaseOrderRow> = {}): PurchaseOrderRow => ({
  id: 'po1',
  number: 'PO-20261024-001',
  supplierId: 's1',
  supplierName: '深圳工厂',
  status: 'ORDERED',
  statusLabel: '已下单',
  approvalStatus: 'APPROVED',
  paymentStatus: 'UNPAID',
  currency: 'CNY',
  expectedDate: '2026-11-20',
  lineCount: 2,
  orderedQty: 15,
  receivedQty: 6,
  receiveRatio: 0.4,
  createdAt: '2026-10-24T01:00:00.000Z',
  version: 3,
  deviation: null,
  totalAmount: '40',
  paidAmount: '0',
  ...over,
})

export const orderDetail = (over: Partial<PurchaseOrderDetail> = {}, orderOver: Partial<PurchaseOrderDetail['order']> = {}): PurchaseOrderDetail => ({
  order: { ...orderRow(), notes: null, createdByName: '林然', submittedAt: '2026-10-24T02:00:00.000Z', orderedAt: '2026-10-24T03:00:00.000Z', completedAt: null, supplierCode: 'S-1', ...orderOver },
  lines: [
    {
      id: 'l1',
      sellerSku: 'SKU-A',
      asin: null,
      title: '商品甲',
      quantity: 10,
      receivedQuantity: 6,
      currency: 'CNY',
      unitCost: '3',
      lineAmount: '30',
      costDiff: { currentUnitCost: '2.5', currency: 'CNY', ratio: 0.2, comparable: true },
    },
    { id: 'l2', sellerSku: 'SKU-B', asin: null, title: null, quantity: 5, receivedQuantity: 0, currency: 'CNY', unitCost: '2', lineAmount: '10', costDiff: null },
  ],
  approvals: [{ id: 'a1', step: 1, decision: 'APPROVED', submittedByName: '林然', approverName: '周岚', comment: null, decidedAt: '2026-10-24T03:00:00.000Z', createdAt: '2026-10-24T02:00:00.000Z' }],
  payments: [
    { id: 'p1', kind: 'DEPOSIT', status: 'PLANNED', currency: 'CNY', method: null, plannedAt: '2026-10-30', paidAt: null, voucherAttachmentId: null, note: null, createdByName: '林然', amount: '12' },
  ],
  receipts: [
    {
      id: 'r1',
      receiptNo: 'RC-PO-20261024-001-01',
      receivedAt: '2026-10-25',
      warehouseName: '默认国内仓',
      totalQty: 6,
      note: null,
      receivedByName: '林然',
      lines: [{ lineId: 'l1', sellerSku: 'SKU-A', quantity: 6, batchNo: null }],
    },
  ],
  inspections: [],
  attachments: [],
  links: { batches: [], inboundPlans: [], firstMile: [], costVersions: [] },
  log: [{ id: 'g1', at: '2026-10-24T01:00:00.000Z', action: 'PURCHASE_ORDER_CREATED', actorName: '林然', result: 'SUCCEEDED', reason: null }],
  actions: ['ATTACH', 'RECEIVE', 'INSPECT', 'PAY', 'CANCEL'],
  canApprove: false,
  ...over,
})

export const supplierRow = (over: Partial<SupplierRow> = {}): SupplierRow => ({
  id: 's1',
  code: 'S-1',
  name: '深圳工厂',
  contactName: '王',
  email: null,
  phone: null,
  currency: 'CNY',
  status: 'ACTIVE',
  version: 2,
  poCount: 2,
  skuCount: 3,
  onTimeRate: null,
  qualityPassRate: null,
  avgLeadDays: null,
  rating: null,
  metricsAt: null,
  ...over,
})

export const supplierDetail = (over: Partial<SupplierDetail> = {}): SupplierDetail => ({
  supplier: { ...supplierRow(), notes: null, createdAt: '2026-10-20T00:00:00.000Z' },
  products: [
    {
      sku: 'SKU-A',
      title: '商品甲',
      orderedQty: 10,
      lastOrderedAt: '2026-10-24T03:00:00.000Z',
      quotes: [{ poNumber: 'PO-20261024-001', orderedAt: '2026-10-24T03:00:00.000Z', unitCost: '3', currency: 'CNY' }],
    },
  ],
  purchaseOrders: [orderRow()],
  trend: [],
  inspections: [],
  attachments: [],
  basis: SUPPLIER_METRIC_BASIS,
  ...over,
})

export const stock = (over: Partial<WarehouseStockResponse> = {}): WarehouseStockResponse => ({
  items: [{ warehouseId: 'w1', warehouseName: '默认国内仓', sku: 'SKU-A', onHand: 6, locked: 1, available: 5, pendingOutbound: 4, ageDays: 3, value: '18', valueCurrency: 'CNY', valueNote: null }],
  total: 1,
  page: 1,
  pageSize: 20,
  warehouses: [{ id: 'w1', name: '默认国内仓', code: 'CN-MAIN', kind: 'DOMESTIC', costMethod: 'WEIGHTED_AVERAGE', costMethodLabel: '移动加权平均' }],
  totals: { onHand: 6, locked: 1, available: 5 },
  ...over,
})

export const movement = (over: Partial<WarehouseMovementRow> = {}): WarehouseMovementRow => ({
  id: 'm1',
  occurredAt: '2026-10-25T00:00:00.000Z',
  warehouseName: '默认国内仓',
  sku: 'SKU-A',
  movementType: 'RECEIPT',
  typeLabel: '采购收货',
  quantity: 6,
  lockedForShipment: 0,
  reasonCode: 'PURCHASE_RECEIPT',
  referenceType: 'PURCHASE_ORDER',
  referenceId: 'po1',
  referenceNo: 'PO-20261024-001',
  notes: null,
  operatorName: '林然',
  unitCost: '3',
  currency: 'CNY',
  ...over,
})

export const count = (over: Partial<StockCountRow> = {}): StockCountRow => ({
  id: 'c1',
  warehouseId: 'w1',
  warehouseName: '默认国内仓',
  status: 'PENDING_APPROVAL',
  statusLabel: '待审批',
  countedAt: '2026-10-26',
  lines: [{ sellerSku: 'SKU-A', systemQty: 6, countedQty: 5, diff: -1 }],
  diffTotal: -1,
  note: null,
  reviewNote: null,
  createdByName: '林然',
  approvedByName: null,
  approvedAt: null,
  canApprove: false,
  ...over,
})
