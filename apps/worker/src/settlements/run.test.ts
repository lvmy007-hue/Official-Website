import type { PrismaClient } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTLEMENT_RECONCILE_INTERVAL_MS, reconcileAllTenants, reconcileTenant } from './run'

// 逐张结算单核对的调度：读取、计算、写回各自有测试（reconcile.test.ts 与真实数据库测试），这里验证“挑哪些结算单、一张失败不拖垮其它、逐个企业”。
const mocks = vi.hoisted(() => ({
  loadLines: vi.fn(),
  loadTransactions: vi.fn(),
  findOrders: vi.fn(),
  loadCoverage: vi.fn(),
  sumUnattributed: vi.fn(),
  writeOutcome: vi.fn(),
}))
vi.mock('./load', () => mocks)
vi.mock('./write', () => ({ writeOutcome: mocks.writeOutcome }))

const now = new Date('2026-10-23T00:00:00Z')
const period = { settlementStartDate: new Date('2026-09-01T00:00:00Z'), settlementEndDate: new Date('2026-09-14T00:00:00Z'), currency: 'USD', totalAmount: null }
const row = (id: string, sellerAccountId = 'sa1') => ({ id, sellerAccountId, externalSettlementId: `ext-${id}`, ...period })
const line = (amount: number, amazonOrderId: string) => ({ category: 'INCOME', amount, amazonOrderId, transactionType: 'Order', amountDescription: '' })

function dbOf(rows: ReturnType<typeof row>[]) {
  const findMany = vi.fn(async (_args: { where: Record<string, unknown> }) => rows)
  return { db: { fbaSettlement: { findMany } } as unknown as PrismaClient, findMany }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.loadCoverage.mockResolvedValue({ apiStart: null, ordersStart: null })
  mocks.loadLines.mockResolvedValue({ lines: [line(100, 'A')], truncated: false })
  mocks.loadTransactions.mockResolvedValue([{ amazonOrderId: 'A', amount: 100, currency: 'USD', postedAt: new Date('2026-09-05T00:00:00Z') }])
  mocks.findOrders.mockResolvedValue(new Set(['A']))
  mocks.sumUnattributed.mockResolvedValue(new Map())
})

describe('结算核对调度', () => {
  it('只取最近 120 天的结算单；逐张核对写回并统计三种状态', async () => {
    const { db, findMany } = dbOf([row('s1'), row('s2'), row('s3')])
    mocks.loadLines.mockResolvedValueOnce({ lines: [], truncated: false }).mockResolvedValue({ lines: [line(100, 'A')], truncated: false })
    mocks.loadTransactions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ amazonOrderId: 'A', amount: 90, currency: 'USD', postedAt: new Date('2026-09-05T00:00:00Z') }])
    const result = await reconcileTenant(db, 't1', now)
    const where = findMany.mock.calls[0]![0].where as { sortAt: { gte: Date } }
    expect(where.sortAt.gte).toEqual(new Date('2026-06-25T00:00:00Z'))
    expect(result).toMatchObject({ settlements: 3, matched: 0, discrepancy: 1, pending: 2, errors: [] })
    expect(mocks.writeOutcome).toHaveBeenCalledTimes(3)
    expect(mocks.writeOutcome.mock.calls[2]![1]).toMatchObject({ tenantId: 't1', settlementId: 's3', externalSettlementId: 'ext-s3', currency: 'USD' })
  })

  it('一张结算单失败：记录错误，其余照常核对；同一店铺的覆盖范围只读一次', async () => {
    const { db } = dbOf([row('s1'), row('s2')])
    mocks.writeOutcome.mockRejectedValueOnce(new Error('写入失败')).mockResolvedValue(undefined)
    const result = await reconcileTenant(db, 't1', now)
    expect(result.errors).toEqual(['ext-s1: 写入失败'])
    expect(result).toMatchObject({ settlements: 2, matched: 1 })
    expect(mocks.loadCoverage).toHaveBeenCalledTimes(1)
  })

  it('指定店铺时只核对该店铺', async () => {
    const { db, findMany } = dbOf([])
    await reconcileTenant(db, 't1', now, 'sa9')
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa9' })
  })

  it('读取被截断（明细过多）时，把这一点交给写回记录', async () => {
    const { db } = dbOf([row('s1')])
    mocks.loadLines.mockResolvedValue({ lines: [line(100, 'A')], truncated: true })
    await reconcileTenant(db, 't1', now)
    expect(mocks.writeOutcome.mock.calls[0]![4]).toBe(true)
  })
})

describe('逐个企业', () => {
  it('每 6 小时一次；一个企业失败不影响其它企业', async () => {
    expect(SETTLEMENT_RECONCILE_INTERVAL_MS).toBe(21_600_000)
    const findMany = vi.fn(async () => [row('s1')])
    const db = { fbaSettlement: { findMany } } as unknown as PrismaClient
    mocks.loadLines.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ lines: [line(100, 'A')], truncated: false })
    const warn = vi.fn()
    const systemDb = { tenant: { findMany: vi.fn(async () => [{ id: 't1' }, { id: 't2' }]) } } as unknown as Pick<PrismaClient, 'tenant'>
    const result = await reconcileAllTenants({ systemDb, db, logger: { info: vi.fn(), warn }, now: () => now })
    expect(result).toEqual({ tenants: 2, settlements: 2 })
    expect(warn).toHaveBeenCalledTimes(1) // t1 的这张结算单失败，被记录
    expect(mocks.writeOutcome).toHaveBeenCalledTimes(1)
  })
})
