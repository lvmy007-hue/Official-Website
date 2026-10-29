import {
  RETURN_ANALYSIS_BASIS,
  RETURN_REASON_CATEGORIES,
  type ReturnCohortResponse,
  type ReturnCrossMonthResponse,
  type ReturnCycleResponse,
  type ReturnDispositionMatrixResponse,
  type ReturnReasonMapListResponse,
  type ReturnReasonMapRow,
  type ReturnSummaryResponse,
  type ReturnTrendPoint,
} from '@nova/api-contracts'
import { freshness } from './returns-fixtures.test-helper'

// 退货分析与原因映射的接口返回样例（只在测试里使用）。

const common = {
  state: 'OK' as const,
  note: null,
  range: { from: '2026-07-25', to: '2026-10-23', defaulted: true },
  timeBasis: 'return' as const,
  unknownOrderUnits: 0,
  unknownOrderRows: 0,
  freshness,
}

const point = (bucket: string, returnedUnits: number, soldUnits: number | null): ReturnTrendPoint => ({ bucket, returnedUnits, soldUnits, rate: soldUnits ? returnedUnits / soldUnits : null })

const rank = (asin: string, current: number, previous: number, beforePrevious: number, streak = false) => ({
  asin,
  current,
  previous,
  beforePrevious,
  delta: current - previous,
  streak,
  rates: { current: current / 100, previous: null, beforePrevious: null },
  productId: null,
  title: `${asin} 的商品`,
})

export const summary = (over: Partial<ReturnSummaryResponse> = {}): ReturnSummaryResponse => ({
  ...common,
  basis: RETURN_ANALYSIS_BASIS.summary,
  bucket: 'WEEK',
  totals: { returnedUnits: 12, soldUnits: 300, rate: 0.04 },
  trend: [point('2026-10-05', 5, 100), point('2026-10-12', 7, null)],
  byAsin: [
    { asin: 'B0TESTASIN1', returnedUnits: 8, soldUnits: 200, rate: 0.04, topReason: { code: 'DEFECTIVE', label: '商品有缺陷', units: 5 }, productId: 'p1', title: '测试商品一' },
    { asin: 'B0TESTASIN2', returnedUnits: 4, soldUnits: null, rate: null, topReason: null, productId: null, title: null },
  ],
  byReason: [
    { code: 'DEFECTIVE', label: '商品有缺陷', category: '商品质量', unclassified: false, units: 6, share: 0.5 },
    { code: 'NEW_CODE', label: 'NEW_CODE', category: '未分类', unclassified: true, units: 3, share: 0.25 },
    { code: 'UNSPECIFIED', label: '未提供原因', category: '未分类', unclassified: true, units: 3, share: 0.25 },
  ],
  byCategory: [
    { category: '商品质量', units: 6, share: 0.5 },
    { category: '未分类', units: 6, share: 0.5 },
  ],
  byDisposition: [
    { group: 'SELLABLE', label: '可售', units: 9, share: 0.75 },
    { group: 'DAMAGED', label: '损坏', units: 3, share: 0.25 },
  ],
  ranks: {
    periods: [
      { key: 'current', label: '本期', from: '2026-09-25', to: '2026-10-23' },
      { key: 'previous', label: '上期', from: '2026-08-28', to: '2026-09-24' },
      { key: 'beforePrevious', label: '上上期', from: '2026-07-31', to: '2026-08-27' },
    ],
    anomalies: [rank('B0ANOMALY01', 9, 3, 1, true)],
    improvements: [rank('B0IMPROVE01', 2, 8, 9, true)],
    truncated: false,
  },
  unclassified: { codes: ['NEW_CODE'], units: 3 },
  truncated: false,
  ...over,
})

const buckets = [
  { key: '0-7', label: '0–7 天', min: 0, max: 7, units: 4, share: 0.4 },
  { key: '8-14', label: '8–14 天', min: 8, max: 14, units: 6, share: 0.6 },
  { key: '15+', label: '14 天以上', min: 15, max: null, units: 0, share: 0 },
]

export const cycle = (over: Partial<ReturnCycleResponse> = {}): ReturnCycleResponse => ({
  ...common,
  basis: RETURN_ANALYSIS_BASIS.cycle,
  anchor: 'order',
  bounds: [7, 14],
  buckets,
  totals: { units: 10, median: 9.5 },
  dimension: 'none',
  slices: [],
  truncated: false,
  ...over,
})

export const crossMonth = (over: Partial<ReturnCrossMonthResponse> = {}): ReturnCrossMonthResponse => ({
  ...common,
  basis: RETURN_ANALYSIS_BASIS.crossMonth,
  totals: { computableUnits: 10, crossMonthUnits: 4, share: 0.4 },
  refund: { state: 'OK', currency: 'USD', crossMonthAmount: 120, totalAmount: 400, share: 0.3, sampledOrders: 8, note: null },
  matrix: {
    orderMonths: ['2026-09', '2026-10'],
    returnMonths: ['2026-09', '2026-10'],
    cells: [
      [2, 4],
      [0, 4],
    ],
    hiddenUnits: 0,
  },
  truncated: false,
  ...over,
})

export const cohort = (over: Partial<ReturnCohortResponse> = {}): ReturnCohortResponse => ({
  ...common,
  basis: RETURN_ANALYSIS_BASIS.cohort,
  months: [
    { month: '2026-09', soldUnits: 200, cohortReturnedUnits: 12, cohortRate: 0.06, returnedInMonthUnits: 6, returnDateRate: 0.03, windowOpen: false },
    { month: '2026-10', soldUnits: null, cohortReturnedUnits: 4, cohortRate: null, returnedInMonthUnits: 8, returnDateRate: null, windowOpen: true },
  ],
  truncated: false,
  ...over,
})

export const matrix = (over: Partial<ReturnDispositionMatrixResponse> = {}): ReturnDispositionMatrixResponse => ({
  ...common,
  basis: RETURN_ANALYSIS_BASIS.matrix,
  rows: [
    { key: 'SELLABLE', label: '可售', group: 'SELLABLE' },
    { key: 'DAMAGED', label: '损坏', group: 'DAMAGED' },
  ],
  columns: [
    { key: 'Unit returned to inventory', label: 'Unit returned to inventory' },
    { key: 'Damaged', label: 'Damaged' },
  ],
  cells: [
    [7, 0],
    [1, 2],
  ],
  totals: { units: 10 },
  ...over,
})

export const reasonRow = (over: Partial<ReturnReasonMapRow> = {}): ReturnReasonMapRow => ({
  code: 'DEFECTIVE',
  labelZh: '商品有缺陷',
  category: '商品质量',
  source: 'PRESET',
  presetLabelZh: '商品有缺陷',
  presetCategory: '商品质量',
  unclassified: false,
  updatedAt: null,
  ...over,
})

export const reasonMap = (items: ReturnReasonMapRow[] = [reasonRow()], over: Partial<ReturnReasonMapListResponse> = {}): ReturnReasonMapListResponse => ({
  items,
  page: 1,
  pageSize: 50,
  total: items.length,
  summary: {
    total: items.length,
    unclassified: items.filter(item => item.unclassified).length,
    edited: items.filter(item => item.source === 'PRESET_EDITED').length,
    custom: items.filter(item => item.source === 'CUSTOM').length,
  },
  categories: RETURN_REASON_CATEGORIES,
  canManage: true,
  manageBlockedReason: null,
  ...over,
})
