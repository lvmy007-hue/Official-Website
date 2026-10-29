import type { FirstMileDetail, FirstMileListResponse, FirstMileRow, ForwarderRow, TransitStatRow, TransitStatsResponse } from '@nova/api-contracts'

// 头程物流页面测试用的假数据；字段与服务端响应一致。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const shipmentRow = (over: Partial<FirstMileRow> = {}): FirstMileRow => ({
  id: 'fm1',
  forwarderId: 'f1',
  forwarderName: '海运通',
  waybillNo: 'WB-1001',
  mode: 'SEA',
  modeLabel: '海运',
  containerNo: 'CNT-1',
  shipDate: '2026-09-20',
  etaPort: '2026-10-15',
  ataPort: null,
  customsStatus: 'NOT_STARTED',
  customsLabel: '未开始',
  etaDelivery: '2026-10-19',
  ataDelivery: null,
  stage: 'IN_TRANSIT',
  stageLabel: '运输中',
  delayDays: 3,
  currency: 'USD',
  estimatedCost: '1200',
  actualCost: '980.5',
  deviationPct: -18.3,
  carrierChannelId: null,
  carrierChannelName: null,
  estimatedAt: null,
  linkedInboundShipmentIds: ['FBA-SHIP-1'],
  itemCount: 2,
  totalQty: 30,
  warehouseId: 'wh1',
  warehouseName: '深圳仓',
  outboundAt: null,
  allocated: false,
  version: 4,
  ...over,
})

export const listResponse = (rows: FirstMileRow[] = [shipmentRow()]): FirstMileListResponse => ({
  items: rows,
  total: rows.length,
  page: 1,
  pageSize: 20,
  forwarders: [{ id: 'f1', name: '海运通', status: 'ACTIVE', defaultMode: 'SEA' }],
  warehouses: [{ id: 'wh1', name: '深圳仓' }],
})

export const forwarderRow = (over: Partial<ForwarderRow> = {}): ForwarderRow => ({
  id: 'f1',
  name: '海运通',
  contact: '李四 13800000000',
  defaultMode: 'SEA',
  status: 'ACTIVE',
  version: 2,
  shipmentCount: 5,
  ...over,
})

export const detail = (over: Partial<FirstMileDetail> = {}, shipmentOver: Partial<FirstMileRow> = {}): FirstMileDetail => ({
  shipment: { ...shipmentRow(shipmentOver), note: null, createdAt: '2026-09-18T01:00:00.000Z', createdByName: '林然' },
  items: [
    { sku: 'SKU-A', purchaseOrderId: 'po1', purchaseOrderNo: 'PO-20261024-001', quantity: 10, cartons: 2, volumeCbm: 1.5, weightKg: 30, goodsValue: '100' },
    { sku: 'SKU-B', purchaseOrderId: null, purchaseOrderNo: null, quantity: 20, cartons: null, volumeCbm: null, weightKg: null, goodsValue: null },
  ],
  milestones: [
    { id: 'm1', milestone: 'DEPARTED', label: '离港或起飞', occurredAt: '2026-09-20T02:00:00.000Z', location: '盐田港', source: 'MANUAL', sourceLabel: '手工录入', note: null, createdByName: '林然' },
    {
      id: 'm2',
      milestone: 'ARRIVED_PORT',
      label: '到港',
      occurredAt: '2026-10-14T02:00:00.000Z',
      location: 'Los Angeles',
      source: 'FILE_IMPORT',
      sourceLabel: '货代文件导入',
      note: null,
      createdByName: null,
    },
  ],
  costs: [{ id: 'c1', item: 'FREIGHT', itemLabel: '运费', amount: '980.5', incurredAt: '2026-10-01', note: null, createdByName: '林然' }],
  allocation: null,
  allocationReady: { VOLUME: '缺少体积：SKU-B', WEIGHT: '缺少重量：SKU-B', VALUE: '缺少货值：SKU-B', QTY: null },
  attachments: [],
  missingFields: [{ sku: 'SKU-B', missing: ['WEIGHT', 'VOLUME'], suggestedWeightKg: 12, suggestedVolumeCbm: null }],
  qtyCheck: { state: 'MATCH', firstMileUnits: 30, outboundUnits: null, inboundShippedUnits: 30, note: '运单明细、国内仓出库与关联入仓货件的已发数量一致。' },
  linkedInbound: [{ shipmentId: 'FBA-SHIP-1', found: true, status: 'WORKING', destinationFc: 'ONT8', unitsExpected: 30, unitsReceived: null, shippedUnits: 30 }],
  actions: ['EDIT', 'ADD_MILESTONE', 'ADD_COST', 'ALLOCATE', 'OUTBOUND'],
  transitHint: { forwarderName: '海运通', mode: 'SEA', sampleCount: 6, p50Days: 25, p90Days: 31 },
  ...over,
})

export const transitRow = (over: Partial<TransitStatRow> = {}): TransitStatRow => ({
  forwarderId: 'f1',
  forwarderName: '海运通',
  mode: 'SEA',
  modeLabel: '海运',
  sampleCount: 6,
  p50Days: 25,
  p90Days: 31,
  minDays: 20,
  maxDays: 33,
  monthly: [{ month: '2026-09-01', sampleCount: 6, p50Days: 25, p90Days: 31 }],
  policyTransitDays: 30,
  applyBlocked: null,
  ...over,
})

export const transitStats = (rows: TransitStatRow[] = [transitRow()], policyVersionNo: number | null = 3): TransitStatsResponse => ({
  rows,
  policyVersionNo,
  basis: '实际时效 = 发货日到实际交付日的自然日数（测试口径）',
})
