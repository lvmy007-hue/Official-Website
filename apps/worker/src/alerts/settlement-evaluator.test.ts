import { describe, expect, it, vi } from 'vitest'
import { buildSettlementHits, settlementDiscrepancyEvaluator, type SettlementDiffRow } from './settlement-evaluator'

// 结算差异预警（P2b-16）：只看“有差异”的核对、差额绝对值不到阈值的不算、大额排前面、影响金额取差额绝对值、范围与回看窗口写进查询。

const row = (over: Partial<SettlementDiffRow> = {}): SettlementDiffRow => ({
  settlementId: 'st-1',
  externalSettlementId: '9001',
  sellerAccountId: 's1',
  rangeStart: new Date('2026-09-01T00:00:00Z'),
  rangeEnd: new Date('2026-09-15T00:00:00Z'),
  currency: 'USD',
  officialAmount: { toString: () => '1000.00' },
  systemAmount: { toString: () => '987.66' },
  diffAmount: { toString: () => '12.34' },
  openExceptions: 3,
  ...over,
})
const names = new Map([['s1', '一店']])

describe('buildSettlementHits', () => {
  it('差额绝对值达到阈值才算，负差额按绝对值，大的排前面', () => {
    const hits = buildSettlementHits(
      [
        row({ settlementId: 'a', externalSettlementId: 'A', diffAmount: { toString: () => '-3.50' } }),
        row({ settlementId: 'b', externalSettlementId: 'B', diffAmount: { toString: () => '0.40' } }),
        row({ settlementId: 'c', externalSettlementId: 'C', diffAmount: { toString: () => '120' } }),
      ],
      names,
      1,
    )
    expect(hits.map(hit => hit.entityId)).toEqual(['c', 'a'])
  })

  it('命中内容：实体是结算单，标题带差额，证据写明周期、两边金额与待处理异常数，影响金额等于差额绝对值', () => {
    const [hit] = buildSettlementHits([row({ diffAmount: { toString: () => '-12.3' } })], names, 1)
    expect(hit).toMatchObject({ entityType: 'SETTLEMENT', entityId: 'st-1', sellerAccountId: 's1', entityLabel: '结算单 9001（一店）' })
    expect(hit.title).toBe('结算单 9001 核对有差异：差额 USD -12.3')
    expect(hit.evidence).toMatchObject({ settlementId: '9001', period: '2026-09-01 至 2026-09-15', officialAmount: 1000, systemAmount: 987.66, diffAmount: -12.3, openExceptions: 3 })
    expect(hit.impact).toEqual({ min: 12.3, max: 12.3, currency: 'USD' })
  })

  it('零差额永远不算，哪怕阈值很小', () => {
    expect(buildSettlementHits([row({ diffAmount: { toString: () => '0' } })], names, 0.01)).toEqual([])
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'FIN_SETTLEMENT_DISCREPANCY',
    domain: 'FINANCE',
    name: '结算差异',
    severity: 'WARNING',
    cooldownMinutes: 10_080,
    currentVersion: 1,
    condition: { type: 'settlement.discrepancy', params },
    scope,
  })
  const now = new Date('2026-10-23T08:00:00Z')
  const recon = (over: Record<string, unknown> = {}) => ({
    id: 'rc-1',
    settlementId: 'st-1',
    sellerAccountId: 's1',
    rangeStart: new Date('2026-09-01T00:00:00Z'),
    rangeEnd: new Date('2026-09-15T00:00:00Z'),
    currency: 'USD',
    officialAmount: '1000',
    systemAmount: '987.66',
    diffAmount: '12.34',
    settlement: { externalSettlementId: '9001' },
    ...over,
  })
  const makeDb = (rows: Array<Record<string, unknown>>) => ({
    reconciliation: { findMany: vi.fn(async (_args: { where: Record<string, any> }) => rows) },
    reconciliationException: { groupBy: vi.fn(async () => [{ reconciliationId: 'rc-1', _count: { _all: 2 } }]) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
  })

  it('只查“有差异”的结算核对；默认回看 90 天、最小金额 1；带上待处理异常数', async () => {
    const db = makeDb([recon()])
    const hits = await settlementDiscrepancyEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(1)
    expect(hits[0].evidence).toMatchObject({ openExceptions: 2 })
    const where = db.reconciliation.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 't1', scopeKind: 'SETTLEMENT', status: 'DISCREPANCY' })
    expect(where.rangeEnd.gte.toISOString().slice(0, 10)).toBe('2026-07-25')
  })

  it('阈值与窗口夹在允许范围内；店铺范围写进查询；没有核对时不再查别的表', async () => {
    const db = makeDb([])
    expect(await settlementDiscrepancyEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ lookbackDays: 9999 }, { sellerAccountIds: ['s1'] }), now })).toEqual([])
    const where = db.reconciliation.findMany.mock.calls[0][0].where
    expect(where.rangeEnd.gte.toISOString().slice(0, 10)).toBe('2025-10-23')
    expect(where.sellerAccountId).toEqual({ in: ['s1'] })
    expect(db.reconciliationException.groupBy).not.toHaveBeenCalled()
    const filtered = makeDb([recon({ diffAmount: '0.5' })])
    expect(await settlementDiscrepancyEvaluator.evaluate({ db: filtered as never, tenantId: 't1', rule: rule({ minDiffAmount: 5 }), now })).toEqual([])
  })
})
