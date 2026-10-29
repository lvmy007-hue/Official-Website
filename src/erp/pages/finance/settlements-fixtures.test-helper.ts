import type {
  SettlementDisbursementsResponse,
  SettlementExceptionRow,
  SettlementExceptionsResponse,
  SettlementLineRow,
  SettlementLinesResponse,
  SettlementListResponse,
  SettlementReconciliationResponse,
  SettlementRow,
  SettlementSummaryResponse,
} from '@nova/api-contracts'
import { freshness } from './fee-fixtures.test-helper'

// 结算交易页面测试用的接口返回样例（只在测试里使用）。

const page = { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: null }

export const settlementRow = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  id: 'st1',
  sellerAccountId: 's1',
  storeName: '美国主店',
  externalSettlementId: '12345678901',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-09-14T23:59:59.000Z',
  depositDate: '2026-09-16T00:00:00.000Z',
  openingBalance: -50,
  totals: { INCOME: 120, FEE: -15, REFUND: -8, REIMBURSEMENT: 4, ADJUSTMENT: 0, RESERVE: -50 },
  disbursementAmount: 55,
  totalAmount: 55,
  currency: 'USD',
  txnCount: 12,
  status: 'DISCREPANCY',
  statusLabel: '有差异',
  pendingReason: null,
  diffAmount: -15,
  openExceptions: 2,
  ...over,
})

export const pendingRow = (over: Partial<SettlementRow> = {}): SettlementRow =>
  settlementRow({
    id: 'st2',
    externalSettlementId: '99999999999',
    totals: null,
    disbursementAmount: null,
    totalAmount: null,
    openingBalance: null,
    txnCount: 0,
    status: 'PENDING',
    statusLabel: '待核对',
    pendingReason: 'NO_REPORT',
    diffAmount: null,
    openExceptions: 0,
    depositDate: null,
    ...over,
  })

export const settlementList = (items: SettlementRow[] = [settlementRow(), pendingRow()], over: Partial<SettlementListResponse> = {}): SettlementListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: items.length ? null : '尚无结算单：店铺授权后同步到后显示',
  items,
  pageInfo: page,
  summary: { total: 5, matched: 2, discrepancy: 1, pending: 2 },
  freshness,
  ...over,
})

export const summaryOf = (over: Partial<SettlementSummaryResponse> = {}): SettlementSummaryResponse => ({
  settlement: settlementRow(),
  hasReport: true,
  note: null,
  categories: [
    { category: 'INCOME', label: '收入', amount: 120 },
    { category: 'FEE', label: '费用', amount: -15 },
    { category: 'REFUND', label: '退款', amount: -8 },
    { category: 'REIMBURSEMENT', label: '赔付', amount: 4 },
    { category: 'ADJUSTMENT', label: '调整及其他', amount: 0 },
    { category: 'RESERVE', label: '保留金', amount: -50 },
  ],
  breakdown: [
    { category: 'INCOME', categoryLabel: '收入', amountType: 'ItemPrice', amountDescription: 'Principal', count: 3, amount: 120 },
    { category: 'FEE', categoryLabel: '费用', amountType: 'ItemFees', amountDescription: 'Commission', count: 3, amount: -15 },
  ],
  breakdownTruncated: false,
  freshness,
  ...over,
})

export const lineRow = (over: Partial<SettlementLineRow> = {}): SettlementLineRow => ({
  id: 'l1',
  lineNo: 2,
  postedAt: '2026-09-05T10:00:00.000Z',
  transactionType: 'Order',
  amountType: 'ItemFees',
  amountDescription: 'Commission',
  category: 'FEE',
  categoryLabel: '费用',
  amazonOrderId: '111-0000001-0000001',
  sku: 'SKU-1',
  asin: 'B0TESTASIN1',
  quantity: 1,
  amount: -15,
  currency: 'USD',
  orderFound: true,
  feeEventId: 'fe1',
  ...over,
})

export const linesOf = (items: SettlementLineRow[] = [lineRow()], over: Partial<SettlementLinesResponse> = {}): SettlementLinesResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: items.length ? null : '这张结算单的结算报告里没有金额明细',
  items,
  pageInfo: page,
  canViewOrders: true,
  ...over,
})

export const exceptionRow = (over: Partial<SettlementExceptionRow> = {}): SettlementExceptionRow => ({
  id: 'e1',
  kind: 'AMOUNT_MISMATCH',
  kindLabel: '金额不一致',
  category: 'UNEXPLAINED',
  categoryLabel: '未解释',
  categoryHint: '以上都解释不了，需要人工到卖家后台核对',
  refKey: 'order:111-0000001-0000001',
  amazonOrderId: '111-0000001-0000001',
  reportAmount: 85,
  apiAmount: 100,
  amount: -15,
  currency: 'USD',
  note: null,
  status: 'OPEN',
  statusLabel: '待处理',
  orderFound: true,
  ...over,
})

export const exceptionsOf = (items: SettlementExceptionRow[] = [exceptionRow()], over: Partial<SettlementExceptionsResponse> = {}): SettlementExceptionsResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: items.length ? null : '这张结算单没有核对异常',
  items,
  pageInfo: page,
  canViewOrders: true,
  ...over,
})

export const reconciliationOf = (over: Partial<SettlementReconciliationResponse> = {}): SettlementReconciliationResponse => ({
  settlementId: 'st1',
  status: 'DISCREPANCY',
  statusLabel: '有差异',
  pendingReason: null,
  pendingNote: null,
  currency: 'USD',
  computedAt: '2026-10-23T01:00:00.000Z',
  officialAmount: 105,
  systemAmount: 120,
  diffAmount: -15,
  report: { lineCount: 12, comparedTotal: 105, headerTotal: 55, selfDiff: 0, orderCount: 3 },
  api: { transactionCount: 8, total: 120, orderCount: 3, otherCurrencyCount: 0 },
  orders: { reportOrders: 3, found: 2, missing: 1 },
  checks: [
    { key: 'REPORT_SELF', label: '结算报告自检', state: 'PASS', detail: '汇总行打款总额 55，明细合计 55，相差 0' },
    { key: 'REPORT_VS_API', label: '结算报告与财务交易', state: 'FAIL', detail: '报告合计 105，接口合计 120，相差 -15；1 组订单对不上' },
    { key: 'ORDERS', label: '结算报告与我方订单', state: 'SKIPPED', detail: '结算报告尚未到达' },
  ],
  exceptions: [{ category: 'UNEXPLAINED', label: '未解释', count: 1, amount: 15 }],
  openExceptions: 1,
  exceptionsTruncated: false,
  tolerance: 0.05,
  freshness,
  ...over,
})

export const disbursementsOf = (over: Partial<SettlementDisbursementsResponse> = {}): SettlementDisbursementsResponse => ({
  items: [{ source: 'REPORT', sourceLabel: '结算报告', date: '2026-09-16T00:00:00.000Z', amount: 55, currency: 'USD', note: '以结算报告汇总行的打款总额与打款日期为准' }],
  manual: { available: true, note: '尚未登记到账，请到“回款与现金流”页登记' },
  ...over,
})
