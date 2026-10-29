import type { PromotionDetailResponse, PromotionListResponse, PromotionRow, PromotionSync } from '@nova/api-contracts'

// 促销页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['促销'], qualityIssues: 0 }
export const normalSync: PromotionSync = { status: 'NORMAL', statusLabel: '正常', lastSuccessAt: '2026-10-23T08:00:00.000Z', errorCode: null, errorMessage: null, rolePending: false }
export const pendingSync: PromotionSync = { status: 'UNAUTHORIZED', statusLabel: '未授权', lastSuccessAt: null, errorCode: 'ROLE_MISSING', errorMessage: '促销接口角色未获批', rolePending: true }

export const promotionRow = (over: Partial<PromotionRow> = {}): PromotionRow => ({
  id: 'pr1',
  promotionId: 'P-DEAL-1',
  sellerAccountId: 's1',
  storeName: '美国主店',
  type: 'DEAL',
  typeLabel: '秒杀',
  couponType: null,
  title: '十月秒杀',
  status: 'RUNNING',
  statusLabel: '进行中',
  revisionStatus: null,
  startAt: '2026-10-20T07:00:00.000Z',
  endAt: '2026-10-27T07:00:00.000Z',
  itemCount: 2,
  selectionType: 'ITEMS',
  itemsTruncated: false,
  discountText: '立减 20%',
  budget: { type: 'AMOUNT', value: 500, currency: 'USD' },
  errorCount: 0,
  warningCount: 1,
  reported: { state: 'OK', units: 15, sales: 299.85, redemptions: 12 },
  platformFee: { state: 'OK', amount: 100 },
  ...over,
})

export const promotionList = (items: PromotionRow[] = [promotionRow()], over: Partial<PromotionListResponse> = {}): PromotionListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: null,
  items,
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
  sync: normalSync,
  freshness,
  basis: '绩效数字来自亚马逊促销绩效报告与优惠券绩效报告',
  ...over,
})

export const promotionDetail = (over: Partial<PromotionDetailResponse> = {}): PromotionDetailResponse => ({
  promotion: { ...promotionRow(), mappingId: 'TRK-1', benefitTextFull: '立减 20%', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', marketplaceId: 'ATVPDKIKX0DER' },
  effect: {
    state: 'OK',
    note: null,
    window: { from: '2026-10-20', to: '2026-10-29', days: 10 },
    baseline: { state: 'OK', usedDays: 28, excludedDays: 0, from: '2026-09-22', to: '2026-10-19' },
    actual: { units: 300, sales: 6000 },
    expected: { units: 100, sales: 2000 },
    incremental: { units: 200, sales: 4000, liftPct: 200 },
    reported: { state: 'OK', units: 15, sales: 299.85, redemptions: 12, clips: null, budgetSpent: null, note: null },
    daily: [{ date: '2026-10-20', actualUnits: 30, actualSales: 600, baselineUnits: 10, baselineSales: 200, reportedUnits: 12, reportedSales: 240 }],
  },
  items: {
    state: 'OK',
    note: null,
    selectionType: 'ITEMS',
    total: 2,
    truncated: false,
    items: [
      { asin: 'B0AAAAAAA1', sku: 'SKU-1', productId: 'p1', productTitle: '示例商品', benefitText: '立减 20%', perCustomerUses: 1, budgetText: null, issues: [] },
      {
        asin: 'B0AAAAAAA2',
        sku: 'SKU-2',
        productId: null,
        productTitle: null,
        benefitText: '固定价 $19.99',
        perCustomerUses: null,
        budgetText: null,
        issues: [{ code: 'LOW_STOCK', message: '库存偏低', severity: 'WARNING' }],
      },
    ],
  },
  cost: {
    state: 'OK',
    note: null,
    currency: 'USD',
    discount: { state: 'OK', amount: 400, orderLines: 30, note: '来自订单明细里的促销折扣' },
    platformFee: { state: 'OK', amount: 100, lines: [{ label: 'DealParticipationFee', amount: 100, count: 2 }], note: null },
    total: 500,
    feePreview: { upfront: { amount: 150, currency: 'USD', frequency: 'ONE_TIME' }, variablePct: 2, capAmount: 25 },
  },
  profit: {
    state: 'OK',
    note: null,
    currency: 'USD',
    actualProfit: 1500,
    expectedProfit: 500,
    incrementalProfit: 1000,
    roi: { value: 2, denominator: 500, formula: '促销投入回报率 = 增量毛利 ÷（折扣成本 + 平台费用）' },
  },
  issues: { state: 'OK', note: null, promotionIssues: [{ code: 'PRICE_NEAR_FLOOR', message: '折后价接近最低价', severity: 'WARNING' }], itemIssueCount: 1, latestRevision: null },
  ads: { state: 'NOT_CONNECTED', note: '尚未接入：这个店铺还没有绑定亚马逊广告账户', totals: { spend: null, sales: null, orders: null }, items: [], truncated: false },
  write: { supported: false, note: '亚马逊促销接口（2025-12-01 版）只提供查询：这里只读。' },
  methodNote: '增量按基线法估算。促销投入回报率是模型估算，不是亚马逊给的数字。',
  sync: normalSync,
  freshness,
  ...over,
})
