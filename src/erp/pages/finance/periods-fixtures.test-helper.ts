import {
  BRIDGE_DEFS,
  CHECK_KEYS,
  CHECK_LABEL,
  PERIOD_STATUS_LABEL,
  PERIOD_STATUS_NOTE,
  PROFIT_BASES,
  PROFIT_BASIS_LABEL,
  type CheckItem,
  type CheckKey,
  type PeriodActions,
  type PeriodDetail,
  type PeriodDetailResponse,
  type PeriodDiffReport,
  type PeriodListResponse,
  type PeriodPreview,
  type PeriodRow,
  type PeriodSnapshotSummary,
  type PeriodStatus,
} from '@nova/api-contracts'

// 期间关账页面测试用的接口返回样例（只在测试里使用）。

export const rowOf = (over: Partial<PeriodRow> = {}): PeriodRow => ({
  id: 'p1',
  sellerAccountId: 's1',
  storeName: '美国主店',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  month: '2026-09',
  status: 'OPEN',
  statusLabel: PERIOD_STATUS_LABEL.OPEN,
  closedBy: null,
  closedAt: null,
  closeCount: 0,
  checkPassed: null,
  version: 1,
  ...over,
})

export const listOf = (items: PeriodRow[] = [rowOf()], over: Partial<PeriodListResponse> = {}): PeriodListResponse => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  summary: { OPEN: 1, CLOSING: 1, CLOSED: 2, REOPENED: 0 },
  stores: [
    { id: 's1', name: '美国主店' },
    { id: 's2', name: '加拿大店' },
  ],
  canCreate: true,
  ...over,
})

const allowed = { allowed: true, reason: null }
const denied = (reason: string) => ({ allowed: false, reason })
export const actionsOf = (over: Partial<PeriodActions> = {}): PeriodActions => ({
  check: allowed,
  approve: denied('尚未通过完整性检查'),
  close: denied('尚未审批通过'),
  reopen: denied('期间还没有关账'),
  ...over,
})

export const itemOf = (key: CheckKey, over: Partial<CheckItem> = {}): CheckItem => ({
  key,
  label: CHECK_LABEL[key],
  state: 'PASS',
  baseState: 'PASS',
  summary: '通过',
  details: [],
  value: null,
  acknowledgeable: key === 'ADS_ALLOCATED' || key === 'RECON_EXCEPTIONS',
  acknowledgement: null,
  ...over,
})

export const checklistOf = (over: Partial<Record<CheckKey, Partial<CheckItem>>> = {}, passed = true) => ({
  checkedAt: '2026-10-05T08:00:00.000Z',
  passed,
  items: CHECK_KEYS.map(key => itemOf(key, over[key])),
})

export const periodOf = (status: PeriodStatus = 'OPEN', over: Partial<PeriodDetail> = {}): PeriodDetail => ({
  ...rowOf({ status, statusLabel: PERIOD_STATUS_LABEL[status] }),
  createdBy: '张三',
  checkedBy: null,
  checkedAt: null,
  approvalDecision: null,
  approvedBy: null,
  approvedAt: null,
  approvalComment: null,
  reopenedBy: null,
  reopenedAt: null,
  reopenReason: null,
  statusNote: PERIOD_STATUS_NOTE[status],
  ...over,
})

export const previewOf = (over: Partial<PeriodPreview> = {}): PeriodPreview => ({
  state: 'OK',
  source: 'LIVE',
  note: null,
  bases: PROFIT_BASES.map((basis, index) => ({
    basis,
    label: PROFIT_BASIS_LABEL[basis],
    units: 100 + index,
    costedUnits: 98 + index,
    rows: 30,
    incompleteRows: 0,
    netProfit: 1000 + index,
    items: (['REVENUE', 'COMMISSION', 'ADS', 'PRODUCT_COST', 'DUTY'] as const).map(key => ({
      key,
      label: BRIDGE_DEFS[key].label,
      direction: BRIDGE_DEFS[key].direction,
      value: key === 'DUTY' ? null : key === 'REVENUE' ? 5000 + index : -(300 + index),
      state: key === 'DUTY' ? ('NOT_CONNECTED' as const) : ('OK' as const),
    })),
  })),
  fx: { currencies: ['CAD'], rates: 30 },
  costVersions: 12,
  ...over,
})

export const snapshotOf = (revision = 1, over: Partial<PeriodSnapshotSummary> = {}): PeriodSnapshotSummary => ({
  revision,
  lockedAt: '2026-10-08T09:00:00.000Z',
  lockedBy: '李四',
  bases: PROFIT_BASES.map(basis => ({ basis, label: PROFIT_BASIS_LABEL[basis], rows: 30, revenue: 5000, netProfit: 1000 })),
  fxRates: 30,
  costVersions: 12,
  hasDiff: false,
  ...over,
})

const amount = (key: string, label: string, before: number | null, after: number | null) => ({ key, label, before, after, delta: before !== null && after !== null ? after - before : null })

export const diffOf = (over: Partial<PeriodDiffReport> = {}): PeriodDiffReport => ({
  against: 'LIVE',
  baseRevision: 1,
  baseLockedAt: '2026-10-08T09:00:00.000Z',
  compareRevision: null,
  hasChanges: true,
  bases: PROFIT_BASES.map(basis => ({
    basis,
    label: PROFIT_BASIS_LABEL[basis],
    items: [amount('REVENUE', '销售额', 5000, 5120)],
    netProfit: amount('NET_PROFIT', '净利润', 1000, 1080),
    skus: [{ sku: 'SKU-DIFF-1', kind: 'CHANGED' as const, asin: null, units: { before: 10, after: 12 }, revenue: { before: 500, after: 620 }, profit: { before: 100, after: null }, magnitude: 120 }],
    skuChanged: 1,
    skuAdded: 0,
    skuRemoved: 0,
    skuTruncated: false,
  })),
  fx: { rows: [{ quote: 'CAD', date: '2026-09-10', source: 'ECB', before: 0.73, after: 0.74 }], changed: 1, added: 0, removed: 0 },
  costVersions: { rows: [], changed: 0, added: 0, removed: 0 },
  ...over,
})

export const detailOf = (status: PeriodStatus = 'OPEN', over: Partial<PeriodDetailResponse> = {}): PeriodDetailResponse => ({
  period: periodOf(status),
  checklist: null,
  preview: previewOf(),
  snapshots: [],
  diff: null,
  actions: actionsOf(),
  ...over,
})
