import { PROFIT_BASES, PROFIT_DERIVE_TASK, PROFIT_RECENT_DAYS } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { DeriveRegistry } from '../derivers/derive'
import { createProfitTask, dayInZone, PROFIT_SOURCES, refreshAllTenants, refreshProfitDaily } from './run'

// 利润日表的派生任务（P2b-09）：登记、刷新流程（三种口径各一遍、先删后写）、逐企业容错。
// 数值与 SQL 在 assemble.test.ts 与真实库测试里验证，这里用替身数据库检查流程与参数。

const NOW = new Date('2026-10-23T12:00:00Z')

function fakeDb(options: { failTenant?: string; costing?: unknown } = {}) {
  const tx = {
    accountingPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    profitDaily: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  }
  const db = {
    tenant: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === options.failTenant) throw new Error('boom')
        return { timezone: 'America/Los_Angeles' }
      }),
    },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(options.costing === undefined ? null : { valueJson: options.costing }) },
    costVersion: { findMany: vi.fn().mockResolvedValue([]) },
    purchaseOrderLine: { findMany: vi.fn().mockResolvedValue([]) },
    landedCostAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    fxRate: { findMany: vi.fn().mockResolvedValue([]) },
    adsProfile: { findMany: vi.fn().mockResolvedValue([]) },
    adsMetric: { groupBy: vi.fn().mockResolvedValue([]) },
    adsAdvertisedProductMetric: { groupBy: vi.fn().mockResolvedValue([]) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([]) },
    financePolicyVersion: { findMany: vi.fn().mockResolvedValue([]) },
    profitItem: { findMany: vi.fn().mockResolvedValue([]) },
    profitItemMapping: { findMany: vi.fn().mockResolvedValue([]) },
    allocationRule: { findMany: vi.fn().mockResolvedValue([]) },
    estimatedFee: { findMany: vi.fn().mockResolvedValue([]) },
    shipmentItem: { findMany: vi.fn().mockResolvedValue([]) },
    fbaInboundPlan: { findMany: vi.fn().mockResolvedValue([]) },
    removalOrder: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  }
  return { db, tx }
}

describe('利润日表派生任务', () => {
  it('登记到派生注册表：名称与来源（订单、财务、广告、成本），来源触发该任务', () => {
    const registry = new DeriveRegistry()
    registry.register(createProfitTask(fakeDb().db as never))
    expect(registry.list().map(task => task.name)).toEqual([PROFIT_DERIVE_TASK])
    for (const source of PROFIT_SOURCES) expect(registry.forSource(source).map(task => task.name)).toEqual([PROFIT_DERIVE_TASK])
    expect(registry.forSource('inventory')).toEqual([])
  })

  it('企业时区的日历日：同一时刻在不同时区是不同的一天', () => {
    expect(dayInZone(new Date('2026-10-23T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-22')
    expect(dayInZone(new Date('2026-10-23T03:00:00Z'), 'Asia/Shanghai')).toBe('2026-10-23')
  })

  it('刷新：三种口径各查一遍销售与费用，同一事务里先删范围内旧行再写入；没有数据时不写行', async () => {
    const { db, tx } = fakeDb()
    expect(await refreshProfitDaily(db as never, { tenantId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-05' }, NOW)).toBe(0)
    // 每种口径两条聚合查询（销售、费用明细）
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(PROFIT_BASES.length * 2)
    for (const call of db.$queryRawUnsafe.mock.calls) expect(call.slice(1)).toEqual(['t1', '2026-10-01', '2026-10-05', 'America/Los_Angeles'])
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    const where = tx.profitDaily.deleteMany.mock.calls[0]![0].where
    expect(where.tenantId).toBe('t1')
    expect(where.profitDate.gte.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(where.profitDate.lte.toISOString()).toBe('2026-10-05T00:00:00.000Z')
    expect(tx.profitDaily.createMany).not.toHaveBeenCalled()
  })

  it('有成本批次时，销售往前读到最早批次那天（让先进先出接上历史），费用明细仍只读刷新范围', async () => {
    const { db } = fakeDb()
    db.costVersion.findMany.mockImplementation(async (args: { where: { status: string } }) =>
      args.where.status === 'ACTIVE'
        ? [
            {
              id: 'v1',
              sku: 'A',
              effectiveFrom: new Date('2026-08-01T00:00:00Z'),
              currency: 'USD',
              unitProductCost: 3,
              unitFirstMileCost: null,
              unitOtherCost: null,
              source: 'MANUAL',
              sourceDocId: null,
            },
          ]
        : [],
    )
    await refreshProfitDaily(db as never, { tenantId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-05' }, NOW)
    // 手工版本没有数量，不需要历史；改成采购收货版本再看
    expect(db.$queryRawUnsafe.mock.calls.every(call => call[2] === '2026-10-01')).toBe(true)

    const second = fakeDb()
    second.db.costVersion.findMany.mockImplementation(async (args: { where: { status: string } }) =>
      args.where.status === 'ACTIVE'
        ? [
            {
              id: 'v1',
              sku: 'A',
              effectiveFrom: new Date('2026-08-01T00:00:00Z'),
              currency: 'USD',
              unitProductCost: 3,
              unitFirstMileCost: null,
              unitOtherCost: null,
              source: 'PURCHASE_RECEIPT',
              sourceDocId: 'po1',
            },
          ]
        : [],
    )
    second.db.purchaseOrderLine.findMany.mockResolvedValue([{ purchaseOrderId: 'po1', sellerSku: 'A', receivedQuantity: 50 }])
    await refreshProfitDaily(second.db as never, { tenantId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-05' }, NOW)
    const froms = second.db.$queryRawUnsafe.mock.calls.map(call => call[2])
    // 每种口径：销售从 8 月 1 日起，费用明细从 10 月 1 日起
    expect(froms.sort()).toEqual(['2026-08-01', '2026-08-01', '2026-08-01', '2026-10-01', '2026-10-01', '2026-10-01'])
  })

  it('逐企业重算最近 45 天：范围含明天，单个企业出错不影响其它企业', async () => {
    const { db } = fakeDb({ failTenant: 'bad' })
    const warn = vi.fn()
    const systemDb = { tenant: { findMany: vi.fn().mockResolvedValue([{ id: 'good' }, { id: 'bad' }, { id: 'good-2' }]) } }
    const result = await refreshAllTenants({ systemDb: systemDb as never, db: db as never, logger: { info: vi.fn(), warn }, now: () => NOW })
    expect(result).toEqual({ tenants: 3, rows: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatchObject({ event: 'profit_refresh_failed', error: 'boom' })
    const firstCall = db.$queryRawUnsafe.mock.calls[0]!
    expect(firstCall[2]).toBe('2026-09-09') // 2026-10-23 往前 44 天（含今天共 45 天）
    expect(firstCall[3]).toBe('2026-10-24')
    expect(PROFIT_RECENT_DAYS).toBe(45)
    expect(systemDb.tenant.findMany.mock.calls[0]![0].where).toEqual({ lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } })
  })

  it('存货计价设置不合法：按先进先出算（不报错）', async () => {
    const { db } = fakeDb({ costing: 'LIFO' })
    await expect(refreshProfitDaily(db as never, { tenantId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-05' }, NOW)).resolves.toBe(0)
  })
})
