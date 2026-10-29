import type { EconomicsCompareResponse, EconomicsCompareRow, EconomicsPreviewResponse, EconomicsPreviewRow, EconomicsSimulation } from '@nova/api-contracts'

// 官方经济数据对账页测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['dk.economics', 'orders.api', 'finance.transactions'], qualityIssues: 0 }
const pageInfo = { hasMore: false, nextCursor: null, approxTotal: null, pageSize: 20 }

const official = { sales: 100, orderedSales: 110, refundedSales: 10, units: 5, fees: 30, ads: 8, costPerUnit: 6, cost: 30, netProceeds: 32, currency: 'USD' }
const ours = { state: 'OK' as const, sales: 100, fees: 30, ads: null, cost: 28, units: 5, netComparable: 42, profit: 42 }

export const matchRow: EconomicsCompareRow = {
  key: 'st1|SKU-MATCH|2026-10-10',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  msku: 'SKU-MATCH',
  asin: 'B0MATCH001',
  date: '2026-10-10',
  official: { ...official, ads: 0, cost: 28, netProceeds: 42 },
  ours: { ...ours, ads: 0 },
  impact: { sales: 0, fees: 0, ads: 0, cost: 0, net: 0 },
  parts: { COST: 0, ADS: 0, TIME: 0, UNEXPLAINED: 0 },
  verdict: 'MATCH',
  notComparable: null,
  notes: [],
}

export const adsRow: EconomicsCompareRow = {
  key: 'st1|SKU-ADS|2026-10-10',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  msku: 'SKU-ADS',
  asin: 'B0ADS00001',
  date: '2026-10-10',
  official,
  ours,
  impact: { sales: 0, fees: 0, ads: -8, cost: -2, net: -10 },
  parts: { COST: -2, ADS: -8, TIME: 0, UNEXPLAINED: 0 },
  verdict: 'ADS',
  notComparable: null,
  notes: ['我方广告尚未分摊到商品，官方的广告扣款全部归为广告口径'],
}

export const noOfficialRow: EconomicsCompareRow = {
  key: 'st1|SKU-NONE|2026-10-10',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  msku: 'SKU-NONE',
  asin: null,
  date: '2026-10-10',
  official: null,
  ours,
  impact: null,
  parts: null,
  verdict: 'NOT_COMPARABLE',
  notComparable: 'OFFICIAL_NO_RECORD',
  notes: [],
}

const zeroClass = { amount: 0, rows: 0 }

export function compare(over: Partial<EconomicsCompareResponse> = {}): EconomicsCompareResponse {
  return {
    state: 'OK',
    note: null,
    recognition: 'ORDERED',
    basisLabel: '下单口径',
    currency: 'USD',
    range: { from: '2026-10-01', to: '2026-10-10', days: 10, defaulted: false },
    summary: {
      rows: 3,
      comparable: 2,
      matched: 1,
      notComparable: 1,
      official: { sales: 200, fees: 60, ads: 8, cost: 58, netProceeds: 74 },
      ours: { sales: 200, fees: 60, ads: null, cost: 56, netProceeds: 84 },
      netDiff: -10,
      byClass: { COST: { amount: -2, rows: 1 }, ADS: { amount: -8, rows: 1 }, TIME: zeroClass, UNEXPLAINED: zeroClass },
      ads: { state: 'OK', official: 8, ours: 5, diff: 3, note: '我方广告为账户级，未分摊到商品；店铺合计才可比较' },
    },
    items: [adsRow, matchRow, noOfficialRow],
    pageInfo,
    officialCoverage: { from: '2026-10-02', to: '2026-10-10' },
    truncated: false,
    notes: ['官方数据每天拉取一次，近 14 天会被官方修正后重拉'],
    freshness,
    ...over,
  }
}

export const previewRow: EconomicsPreviewRow = {
  key: 'st1|SKU-ADS|AGED|2026-11-01',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  msku: 'SKU-ADS',
  asin: 'B0ADS00001',
  feeType: 'AGED_INVENTORY_SURCHARGE',
  rangeStart: '2026-11-01',
  rangeEnd: '2026-11-30',
  estimatedAmount: 12,
  quantity: 4,
  amountPerUnit: 3,
  amountPerUnitDelta: 0.5,
  currency: 'USD',
  impact: -2,
  impactState: 'OK',
}
export const unknownQuantityRow: EconomicsPreviewRow = { ...previewRow, key: 'k2', msku: 'SKU-UNK', feeType: 'LOW_INVENTORY_LEVEL_FEE', quantity: null, impact: null, impactState: 'UNKNOWN_QUANTITY' }
export const noChangeRow: EconomicsPreviewRow = { ...previewRow, key: 'k3', msku: 'SKU-FLAT', feeType: 'REFERRAL_FEES', amountPerUnitDelta: null, impact: null, impactState: 'NO_CHANGE' }

export function preview(over: Partial<EconomicsPreviewResponse> = {}): EconomicsPreviewResponse {
  return {
    state: 'OK',
    note: null,
    currency: 'USD',
    queriedAt: '2026-10-23T06:30:00.000Z',
    horizon: { from: '2026-10-24', to: '2027-02-20' },
    summary: {
      products: 3,
      rows: 3,
      changedRows: 2,
      unknownRows: 1,
      totalImpact: -2,
      byFeeType: [
        { feeType: 'AGED_INVENTORY_SURCHARGE', rows: 1, estimated: 12, impact: -2 },
        { feeType: 'LOW_INVENTORY_LEVEL_FEE', rows: 1, estimated: 12, impact: null },
      ],
    },
    items: [previewRow, unknownQuantityRow, noChangeRow],
    pageInfo,
    notes: ['官方预览每天刷新一次，超过 3 天没有刷新的行不再展示'],
    freshness: { ...freshness, sources: ['dk.economics.preview'] },
    ...over,
  }
}

export const simulation = (over: Partial<EconomicsSimulation> = {}): EconomicsSimulation => ({
  runId: 'r1',
  status: 'PENDING',
  note: '已提交亚马逊数据中心，结果通常在几分钟内返回',
  input: { sellerAccountId: 'st1', sku: 'SKU-ADS', actionType: 'AWD', quantity: 50, itemPrice: null, startDate: '2026-10-24', endDate: '2026-11-23' },
  result: null,
  ...over,
})
