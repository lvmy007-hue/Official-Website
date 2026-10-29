import { describe, expect, it, vi } from 'vitest'
import type { ProfitRow } from './assemble'
import { frozenSpans, isFrozen, writeProfit } from './write'

// 关账冻结（P2b-13）：关账中与已关账期间内、该店铺的利润日表行不删也不写，其余照常重算。

const row = (sellerAccountId: string, profitDate: string) =>
  ({ sellerAccountId, profitDate, sku: 'A', asin: null, basis: 'ORDERED', costing: 'FIFO', currency: 'USD', flags: [] }) as unknown as ProfitRow

function fakeDb(periods: Array<{ sellerAccountId: string; periodStart: string; periodEnd: string }>) {
  const tx = {
    accountingPeriod: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          periods.map(period => ({ sellerAccountId: period.sellerAccountId, periodStart: new Date(`${period.periodStart}T00:00:00Z`), periodEnd: new Date(`${period.periodEnd}T00:00:00Z`) })),
        ),
    },
    profitDaily: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  }
  return { tx, db: { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) } }
}

const RANGE = { from: '2026-09-01', to: '2026-10-05' }
const NOW = new Date('2026-10-23T12:00:00Z')

describe('利润日表落库的关账冻结', () => {
  it('没有冻结的期间：和以前一样，先删范围内旧行再写入全部', async () => {
    const { db, tx } = fakeDb([])
    expect(await writeProfit(db as never, 't1', RANGE, [row('s1', '2026-09-03'), row('s2', '2026-10-01')], NOW)).toBe(2)
    expect(tx.profitDaily.deleteMany.mock.calls[0]![0].where.NOT).toBeUndefined()
    expect(tx.profitDaily.createMany.mock.calls[0]![0].data).toHaveLength(2)
  })

  it('只查关账中与已关账的期间，且只查与刷新范围重叠的', async () => {
    const { db, tx } = fakeDb([])
    await writeProfit(db as never, 't1', RANGE, [], NOW)
    const where = tx.accountingPeriod.findMany.mock.calls[0]![0].where
    expect(where.tenantId).toBe('t1')
    expect(where.status).toEqual({ in: ['CLOSING', 'CLOSED'] })
    expect(where.periodStart.lte.toISOString()).toBe('2026-10-05T00:00:00.000Z')
    expect(where.periodEnd.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('冻结店铺在冻结日期内的行不写，也不被删；别的店铺与冻结范围外的日期照常', async () => {
    const { db, tx } = fakeDb([{ sellerAccountId: 's1', periodStart: '2026-09-01', periodEnd: '2026-09-30' }])
    const written = await writeProfit(db as never, 't1', RANGE, [row('s1', '2026-09-03'), row('s1', '2026-10-01'), row('s2', '2026-09-03')], NOW)
    expect(written).toBe(2)
    const data = tx.profitDaily.createMany.mock.calls[0]![0].data as Array<{ sellerAccountId: string; profitDate: Date }>
    expect(data.map(item => [item.sellerAccountId, item.profitDate.toISOString().slice(0, 10)])).toEqual([
      ['s1', '2026-10-01'],
      ['s2', '2026-09-03'],
    ])
    const not = tx.profitDaily.deleteMany.mock.calls[0]![0].where.NOT as Array<{ sellerAccountId: string; profitDate: { gte: Date; lte: Date } }>
    expect(not).toHaveLength(1)
    expect(not[0]!.sellerAccountId).toBe('s1')
    expect(not[0]!.profitDate.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(not[0]!.profitDate.lte.toISOString()).toBe('2026-09-30T00:00:00.000Z')
  })

  it('冻结范围全部覆盖时一行也不写', async () => {
    const { db, tx } = fakeDb([{ sellerAccountId: 's1', periodStart: '2026-09-01', periodEnd: '2026-09-30' }])
    expect(await writeProfit(db as never, 't1', { from: '2026-09-10', to: '2026-09-12' }, [row('s1', '2026-09-11')], NOW)).toBe(0)
    expect(tx.profitDaily.createMany).not.toHaveBeenCalled()
  })

  it('冻结判断：边界日含首尾', async () => {
    const spans = await frozenSpans(fakeDb([{ sellerAccountId: 's1', periodStart: '2026-09-01', periodEnd: '2026-09-30' }]).tx as never, 't1', RANGE)
    expect(spans).toEqual([{ sellerAccountId: 's1', from: '2026-09-01', to: '2026-09-30' }])
    expect(isFrozen(spans, 's1', '2026-09-01')).toBe(true)
    expect(isFrozen(spans, 's1', '2026-09-30')).toBe(true)
    expect(isFrozen(spans, 's1', '2026-10-01')).toBe(false)
    expect(isFrozen(spans, 's2', '2026-09-15')).toBe(false)
  })
})
