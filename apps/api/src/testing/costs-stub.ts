import { vi } from 'vitest'
import { createWriteGuardStubs, sessionStub } from './harness'

// 商品成本接口测试用的内存替身（P2b-14）：一个有商品的 SKU“SKU-A”，一条生效的采购单价版本，一条草稿；企业时区 UTC，今天由测试传入的时间决定。

export const dec = (value: string) => ({ toString: () => value })
export const day = (text: string) => new Date(`${text}T00:00:00Z`)
/** 距今 n 天的日期（UTC 零点）：测试用真实时钟，覆盖状态按相对天数断言。 */
export const daysAgo = (days: number) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))
}

export const versionRow = (over: Record<string, unknown> = {}) => ({
  id: 'cv1',
  sku: 'SKU-A',
  versionNo: 1,
  effectiveFrom: daysAgo(10),
  currency: 'USD',
  unitProductCost: dec('10'),
  unitFirstMileCost: null,
  unitDutyCost: null,
  unitOtherCost: null,
  source: 'MANUAL',
  status: 'ACTIVE',
  sourceDocId: null,
  note: null,
  version: 2,
  createdBy: 'user-1',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-02T00:00:00Z'),
  activatedBy: 'user-1',
  activatedAt: new Date('2026-09-01T00:00:00Z'),
  replacedById: null,
  replacedAt: null,
  ...over,
})

export interface CostsStubOptions {
  versions?: Array<Record<string, unknown>>
  /** 为 false 表示这个 SKU 没有商品（用来测未知 SKU）。 */
  hasProduct?: boolean
  closed?: Array<Record<string, unknown>>
  over?: Record<string, unknown>
  /** 迁移后的角色：权限点就是新体系点位，costs.read 不再顺带带出 field.cost。 */
  migratedRole?: boolean
}

export function costsPrisma(permissions: string[], options: CostsStubOptions = {}) {
  const guards = createWriteGuardStubs()
  const versions = options.versions ?? [versionRow()]
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    fbaProduct: {
      groupBy: vi.fn().mockResolvedValue(options.hasProduct === false ? [] : [{ sellerSku: 'SKU-A' }]),
      findMany: vi.fn().mockResolvedValue(options.hasProduct === false ? [] : [{ sellerSku: 'SKU-A', title: '示例商品', asin: 'B0TEST' }]),
      findFirst: vi.fn().mockResolvedValue(options.hasProduct === false ? null : { id: 'p1', title: '示例商品', asin: 'B0TEST' }),
    },
    costVersion: {
      groupBy: vi.fn().mockImplementation(async (args: { by: string[]; where: Record<string, unknown> }) => {
        if (args.by.length === 1) {
          if ('status' in args.where) {
            const productRows = versions.filter(row => row.status === 'ACTIVE' && row.unitProductCost)
            return productRows.length ? [{ sku: 'SKU-A', _max: { effectiveFrom: productRows[0]!.effectiveFrom } }] : []
          }
          return versions.length ? [{ sku: 'SKU-A', _max: { versionNo: Math.max(...versions.map(row => row.versionNo as number)) } }] : []
        }
        const statuses = [...new Set(versions.map(row => row.status as string))]
        return statuses.map(status => ({ sku: 'SKU-A', status, _count: { _all: versions.filter(row => row.status === status).length }, _max: { updatedAt: new Date('2026-09-02T00:00:00Z') } }))
      }),
      findMany: vi.fn().mockResolvedValue(versions),
      findFirst: vi.fn().mockImplementation(async (args: { where: Record<string, unknown>; orderBy?: unknown }) => {
        if (args.orderBy) return versions[0] ? { versionNo: Math.max(...versions.map(row => row.versionNo as number)) } : null
        const id = args.where.id as string | undefined
        if (id) return versions.find(row => row.id === id) ?? null
        return versions[0] ? { id: versions[0].id } : null
      }),
      create: vi.fn().mockResolvedValue({ id: 'cv9', version: 1, versionNo: 2 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    accountingPeriod: { findMany: vi.fn().mockResolvedValue(options.closed ?? []) },
    fxRate: { findMany: vi.fn().mockResolvedValue([]) },
    inventoryPlanningSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null) },
    purchaseOrder: { findMany: vi.fn().mockResolvedValue([]) },
    purchaseOrderLine: { findMany: vi.fn().mockResolvedValue([]) },
    firstMileShipment: { findMany: vi.fn().mockResolvedValue([]) },
    landedCostAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    ...options.over,
  }
  if (options.migratedRole) {
    prisma.membership = { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions, version: 2 }, tenant: { lifecycleStatus: 'ACTIVE' } }) }
  }
  Object.assign(prisma.membership as object, { findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '采购小李', email: 'l@example.com' } }]) })
  prisma.auditEvent = guards.auditEvent
  prisma.stepUpVerification = guards.stepUpVerification
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>
}
