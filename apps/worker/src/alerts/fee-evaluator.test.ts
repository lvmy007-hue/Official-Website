import { describe, expect, it, vi } from 'vitest'
import { latestChanges, sizeTierChangeEvaluator, type TierChangeRow } from './fee-evaluator'

// 尺寸分段变化预警（P2b-06）：只认真变化（忽略大小写与标点）、每个 SKU 只留最近一次、窗口与范围写进查询、链接到商品全景。

const row = (over: Partial<TierChangeRow> = {}): TierChangeRow => ({
  sellerAccountId: 's1',
  sku: 'SKU-1',
  asin: 'B0TEST0001',
  snapshotDate: new Date('2026-10-22T00:00:00Z'),
  sizeTier: 'Large Standard',
  prevSizeTier: 'Small Standard',
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  ...over,
})

describe('latestChanges', () => {
  it('只留真变化；同一店铺同一 SKU 只留最近一次；新的排前面', () => {
    const out = latestChanges([
      row({ sku: 'A', snapshotDate: new Date('2026-10-20T00:00:00Z') }),
      row({ sku: 'A', snapshotDate: new Date('2026-10-22T00:00:00Z') }),
      row({ sku: 'B', prevSizeTier: 'large-standard' }),
      row({ sku: 'C', prevSizeTier: null }),
      row({ sku: 'D', snapshotDate: new Date('2026-10-21T00:00:00Z') }),
      row({ sku: 'A', sellerAccountId: 's2', snapshotDate: new Date('2026-10-19T00:00:00Z') }),
    ])
    expect(out.map(item => `${item.sellerAccountId}|${item.sku}|${item.snapshotDate.toISOString().slice(0, 10)}`)).toEqual(['s1|A|2026-10-22', 's1|D|2026-10-21', 's2|A|2026-10-19'])
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'FEE_SIZE_TIER_CHANGE',
    domain: 'FINANCE',
    name: '尺寸分段变化',
    severity: 'WARNING',
    cooldownMinutes: 10_080,
    currentVersion: 1,
    condition: { type: 'fee.size-tier-change', params },
    scope,
  })
  const now = new Date('2026-10-23T08:00:00Z')
  const makeDb = (rows: TierChangeRow[], products: Array<{ id: string; sellerAccountId: string; sellerSku: string }> = []) => ({
    feeBaseline: { findMany: vi.fn(async (_args: { where: Record<string, any> }) => rows) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
    fbaProduct: { findMany: vi.fn(async () => products) },
  })

  it('命中：有商品记录时链到 ASIN 全景，没有时按 SKU；证据写明前后分段、变化日期与测量尺寸', async () => {
    const db = makeDb(
      [row({ lengthCm: { toString: () => '20' }, widthCm: { toString: () => '10' }, heightCm: { toString: () => '5' } }), row({ sku: 'SKU-2' })],
      [{ id: 'prod-1', sellerAccountId: 's1', sellerSku: 'SKU-1' }],
    )
    const hits = await sizeTierChangeEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(2)
    const first = hits.find(hit => hit.entityLabel.startsWith('SKU-1'))!
    expect(first).toMatchObject({ entityType: 'ASIN', entityId: 'prod-1', sellerAccountId: 's1', entityLabel: 'SKU-1（一店）' })
    expect(first.title).toBe('SKU SKU-1 尺寸分段变化：Small Standard → Large Standard')
    expect(first.evidence).toMatchObject({ previousTier: 'Small Standard', currentTier: 'Large Standard', changedOn: '2026-10-22', measuredCm: [20, 10, 5], storeName: '一店' })
    expect(first.suggestedAction).toContain('费用核查')
    expect(hits.find(hit => hit.entityLabel.startsWith('SKU-2'))).toMatchObject({ entityType: 'SKU', entityId: 'SKU-2' })
  })

  it('窗口默认 7 天，参数限定在 1 到 30；范围写进查询条件；没有变化不查商品', async () => {
    const db = makeDb([])
    expect(await sizeTierChangeEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })).toEqual([])
    expect(db.feeBaseline.findMany.mock.calls[0][0].where.snapshotDate.gte.toISOString().slice(0, 10)).toBe('2026-10-16')
    expect(db.fbaProduct.findMany).not.toHaveBeenCalled()
    await sizeTierChangeEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ windowDays: 3 }, { sellerAccountIds: ['s1'], skus: ['SKU-1'] }), now })
    const where = db.feeBaseline.findMany.mock.calls[1][0].where
    expect(where.snapshotDate.gte.toISOString().slice(0, 10)).toBe('2026-10-20')
    expect(where).toMatchObject({ tenantId: 't1', sellerAccountId: { in: ['s1'] }, sku: { in: ['SKU-1'] } })
    await sizeTierChangeEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ windowDays: 999 }), now })
    expect(db.feeBaseline.findMany.mock.calls[2][0].where.snapshotDate.gte.toISOString().slice(0, 10)).toBe('2026-09-23')
  })
})
