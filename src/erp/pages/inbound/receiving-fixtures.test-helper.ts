import type { InboundDiscrepancyResponse, InboundShipmentListResponse, InboundShipmentListRow, ReceivingAuditRow, ReceivingStatsResponse } from '@nova/api-contracts'
import { shipmentView } from './inbound-fixtures.test-helper'

// 货件接收与差异页面测试用的假数据；字段与服务端响应一致。

export const shipmentRow = (over: Partial<InboundShipmentListRow> = {}): InboundShipmentListRow => ({
  ...shipmentView({
    id: 'sh1',
    shipmentId: 'FBA-SH-1',
    shipmentConfirmationId: 'FBA15ABC',
    status: 'CLOSED',
    destinationFc: 'ONT8',
    units: 10,
    receivedUnits: 7,
    discrepancyUnits: 3,
    trackingNumber: '1Z999',
    receivedFirstAt: '2026-09-01T08:00:00.000Z',
    receivedDoneAt: '2026-09-05T08:00:00.000Z',
  }),
  planId: 'p1',
  planName: '10 月补货',
  planStage: 'DISCREPANCY',
  receiving: { transportStatus: 'DELIVERED', discrepancyDays: 12, claimState: 'WAITING', noncomplianceCount: 2 },
  ...over,
})

export const shipmentList = (items: InboundShipmentListRow[] = [shipmentRow()], over: Partial<InboundShipmentListResponse> = {}): InboundShipmentListResponse => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  freshness: { status: 'NORMAL', statusLabel: '正常', lastSuccessAt: '2026-10-22T08:00:00.000Z', errorMessage: null },
  ...over,
})

export const statsResponse = (over: Partial<ReceivingStatsResponse> = {}): ReceivingStatsResponse => ({
  overall: { destinationFc: null, label: '全部运营中心', sampleCount: 8, p50Days: 2, p90Days: 5, minDays: 1, maxDays: 9, applyBlocked: null },
  rows: [
    { destinationFc: 'ONT8', label: 'ONT8', sampleCount: 6, p50Days: 2, p90Days: 4, minDays: 1, maxDays: 9, applyBlocked: null },
    { destinationFc: 'PHX3', label: 'PHX3', sampleCount: 2, p50Days: 3, p90Days: 3, minDays: 3, maxDays: 3, applyBlocked: '样本不足（至少 5 个已关闭货件，现有 2 个）' },
  ],
  policyVersionNo: 4,
  policyReceivingDays: 7,
  basis: '接收时长 = 开始接收到接收完成的自然日数',
  ...over,
})

export const discrepancyResponse = (over: Partial<InboundDiscrepancyResponse> = {}): InboundDiscrepancyResponse => ({
  shipmentId: 'FBA-SH-1',
  closed: true,
  rows: [
    { sku: 'SKU-A', fnsku: 'X00A', shippedQty: 10, receivedQty: 7, discrepancyQty: 3, state: 'SHORT', reason: 'Labeling' },
    { sku: 'SKU-B', fnsku: null, shippedQty: 5, receivedQty: 5, discrepancyQty: 0, state: 'MATCH', reason: null },
  ],
  compliance: {
    state: 'OK',
    items: [{ sku: 'SKU-A', problemType: 'Labeling', qty: null, amount: 3, currency: 'USD', firstSeenAt: '2026-09-03T00:00:00.000Z', resolvedAt: null }],
    note: '来自入仓不合规报告',
  },
  claims: {
    state: 'OK',
    items: [
      {
        id: 'op1',
        ruleCode: 'INBOUND_DISCREPANCY',
        ruleLabel: '入仓差异',
        sku: 'SKU-A',
        status: 'PENDING',
        statusLabel: '待处理',
        qty: 3,
        estimatedAmount: null,
        currency: null,
        deadlineAt: '2028-02-26T00:00:00.000Z',
        detectedAt: '2026-10-20T00:00:00.000Z',
        evidence: [{ kind: 'SHIPMENT', id: 'sh1', label: '货件 FBA-SH-1' }],
      },
    ],
    window: { eligibleFrom: '2026-10-20', deadline: '2028-02-26', state: 'OPEN' },
    note: '等待期与申请期限现为默认值',
  },
  note: '差异 = 发出数量 − 接收数量；为正是少收，为负是多收。',
  ...over,
})

export const auditRows = (): ReceivingAuditRow[] => [{ id: 'a1', at: '2026-10-21T08:00:00.000Z', action: 'ATTACHMENT_ADDED', actorName: '张三', result: 'SUCCESS', reason: null }]
