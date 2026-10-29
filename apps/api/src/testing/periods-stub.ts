import { vi } from 'vitest'
import { createWriteGuardStubs, sessionStub } from './harness'

// 期间关账接口测试用的内存替身（P2b-13）：一个 2025 年 3 月的美国主店期间，六个检查项默认全部通过。

export const dec = (value: string) => ({ toString: () => value })
export const MONTH_START = new Date('2025-03-01T00:00:00Z')
export const MONTH_END = new Date('2025-03-31T00:00:00Z')

export const periodRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  periodStart: MONTH_START,
  periodEnd: MONTH_END,
  status: 'OPEN',
  version: 1,
  checklistJson: {},
  checkedBy: null,
  checkedAt: null,
  approvalDecision: null,
  approvedBy: null,
  approvedAt: null,
  approvalComment: null,
  closeCount: 0,
  closedBy: null,
  closedAt: null,
  reopenedBy: null,
  reopenedAt: null,
  reopenReason: null,
  createdBy: 'user-1',
  sellerAccount: { displayName: '美国主店' },
  ...over,
})

/** 一份通过的检查清单（JSON 形态，和库里存的一样）。 */
export const passedChecklist = {
  checkedAt: '2026-10-20T00:00:00.000Z',
  passed: true,
  items: ['SYNC_COMPLETE', 'SETTLEMENTS_ARRIVED', 'COST_COVERAGE', 'FX_COMPLETE', 'ADS_ALLOCATED', 'RECON_EXCEPTIONS'].map(key => ({
    key,
    label: key,
    state: 'PASS',
    baseState: 'PASS',
    summary: 'ok',
    details: [],
    value: 0,
    acknowledgeable: key === 'ADS_ALLOCATED' || key === 'RECON_EXCEPTIONS',
    acknowledgement: null,
  })),
}

export interface PeriodsStubOptions {
  /** 当前期间；null 表示不存在或不在范围内。 */
  period?: Record<string, unknown> | null
  /** 利润日表里“广告已分摊”的行数；0 表示广告分摊尚未接入。 */
  adsAllocatedRows?: number
  openExceptions?: number
  /** 同步记录；默认订单与财务交易都正常且覆盖到 2025-04-05。 */
  freshness?: Array<Record<string, unknown>>
  settlements?: Array<Record<string, unknown>>
  snapshots?: Array<Record<string, unknown>>
  /** 其他仍已关账、日期重叠的期间。 */
  otherClosed?: Array<Record<string, unknown>>
  /** 迁移后的角色（权限版本 2）：权限点就是新体系点位，finance.read 不再顺带带出 field.profit。 */
  migratedRole?: boolean
  over?: Record<string, unknown>
}

const SUMS = { units: 100, costedUnits: 100, revenue: dec('1000'), refunds: dec('50'), feeCommission: dec('150'), productCost: dec('300'), profit: dec('400'), adsUnallocated: null }

