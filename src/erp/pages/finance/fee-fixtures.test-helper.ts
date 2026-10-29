import {
  FEE_CATEGORIES,
  FEE_CATEGORY_LABEL,
  type FeeCategorySummary,
  type FeeEventDetailResponse,
  type FeeEventListResponse,
  type FeeEventRow,
  type FeeEventSummaryResponse,
} from '@nova/api-contracts'

// 费用事件页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['finance.transactions'], qualityIssues: 0 }
export const range = { from: '2026-09-24', to: '2026-10-23', defaulted: true, fromAt: '2026-09-24T07:00:00.000Z', toAt: '2026-10-24T07:00:00.000Z' }

export const feeRow = (over: Partial<FeeEventRow> = {}): FeeEventRow => ({
  id: 'fe1',
  sellerAccountId: 's1',
  storeName: '美国主店',
  category: 'FULFILLMENT',
  categoryLabel: '配送费',
  subtype: 'FBAPerUnitFulfillmentFee',
  subtypeLabel: 'FBA Per Unit Fulfillment Fee',
  amount: -3.5,
  currency: 'USD',
  postedAt: '2026-10-20T08:00:00.000Z',
  transactionStatus: 'RELEASED',
  transactionStatusLabel: '已释放',
  amazonOrderId: '111-0000001-0000001',
  asin: 'B0TESTASIN1',
  sellerSku: 'SKU-1',
  settlementId: null,
  shipmentId: 'FBA15ABCDE',
  source: 'FINANCE_API',
  sourceLabel: '财务接口交易流水',
  reconciliationStatus: 'UNRECONCILED',
  reconciliationLabel: '未对账',
  reconciliationNote: null,
  reconciledAt: null,
  version: 1,
  ...over,
})

export const feeList = (items: FeeEventRow[] = [feeRow()], over: Partial<FeeEventListResponse> = {}): FeeEventListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: items.length ? null : '所选日期范围内尚无费用事件记录；店铺授权并完成财务交易同步后显示',
  items,
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
  range,
  freshness,
  ...over,
})

export const feeSummary = (over: Record<string, Partial<FeeCategorySummary>> = {}): FeeEventSummaryResponse => ({
  range,
  freshness,
  categories: FEE_CATEGORIES.map(category => ({
    category,
    label: FEE_CATEGORY_LABEL[category],
    count: category === 'FULFILLMENT' ? 3 : category === 'STORAGE' ? 1 : 0,
    totals: category === 'FULFILLMENT' ? [{ currency: 'USD', amount: -10.5 }] : category === 'STORAGE' ? [{ currency: 'USD', amount: -12.5 }] : [],
    discrepancyCount: category === 'FULFILLMENT' ? 1 : 0,
    ...over[category],
  })),
})

export const feeDetail = (over: Partial<FeeEventDetailResponse> = {}): FeeEventDetailResponse => ({
  event: feeRow(),
  transaction: {
    transactionId: 'TX-ABC-1',
    transactionType: 'Shipment',
    transactionStatus: 'RELEASED',
    transactionStatusLabel: '已释放',
    amount: 40,
    currency: 'USD',
    postedAt: '2026-10-20T08:00:00.000Z',
    description: '订单结算',
    relatedIdentifiers: [
      { name: 'ORDER_ID', value: '111-0000001-0000001' },
      { name: 'SHIPMENT_ID', value: 'FBA15ABCDE' },
    ],
  },
  siblings: [{ id: 'fe9', categoryLabel: '佣金', subtypeLabel: 'Commission', amount: -6, currency: 'USD' }],
  siblingsTruncated: false,
  history: [{ at: '2026-10-21T01:00:00.000Z', title: '对账状态：未对账 → 有差异；备注：金额不符', actorName: '王运营' }],
  orderId: 'o1',
  ...over,
})
