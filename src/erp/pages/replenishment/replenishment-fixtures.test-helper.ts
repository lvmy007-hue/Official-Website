import type { BatchSnapshot, BatchSummary, CalcStep, PolicyListResponse, RecommendationListResponse, RecommendationRow, ReplenishCalc, ReplenishPolicy } from '@nova/api-contracts'

// 补货页前端测试的共用样例（类型取自契约，字段改动时这里会编译报错）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const steps: CalcStep[] = [
  {
    key: 'DEMAND',
    title: '需求预测',
    result: '日销 10.0 件/天（区间 8.2–12.5）',
    formula: '近 30 天日均 × 趋势系数，再扣掉订阅部分加回订阅预测',
    details: [{ label: '近 30 天日均', value: '9.5' }],
    notes: ['趋势系数按近 7 天与近 30 天之比计算'],
  },
  { key: 'TARGET', title: '目标库存', result: '目标 600 件', formula: 'max(日销 × 覆盖天数, 日销 × 提前期 + 安全库存)', details: [], notes: [] },
]

export const calc = (over: Partial<ReplenishCalc> = {}): ReplenishCalc => ({
  state: 'OK',
  reason: null,
  risk: 'HIGH',
  daysOfCover: 12.5,
  stockoutDate: '2026-11-03',
  rawQty: 433,
  recommendedQty: 440,
  purchaseQty: 400,
  qtyLow: 360,
  qtyHigh: 520,
  orderDate: '2026-10-22',
  shipDate: '2026-10-30',
  arriveDate: '2026-12-01',
  shipments: [{ mode: 'SEA', qty: 440, orderDate: '2026-10-22', shipDate: '2026-10-30', arriveDate: '2026-12-01', leadDays: 40, lateDays: 28, unitCost: 0.5 }],
  landedCost: 220,
  confidence: 0.9,
  policyVersion: 2,
  policyLevel: 'TENANT',
  dailyDemand: 10,
  subscribeUsed: false,
  supplyInLeadTime: 200,
  supplyBeyondLeadTime: 0,
  unavoidableShortage: 0,
  unavoidableIncluded: false,
  appliedOverride: [],
  steps,
  ...over,
})

export const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  id: 'b1',
  batchNo: 'RB-20261022-001',
  status: 'PENDING_REVIEW',
  today: '2026-10-22',
  computedAt: '2026-10-22T08:00:00Z',
  computedBy: '林然',
  skuTotal: 12,
  recommendedCount: 2,
  policyVersions: [{ level: 'TENANT', levelRef: 'ALL', versionNo: 2 }],
  ...over,
})

export const snapshot = (over: Partial<BatchSnapshot> = {}): BatchSnapshot => ({
  method: 'replenishment-chain@1',
  today: '2026-10-22',
  storeIds: ['st1'],
  skipped: { NO_POLICY: 0, NO_DEMAND: 3, NO_NEED: 7 },
  truncated: false,
  subscribeSaveUsed: 0,
  dataTimes: { inventoryUpdatedAt: '2026-10-22T07:30:00Z', ordersThrough: '2026-10-22T07:00:00Z', restockSnapshotDate: '2026-10-21' },
  ...over,
})

export const rec = (over: Partial<RecommendationRow> = {}): RecommendationRow => ({
  id: 'r1',
  batchId: 'b1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  sku: 'SKU-A',
  asin: 'B0AAAAAAA1',
  title: '示例商品',
  risk: 'HIGH',
  recommendedQty: 440,
  purchaseQty: 400,
  orderDate: '2026-10-22',
  shipDate: '2026-10-30',
  arriveDate: '2026-12-01',
  stockoutDate: '2026-11-03',
  suggestedShipDate: '2026-10-30',
  shipInDays: 8,
  confidence: 0.9,
  shipments: calc().shipments,
  supplyInLeadTime: 200,
  supplyBeyondLeadTime: 100,
  unavoidableShortage: 130,
  unavoidableIncluded: false,
  appliedOverride: [],
  capital: { state: 'NOT_CONNECTED', amount: null, note: '商品成本尚未接入' },
  amazon: { qty: 500, shipDate: '2026-10-28', diffQty: -60, diffReason: '亚马逊按其自己的预测日销计算，口径不同', snapshotDate: '2026-10-21' },
  steps,
  actions: [],
  ...over,
})

export const recommendations = (items: RecommendationRow[] = [rec(), rec({ id: 'r2', sku: 'SKU-B', risk: 'MEDIUM', recommendedQty: 120, purchaseQty: 120 })]): RecommendationListResponse => ({
  batch: summary(),
  snapshot: snapshot(),
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
})

export const policy = (over: Partial<ReplenishPolicy> = {}): ReplenishPolicy => ({
  level: 'TENANT',
  levelRef: 'ALL',
  versionNo: 2,
  leadTimeDays: 45,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING'],
  agingFromDays: 271,
  effectiveFrom: '2026-10-01',
  changeReason: '旺季前调整',
  createdBy: '林然',
  createdAt: '2026-10-01T00:00:00Z',
  productionDays: 10,
  domesticDays: 5,
  receivingDays: 7,
  serviceLevel: 0.95,
  transportPreference: 'AUTO',
  transportOptions: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
  casePackQty: 10,
  moq: 100,
  minOrderValue: null,
  includeUnavoidableShortage: false,
  ...over,
})

export const policies = (items: ReplenishPolicy[] = [policy()]): PolicyListResponse => ({
  items,
  page: 1,
  pageSize: 100,
  total: items.length,
  tenantCurrent: items.find(item => item.level === 'TENANT') ?? null,
  categories: ['HOME'],
})
