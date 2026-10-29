import type { ReturnAwaitingResponse, ReturnDetailResponse, ReturnListResponse, ReturnListRow } from '@nova/api-contracts'

// 退货页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

/** 表格行（AG Grid 以 row-id 标识）的全部文字；固定列与滚动区会各有一份，这里合并。 */
export const rowText = (id: string) =>
  Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(element => element.textContent ?? '')
    .join(' ')

export const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['rpt.customer-returns'], qualityIssues: 0 }

const sellable = { group: 'SELLABLE', label: '可售', sellable: true, raw: 'SELLABLE' } as const
const unknown = { group: 'UNKNOWN', label: '处置未知', sellable: null, raw: null } as const

export const returnRow = (over: Partial<ReturnListRow> = {}): ReturnListRow => ({
  id: 'r1',
  amazonOrderId: '111-2223334-5556667',
  orderId: 'o1',
  returnDate: '2026-10-18T10:00:00.000Z',
  sellerAccountId: 's1',
  storeName: '美国主店',
  asin: 'B0TESTASIN1',
  sku: 'SKU-1',
  quantity: 1,
  reason: 'DEFECTIVE',
  reasonLabel: '商品有缺陷',
  reasonCategory: '商品质量',
  disposition: sellable,
  fulfillmentCenterId: 'ONT8',
  licensePlateNumber: 'LPNAAAA111',
  refund: { state: 'FULL', amount: 59.9, firstRefundAt: '2026-10-19T00:00:00.000Z' },
  receipt: { state: 'REFUNDED_AFTER_RECEIPT', label: '收到退货后退款' },
  currency: 'USD',
  reimbursement: { state: 'NOT_REVIEWED', label: '尚未核查', caseId: null },
  ...over,
})

export const returnList = (items: ReturnListRow[] = [returnRow()], over: Partial<ReturnListResponse> = {}): ReturnListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: items.length ? null : '所选日期范围内尚无退货记录',
  items,
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
  range: { from: '2026-07-25', to: '2026-10-23', defaulted: true },
  filterLimited: false,
  freshness,
  ...over,
})

export const awaiting = (over: Partial<ReturnAwaitingResponse> = {}): ReturnAwaitingResponse => ({
  state: 'OK',
  note: null,
  thresholdDays: 30,
  items: [
    {
      amazonOrderId: '333-0000000-0000003',
      orderId: 'o3',
      storeName: '美国主店',
      sellerAccountId: 's1',
      firstRefundAt: '2026-08-01T00:00:00.000Z',
      refundAmount: 25,
      currency: 'USD',
      daysSinceRefund: 83,
      items: [{ asin: 'B0TESTASIN1', sku: 'SKU-1', quantity: 1 }],
    },
  ],
  truncated: false,
  range: { from: '2026-04-26', to: '2026-10-23', defaulted: true },
  basis: '退款不等于要退货；这是待核实清单，不是赔付结论。',
  freshness,
  ...over,
})

export const detail = (over: Partial<ReturnDetailResponse> = {}): ReturnDetailResponse => ({
  record: {
    id: 'r1',
    returnDate: '2026-10-18T10:00:00.000Z',
    quantity: 1,
    sellerAccountId: 's1',
    storeName: '美国主店',
    asin: 'B0TESTASIN1',
    sku: 'SKU-1',
    fnsku: 'X00TEST1',
    licensePlateNumber: 'LPNAAAA111',
    fulfillmentCenterId: 'ONT8',
    reportStatus: 'Unit returned to inventory',
    importedAt: '2026-10-19T02:00:00.000Z',
  },
  order: { id: 'o1', amazonOrderId: '111-2223334-5556667', purchaseDate: '2026-10-10T10:00:00.000Z', amount: 59.9, currency: 'USD', statusLabel: '已发货', isReplacement: false },
  product: { productId: null, title: '测试商品一', imageUrl: null },
  reason: { code: 'DEFECTIVE', label: '商品有缺陷', category: '商品质量' },
  buyerComments: { state: 'AVAILABLE', kinds: ['PHONE'], retainedUntil: '2026-11-17T10:00:00.000Z' },
  disposition: sellable,
  refund: {
    state: 'FULL',
    amount: 59.9,
    firstRefundAt: '2026-10-19T00:00:00.000Z',
    currency: 'USD',
    items: [{ postedAt: '2026-10-19T00:00:00.000Z', amount: 59.9, currency: 'USD', status: 'RELEASED' }],
    fees: [{ label: '退货处理费', amount: -3.2, currency: 'USD', postedAt: '2026-10-19T00:00:00.000Z' }],
    feeTotal: -3.2,
  },
  receipt: { state: 'REFUNDED_AFTER_RECEIPT', label: '收到退货后退款' },
  reimbursement: { state: 'NOT_REVIEWED', label: '尚未核查', caseId: null },
  siblings: [{ id: 'r2', asin: 'B0TESTASIN2', sku: 'SKU-2', quantity: 2, returnDate: '2026-10-18T10:00:00.000Z', disposition: unknown }],
  timeline: [
    { at: '2026-10-10T10:00:00.000Z', kind: 'ORDER', title: '下单', source: '订单接口' },
    { at: '2026-10-18T10:00:00.000Z', kind: 'RETURN_RECEIVED', title: '退货记录', source: '客户退货报告' },
  ],
  freshness,
  ...over,
})