export function periodsPrisma(permissions: string[], options: PeriodsStubOptions = {}) {
  const guards = createWriteGuardStubs()
  const period = options.period === undefined ? periodRow() : options.period
  const last: { data?: Record<string, unknown> } = {}
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: 's1', displayName: '美国主店' }),
      findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]),
    },
    accountingPeriod: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { select?: Record<string, unknown> }) => (args.select && 'sellerAccount' in args.select ? (period ? [period] : []) : (options.otherClosed ?? []))),
      count: vi.fn().mockResolvedValue(period ? 1 : 0),
      groupBy: vi.fn().mockResolvedValue(period ? [{ status: (period as { status: string }).status, _count: { _all: 1 } }] : []),
      // 取期间用完整选择；乐观锁更新后的回读只选 id、version、status
      findFirst: vi.fn().mockImplementation(async (args: { select?: Record<string, unknown> }) => {
        if (!period) return null
        if (args.select && 'sellerAccount' in args.select) return period
        return { id: 'p1', version: (period as { version: number }).version + 1, status: (last.data?.status as string | undefined) ?? (period as { status: string }).status }
      }),
      create: vi.fn().mockResolvedValue({ id: 'p9', version: 1, status: 'OPEN' }),
      updateMany: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
        last.data = args.data
        return { count: 1 }
      }),
    },
    allocationRule: { findMany: vi.fn().mockResolvedValue([]) },
    metricVersion: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    periodSnapshot: { findMany: vi.fn().mockResolvedValue(options.snapshots ?? []), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'snap1' }) },
    dataFreshness: {
      findMany: vi.fn().mockResolvedValue(
        options.freshness ?? [
          { sourceKey: 'orders.api', status: 'NORMAL', dataThrough: new Date('2025-04-05T00:00:00Z'), lastSuccessAt: new Date('2025-04-05T00:00:00Z') },
          { sourceKey: 'finance.transactions', status: 'NORMAL', dataThrough: new Date('2025-04-05T00:00:00Z'), lastSuccessAt: new Date('2025-04-05T00:00:00Z') },
        ],
      ),
    },
    fbaSettlement: { findMany: vi.fn().mockResolvedValue(options.settlements ?? [{ externalSettlementId: 'S1', settlementEndDate: new Date('2025-04-02T00:00:00Z'), txnCount: 12 }]) },
    profitDaily: {
      aggregate: vi.fn().mockResolvedValue({ _sum: SUMS, _count: { _all: 5 } }),
      count: vi.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => {
        if ('adsSpendAllocated' in args.where) return options.adsAllocatedRows ?? 5
        if ('flags' in args.where || args.where.profit === null) return 0
        return 5
      }),
      groupBy: vi.fn().mockImplementation(async (args: { by: string[] }) => {
        if (args.by[0] === 'costCurrency') return []
        if (args.by[0] === 'metricVersion') return [{ metricVersion: 'profit-v1' }]
        if (args.by[0] === 'sku' && 'orderBy' in args && Array.isArray((args as { orderBy: unknown }).orderBy)) {
          return [{ sku: 'A', _sum: { ...SUMS, revenue: dec('1000') }, _max: { asin: 'B0TEST' } }]
        }
        return []
      }),
    },
    fxRate: {
      findMany: vi.fn().mockResolvedValue([{ quoteCurrency: 'CNY', rateDate: new Date('2025-03-03T00:00:00Z'), rate: dec('7.1'), source: 'ECB', isFallback: false, isManualOverride: false }]),
      updateMany: vi.fn().mockResolvedValue({ count: 31 }),
    },
    costVersion: { findMany: vi.fn().mockResolvedValue([]) },
    approvalRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ap-1' }),
      update: vi.fn().mockResolvedValue({ id: 'ap-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    reconciliationException: { aggregate: vi.fn().mockResolvedValue({ _count: { _all: options.openExceptions ?? 0 }, _sum: { absAmount: options.openExceptions ? dec('12.5') : null } }) },
    ...options.over,
  }
  if (options.migratedRole) {
    prisma.membership = { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions, version: 2 }, tenant: { lifecycleStatus: 'ACTIVE' } }) }
  }
  Object.assign(prisma.membership as object, {
    findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', role: { permissions: ['*'], version: 2 }, user: { displayName: '财务小王', email: 'w@example.com' } }]),
  })
  prisma.auditEvent = guards.auditEvent
  prisma.stepUpVerification = { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() }
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

/** 一份已锁定的快照行（库里存的形态）：三种口径合计相同，销售额由参数指定，一个 SKU。 */
export function snapshotRow(revenue = 777, revision = 1, over: Record<string, unknown> = {}) {
  const totals = {
    units: 10,
    costedUnits: 10,
    revenue,
    refunds: 0,
    feeCommission: 0,
    feeFulfillment: 0,
    feeStorage: 0,
    feeAged: 0,
    feeInbound: 0,
    feeOther: 0,
    promotion: 0,
    adsSpendAllocated: null,
    adsUnallocated: null,
    productCost: 100,
    firstMileCost: null,
    otherCost: null,
    reimbursement: 0,
    rows: 3,
    incompleteRows: 0,
    profit: 500,
  }
  const basis = {
    totals,
    skus: [
      {
        sku: 'A',
        asin: 'B0TEST',
        units: 10,
        costedUnits: 10,
        revenue,
        refunds: 0,
        fees: 0,
        promotion: 0,
        ads: null,
        productCost: 100,
        firstMileCost: null,
        otherCost: null,
        reimbursement: 0,
        profit: 500,
      },
    ],
    skuCount: 1,
    truncated: false,
  }
  return {
    revision,
    lockedBy: 'user-1',
    lockedAt: new Date('2026-10-01T00:00:00Z'),
    diffJson: null,
    profitSnapshotJson: { version: 1, metricVersions: ['profit-v1'], from: '2025-03-01', to: '2025-03-31', bases: { ORDERED: basis, SHIPPED: basis, SETTLED: basis } },
    fxSnapshotJson: { from: '2025-03-01', to: '2025-03-31', currencies: ['CNY'], rates: [{ quote: 'CNY', date: '2025-03-03', rate: 7.1, source: 'ECB', fallback: false, manual: false }] },
    costVersionSnapshotJson: {
      asOf: '2025-03-31',
      skuCount: 1,
      truncated: false,
      versions: [{ sku: 'A', versionNo: 1, status: 'ACTIVE', effectiveFrom: '2025-01-01', currency: 'CNY', productCost: 20, firstMileCost: null, otherCost: null }],
    },
    ...over,
  }
}
