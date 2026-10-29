import type { InventoryAssessment, InventoryListResponse, InventoryPolicy, InventoryRow, InventorySummaryResponse } from '@nova/api-contracts'

// 库存页前端测试的共用样例数据（类型取自契约，字段改动时这里会编译报错）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

/** 服务端视图列表：没有任何保存的视图。 */
export const NO_VIEWS = { items: [], canShare: false, limits: { user: 20, team: 30 } }

/** 一行数据的全部文字（固定列与滚动区是两个 DOM 行，按 row-id 合并）。 */
export const rowText = (id: string) =>
  Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(el => el.textContent ?? '')
    .join(' ')

/** 钉在表头下方的汇总行的全部文字；没有汇总行时为 null。 */
export const summaryText = () => {
  const rows = Array.from(document.querySelectorAll('.ag-row-pinned'))
  return rows.length === 0 ? null : rows.map(el => el.textContent ?? '').join(' ')
}

export const freshness = { lastSuccessAt: '2026-10-22T08:00:00Z', sources: ['库存接口'], qualityIssues: 0 }

export const NO_POLICY_NOTE = '尚未配置库存规则：请在“库存规则”里设置提前期、安全库存天数、目标覆盖天数与冗余倍数，风险等级才会计算（规则不使用固定阈值）'

export const noPolicyAssessment: InventoryAssessment = {
  state: 'NOT_CONNECTED',
  reason: 'NO_POLICY',
  risk: null,
  daysOfCover: null,
  noDemand: false,
  stockoutDate: null,
  fastestLeadDays: null,
  fastestReplenishDate: null,
  targetDays: null,
  policyVersion: null,
}

export const policy = (patch: Partial<InventoryPolicy> = {}): InventoryPolicy => ({
  versionNo: 2,
  level: 'TENANT',
  leadTimeDays: 45,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['SHIPPED'],
  agingFromDays: 181,
  effectiveFrom: '2026-10-01',
  changeReason: '旺季前调长提前期',
  createdBy: '林然',
  createdAt: '2026-09-30T00:00:00Z',
  ...patch,
})

export const row = (patch: Partial<InventoryRow> = {}): InventoryRow => ({
  id: 'inv1',
  sellerAccountId: 's1',
  storeName: 'Oak & Pine',
  asin: 'B001TEST',
  sku: 'SKU-1',
  fnsku: 'X001',
  title: '示例商品',
  brand: '品牌甲',
  quantity: {
    sellable: 120,
    reserved: 10,
    reservedCustomerOrder: null,
    reservedProcessing: null,
    reservedTransfer: null,
    inboundWorking: 5,
    inboundShipped: 30,
    inboundReceiving: 0,
    inboundTotal: 35,
    inboundCounted: 30,
    unsellable: 3,
    researching: 0,
    strandedQty: null,
  },
  demand: { source: 'ORDERS', low: 2, mid: 3, high: 4, units7: 20, units30: 90, units60: 170, units90: 260, stockoutDaysExcluded: 0, historyDays: 90, method: 'inventory-demand@1' },
  assessment: noPolicyAssessment,
  cover: { amazonDaysOfSupply: null, amazonShortTermDays: null, amazonLongTermDays: null, weeksOfCover: { t7: null, t30: null, t60: null, t90: null }, sellThrough: null },
  age: { granularity: null, buckets: [], snapshotDate: null, surchargeEstimate: null, atRisk: null },
  fees: {
    nextMonthStorage: null,
    ageSurchargeBands: [],
    longTerm6Month: null,
    longTerm12Month: null,
    lowInventoryLevelApplied: null,
    lowInventoryLevelFee: null,
    amazonMinimumLevel: null,
    lowFeeAtRisk: null,
  },
  seasonality: null,
  status: { amazonHealth: null, strandedReason: null },
  advice: { ourAction: null, amazonAction: null, amazonSalePrice: null, amazonSaleDays: null, amazonRemovalQty: null, amazonSavings: null, amazonShipInQty: null, amazonShipInDate: null },
  dates: { quantityUpdatedAt: '2026-10-22T07:00:00Z', planningDate: null },
  ...patch,
})

export const list = (patch: Partial<InventoryListResponse> = {}): InventoryListResponse => ({
  items: [row()],
  page: 1,
  pageSize: 20,
  total: 1,
  tab: 'all',
  policyState: 'NOT_CONNECTED',
  policyNote: NO_POLICY_NOTE,
  truncated: false,
  freshness,
  ...patch,
})

const card = (value: number | null, state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED' = 'OK', note: string | null = null) => ({ state, value, note })

export const summary = (patch: Partial<InventorySummaryResponse> = {}): InventorySummaryResponse => ({
  policyState: 'NOT_CONNECTED',
  policyNote: NO_POLICY_NOTE,
  policyVersion: null,
  skuCount: 1,
  truncated: false,
  cards: {
    sellableTotal: card(1234),
    inboundTotal: card(35),
    unsellableTotal: card(3),
    lowSkuCount: card(null, 'NOT_CONNECTED', '需要先配置库存规则'),
    excessSkuCount: card(null, 'NOT_CONNECTED', '需要先配置库存规则'),
    nextMonthStorageFee: card(null, 'NO_DATA', '尚无库存规划报告'),
    ageSurchargeEstimate: card(null, 'NO_DATA', '尚无库龄报告'),
    lowFeeRiskSkuCount: card(null, 'NO_DATA', '尚无库存规划报告'),
  },
  charts: {
    structure: [{ storeId: 's1', storeName: 'Oak & Pine', sellable: 120, reserved: 10, inbound: 35, unsellable: 3, researching: 0 }],
    ageDistribution: { granularity: null, buckets: [] },
    coverDistribution: [],
    feeTrend: { currency: 'USD', months: [], projectedNextMonth: null },
  },
  freshness,
  ...patch,
})
