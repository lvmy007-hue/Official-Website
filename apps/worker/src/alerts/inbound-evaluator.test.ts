import { describe, expect, it, vi } from 'vitest'
import { buildDiscrepancyHits, inboundDiscrepancyEvaluator, type DiscrepancyRow } from './inbound-evaluator'

// 入仓差异预警（P2a-15）：按货件合并，最早发现的排前面。

const row = (over: Partial<DiscrepancyRow> = {}): DiscrepancyRow => ({
  sellerAccountId: 's1',
  shipmentRef: 'FBA15AAA',
  sku: 'A',
  kind: 'SHORT',
  qty: 3,
  problemType: null,
  firstSeenAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
})
const names = new Map([['s1', '一店']])

describe('按货件合并', () => {
  it('同一货件的多个 SKU、少收与不合规合并成一个命中，写明少收件数、不合规类别与涉及 SKU', () => {
    const hits = buildDiscrepancyHits(
      [
        row(),
        row({ sku: 'B', qty: 2 }),
        row({ sku: 'C', kind: 'OVER', qty: 1 }),
        row({ sku: 'A', kind: 'NONCOMPLIANCE', qty: null, problemType: 'LABEL' }),
        row({ sku: 'B', kind: 'NONCOMPLIANCE', qty: null, problemType: null }),
      ],
      names,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'INBOUND_SHIPMENT', entityId: 'FBA15AAA', sellerAccountId: 's1', entityLabel: 'FBA15AAA（一店）' })
    expect(hits[0].title).toBe('货件 FBA15AAA 入仓差异：少收 5 件，多收 1 件，不合规 2 类')
    expect(hits[0].evidence).toMatchObject({ shortUnits: 5, overUnits: 1, noncomplianceTypes: ['LABEL', '未注明类型'], skuCount: 3, skus: ['A', 'B', 'C'], firstSeenAt: '2026-09-01T00:00:00.000Z' })
    expect(hits[0].suggestedAction).toContain('申请赔付')
    expect(hits[0].impact).toBeUndefined() // 没有可靠的金额依据，不写影响金额
  })

  it('不同货件各一个命中，最早发现的排前面；只有多收时的建议不提赔付', () => {
    const hits = buildDiscrepancyHits([row({ shipmentRef: 'NEW', firstSeenAt: new Date('2026-10-01T00:00:00Z') }), row({ shipmentRef: 'OLD', kind: 'OVER', qty: 2 })], names)
    expect(hits.map(hit => hit.entityId)).toEqual(['OLD', 'NEW'])
    expect(hits[0].suggestedAction).not.toContain('赔付')
  })

  it('同编号货件在不同店铺不混在一起', () => {
    expect(buildDiscrepancyHits([row(), row({ sellerAccountId: 's2' })], names)).toHaveLength(2)
  })
})

describe('读取', () => {
  const makeDb = (rows: DiscrepancyRow[]) => ({
    receivingDiscrepancy: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => rows) },
    sellerAccount: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [{ id: 's1', displayName: '一店' }]) },
  })
  const rule = (params: Record<string, unknown>, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'X',
    domain: 'INVENTORY',
    name: 'n',
    severity: 'WARNING',
    cooldownMinutes: 60,
    currentVersion: 1,
    condition: { type: 'inbound.discrepancy', params },
    scope,
  })
  const now = new Date('2026-10-22T00:00:00Z')

  it('只读未消除的差异；差异类别与范围写进查询条件；类别被改坏回到全部类别', async () => {
    const db = makeDb([row()])
    const hits = await inboundDiscrepancyEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ kinds: ['SHORT'] }, { sellerAccountIds: ['s1'], skus: ['A'] }), now })
    expect(hits).toHaveLength(1)
    expect(db.receivingDiscrepancy.findMany.mock.calls[0][0].where).toEqual({ tenantId: 't1', resolvedAt: null, kind: { in: ['SHORT'] }, sellerAccountId: { in: ['s1'] }, sku: { in: ['A'] } })
    await inboundDiscrepancyEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ kinds: ['BOGUS'] }), now })
    expect(db.receivingDiscrepancy.findMany.mock.calls[1][0].where).toEqual({ tenantId: 't1', resolvedAt: null, kind: { in: ['SHORT', 'OVER', 'NONCOMPLIANCE'] } })
  })

  it('没有未消除的差异：不再查店铺，返回空（已有预警随之自动恢复）', async () => {
    const db = makeDb([])
    expect(await inboundDiscrepancyEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({}), now })).toEqual([])
    expect(db.sellerAccount.findMany).not.toHaveBeenCalled()
  })
})
