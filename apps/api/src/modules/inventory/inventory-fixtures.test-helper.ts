import type { InventoryAssessment, InventoryDemand, InventoryPolicy, InventoryRow } from '@nova/api-contracts'
import { DEMAND_METHOD } from '@nova/api-contracts'

// 库存模块单元测试共用的数据：一份企业规则版本与一行库存健康记录（可按需覆盖）。

export const TODAY = '2026-10-22'

export const policy = (over: Partial<InventoryPolicy> = {}): InventoryPolicy => ({
  versionNo: 3,
  level: 'TENANT',
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING', 'SHIPPED', 'RECEIVING'],
  agingFromDays: 271,
  effectiveFrom: '2026-10-01',
  changeReason: '测试',
  createdBy: '测试成员',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

export const demand = (over: Partial<InventoryDemand> = {}): InventoryDemand => ({
  source: 'ORDERS',
  low: 8,
  mid: 10,
  high: 12,
  units7: 70,
  units30: 300,
  units60: 600,
  units90: 900,
  stockoutDaysExcluded: 0,
  historyDays: 90,
  method: DEMAND_METHOD,
  ...over,
})

export const assessment = (over: Partial<InventoryAssessment> = {}): InventoryAssessment => ({
  state: 'OK',
  reason: null,
  risk: 'NORMAL',
  daysOfCover: 40,
  noDemand: false,
  stockoutDate: '2026-12-01',
  fastestLeadDays: 30,
  fastestReplenishDate: '2026-11-21',
  targetDays: 60,
  policyVersion: 3,
  ...over,
})

export function row(over: { id?: string; sku?: string; storeId?: string; risk?: InventoryAssessment['risk']; sellable?: number } & Partial<InventoryRow> = {}): InventoryRow {
  const { id = 'inv-1', sku = 'SKU-1', storeId = 's1', risk = 'NORMAL', sellable = 400, ...rest } = over
  return {
    id,
    sellerAccountId: storeId,
    storeName: '店铺一',
    asin: `B0${sku}`,
    sku,
    fnsku: `X0${sku}`,
    title: '示例商品',
    brand: '示例品牌',
    quantity: {
      sellable,
      reserved: 5,
      reservedCustomerOrder: 3,
      reservedProcessing: 1,
      reservedTransfer: 1,
      inboundWorking: 10,
      inboundShipped: 20,
      inboundReceiving: 0,
      inboundTotal: 30,
      inboundCounted: 30,
      unsellable: 0,
      researching: 0,
      strandedQty: null,
    },
    demand: demand(),
    assessment: assessment({ risk }),
    cover: { amazonDaysOfSupply: 38, amazonShortTermDays: null, amazonLongTermDays: null, weeksOfCover: { t7: null, t30: null, t60: null, t90: null }, sellThrough: null },
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
    dates: { quantityUpdatedAt: '2026-10-22T01:00:00.000Z', planningDate: null },
    ...rest,
  }
}
