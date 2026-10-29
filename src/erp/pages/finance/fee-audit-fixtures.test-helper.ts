import { FEE_AUDIT_KINDS, FEE_AUDIT_KIND_BASIS, FEE_AUDIT_KIND_LABEL, type FeeAuditKindSummary, type FeeAuditListResponse, type FeeAuditRow } from '@nova/api-contracts'
import { freshness } from './fee-fixtures.test-helper'

// 费用核查页面测试用的接口返回样例（只在测试里使用）。

export const auditRow = (over: Partial<FeeAuditRow> = {}): FeeAuditRow => ({
  id: 'fa1',
  sellerAccountId: 's1',
  storeName: '美国主店',
  feeKind: 'FULFILLMENT',
  feeKindLabel: '配送费',
  subjectKey: 'SKU-1',
  sku: 'SKU-1',
  asin: 'B0TESTASIN1',
  shipmentRef: null,
  snapshotDate: '2026-10-23',
  currency: 'USD',
  expectedAmount: 6,
  actualAmount: 9,
  diffAmount: 3,
  overchargeAmount: 3,
  occurrences: 2,
  checkedCount: 5,
  firstSeenAt: '2026-10-10T08:00:00.000Z',
  lastSeenAt: '2026-10-20T08:00:00.000Z',
  status: 'SUSPECTED',
  statusLabel: '疑似多收',
  opportunityId: null,
  basis: {
    summary: '近 30 天 5 行订单按预估配送费核对，2 行高于预期',
    lines: [{ at: '2026-10-20T08:00:00.000Z', ref: '111-0000001-0000001', label: '订单行', quantity: 1, expected: 3, actual: 4.5, diff: 1.5 }],
    dims: {
      amazon: { longestCm: 30, medianCm: 20, shortestCm: 10, weightKg: 1 },
      ours: null,
      volumeRatio: null,
      maxSideDelta: null,
      tierAmazon: 'Large Standard',
      tierOurs: null,
      tierPrevious: 'Small Standard',
    },
    notes: ['有 1 行订单缺少数量，未参与核对'],
  },
  ...over,
})

export const auditSummary = (over: Partial<Record<string, Partial<FeeAuditKindSummary>>> = {}): FeeAuditKindSummary[] =>
  FEE_AUDIT_KINDS.map(kind => ({
    kind,
    label: FEE_AUDIT_KIND_LABEL[kind],
    note: FEE_AUDIT_KIND_BASIS[kind],
    subjects: kind === 'FULFILLMENT' ? 4 : 0,
    suspected: kind === 'FULFILLMENT' ? 1 : 0,
    occurrences: kind === 'FULFILLMENT' ? 2 : 0,
    overcharge: kind === 'FULFILLMENT' ? [{ currency: 'USD', amount: 3 }] : [],
    ...over[kind],
  }))

export const auditList = (items: FeeAuditRow[] = [auditRow()], over: Partial<FeeAuditListResponse> = {}): FeeAuditListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: items.length ? null : '尚无费用核查结果：需要先有预估配送费与佣金预览报告',
  items,
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
  summary: auditSummary(),
  sizeTierChanges: [{ sellerAccountId: 's1', storeName: '美国主店', sku: 'SKU-9', asin: 'B0TESTASIN9', previousTier: 'Small Standard', currentTier: 'Large Standard', changedOn: '2026-10-22' }],
  snapshotDate: items.length ? '2026-10-23' : null,
  canConvert: true,
  freshness,
  ...over,
})
