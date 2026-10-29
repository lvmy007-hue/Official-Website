import { vi } from 'vitest'
import { sessionStub } from '../../testing/harness'

// 库存接口 HTTP 测试共用的数据库替身：一条库存记录、一份企业规则版本、最近 90 天订单汇总；各用例按需覆盖。

export const SELLABLE = 100
export const record = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  sellerSku: 'SKU-1',
  asin: 'B0TEST0001',
  fnsku: 'X0TEST0001',
  fulfillableQuantity: SELLABLE,
  reservedQuantity: 2,
  inboundWorkingQuantity: 10,
  inboundShippedQuantity: 20,
  inboundReceivingQuantity: 0,
  unfulfillableQuantity: 0,
  researchQuantity: 0,
  strandedReason: null,
  daysOfSupply: null,
  sourceUpdatedAt: new Date('2026-10-22T01:00:00Z'),
  sellerAccount: { displayName: '店铺一' },
  ...over,
})

export const policyRow = (over: Record<string, unknown> = {}) => ({
  id: 'rp-1',
  tenantId: 'tenant-1',
  level: 'TENANT',
  levelRef: 'ALL',
  versionNo: 1,
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: { toString: () => '1.50' },
  inboundCounted: ['WORKING', 'SHIPPED', 'RECEIVING'],
  agingFromDays: 271,
  // 补货计算链参数（P2a-07）：旧版本都为空
  productionDays: null,
  domesticDays: null,
  receivingDays: null,
  serviceLevel: null,
  transportPreference: null,
  transportOptionsJson: null,
  casePackQty: null,
  moq: null,
  minOrderValue: null,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  changeReason: '初始规则',
  createdBy: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
})

export const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

/** 最近 90 天每个窗口都卖 300 件（日均约 10 件，近 30 天日均 10）。 */
const ordersGroupBy = (args: { _min?: unknown; where: { inventoryAvailable?: number } }) => {
  if (args._min) return Promise.resolve([{ sellerAccountId: 's1', asin: 'B0TEST0001', _min: { summaryDate: daysAgo(200) } }])
  if (args.where.inventoryAvailable === 0) return Promise.resolve([])
  return Promise.resolve([{ sellerAccountId: 's1', asin: 'B0TEST0001', _sum: { units: 300 } }])
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试替身：各 Prisma 委托在用例里按需追加 mock，不为每个表声明完整类型 */
export function prismaFor(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    membership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions }, tenant: { lifecycleStatus: 'ACTIVE' } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺一' }]) },
    replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([record()]) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', sellerSku: 'SKU-1', title: '示例商品', brand: '示例品牌' }]), findFirst: vi.fn().mockResolvedValue({ id: 'prod-1' }) },
    inventoryPlanningSnapshot: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    inventoryAgeSnapshot: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) },
    inventoryDailySnapshot: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) },
    asinDailySummary: { groupBy: vi.fn().mockImplementation(ordersGroupBy), findMany: vi.fn().mockResolvedValue([]) },
    storageFeeRecord: { groupBy: vi.fn().mockResolvedValue([]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    awdInventory: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    amazonRestockRecommendation: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    subscribeSaveOffer: { findMany: vi.fn().mockResolvedValue([]) },
    forecastOverride: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    inventoryLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
    fbaInboundPlan: { findMany: vi.fn().mockResolvedValue([]) },
    metricVersion: { findMany: vi.fn().mockResolvedValue([]) },
    entityEvent: { create: vi.fn().mockResolvedValue({}) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    ...over,
  }
  prisma.$transaction = vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])))
  return prisma
}
