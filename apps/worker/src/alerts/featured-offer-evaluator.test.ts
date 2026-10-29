import { describe, expect, it, vi } from 'vitest'
import { featuredLosses, featuredOfferLostEvaluator, type BoxRow } from './featured-offer-evaluator'

// 失去推荐报价资格预警（P4-15）：获得 → 失去才算、重新获得后恢复、价格健康通知明确失去算一次失去、因价格失去的归价格健康、窗口之外不报、没有此前观察不猜。

const at = (day: string, hour = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`)
const box = (day: string, own: boolean, over: Partial<BoxRow> = {}): BoxRow => ({
  sellerAccountId: 's1',
  asin: 'B0A',
  ownIsFeatured: own,
  lostReason: null,
  source: 'SYNC',
  observedAt: at(day),
  ...over,
})
const since = at('2026-10-18')

describe('featuredLosses', () => {
  it('获得之后出现失去、现在仍是失去：命中，失去时间是第一次失去的观察，带上最近一次获得的时间；输入顺序无关', () => {
    const rows = [box('2026-10-23', false), box('2026-10-20', true), box('2026-10-24', false), box('2026-10-10', true)]
    const out = featuredLosses(rows, since)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ asin: 'B0A', lostAt: at('2026-10-23'), lastFeaturedAt: at('2026-10-20'), lostReason: null, source: 'SYNC' })
  })

  it('重新获得后恢复；又失去则以新的失去时间为准', () => {
    expect(featuredLosses([box('2026-10-19', true), box('2026-10-20', false), box('2026-10-22', true)], since)).toEqual([])
    const again = featuredLosses([box('2026-10-19', true), box('2026-10-20', false), box('2026-10-22', true), box('2026-10-24', false)], since)
    expect(again[0].lostAt).toEqual(at('2026-10-24'))
  })

  it('失去时间早于窗口不报；窗口内第一次观察就是失去而此前没有任何观察，不猜之前是否获得过', () => {
    expect(featuredLosses([box('2026-10-01', true), box('2026-10-05', false)], since)).toEqual([])
    expect(featuredLosses([box('2026-10-22', false), box('2026-10-23', false)], since)).toEqual([])
  })

  it('价格健康通知明确标了失去原因的行本身算一次失去（没有此前观察也算）；原因是价格的归价格健康预警，不在这里报', () => {
    const other = featuredLosses([box('2026-10-22', false, { lostReason: 'OTHER', source: 'PUSH_PRICING_HEALTH' })], since)
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({ lostReason: 'OTHER', source: 'PUSH_PRICING_HEALTH', lastFeaturedAt: null })
    expect(featuredLosses([box('2026-10-20', true), box('2026-10-22', false, { lostReason: 'PRICE', source: 'PUSH_PRICING_HEALTH' })], since)).toEqual([])
    expect(featuredLosses([box('2026-10-20', true), box('2026-10-21', false), box('2026-10-22', false, { lostReason: 'PRICE' })], since)).toEqual([])
  })

  it('不同店铺、不同 ASIN 各算各的；失去晚的排前面', () => {
    const rows = [
      box('2026-10-19', true),
      box('2026-10-20', false),
      box('2026-10-19', true, { asin: 'B0B' }),
      box('2026-10-23', false, { asin: 'B0B' }),
      box('2026-10-19', true, { sellerAccountId: 's2' }),
    ]
    expect(featuredLosses(rows, since).map(item => item.asin)).toEqual(['B0B', 'B0A'])
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'PRD_FEATURED_OFFER_LOST',
    domain: 'PRODUCT',
    name: '失去推荐报价资格',
    severity: 'WARNING',
    cooldownMinutes: 4320,
    currentVersion: 1,
    condition: { type: 'pricing.featured-offer-lost', params },
    scope,
  })
  const now = new Date('2026-10-25T08:00:00Z')
  const makeDb = (rows: BoxRow[], products: Array<Record<string, unknown>> = [{ id: 'prod-A', sellerAccountId: 's1', sellerSku: 'SKU-A', asin: 'B0A', title: '示例商品' }]) => ({
    buyBoxSnapshot: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => rows) },
    fbaProduct: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => products) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
  })

  it('命中：读回看天数加 30 天的有明确状态的观察；链到商品全景；证据带失去与最近获得时间', async () => {
    const db = makeDb([box('2026-10-20', true), box('2026-10-23', false)])
    const hits = await featuredOfferLostEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    const where = db.buyBoxSnapshot.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toMatchObject({ tenantId: 't1', ownIsFeatured: { not: null } })
    expect((where.observedAt as { gte: Date }).gte.toISOString()).toBe('2026-09-18T08:00:00.000Z')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'ASIN', entityId: 'prod-A', sellerAccountId: 's1', entityLabel: 'B0A（一店）' })
    expect(hits[0].title).toBe('ASIN B0A 失去推荐报价（购物车），自 2026-10-23 起')
    expect(hits[0].evidence).toMatchObject({ asin: 'B0A', title: '示例商品', lookbackDays: 7, lostAt: '2026-10-23T00:00:00.000Z', lastFeaturedAt: '2026-10-20T00:00:00.000Z', lostReason: null })
  })

  it('回看天数夹在 1 到 30；没有商品记录按店铺|ASIN 登记；店铺范围写进查询', async () => {
    const db = makeDb([box('2026-10-24', true, { observedAt: at('2026-10-24', 1) }), box('2026-10-24', false, { observedAt: at('2026-10-24', 3) })], [])
    const hits = await featuredOfferLostEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ lookbackDays: 999 }, { sellerAccountIds: ['s1'] }), now })
    const where = db.buyBoxSnapshot.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect((where.observedAt as { gte: Date }).gte.toISOString()).toBe('2026-08-26T08:00:00.000Z')
    expect(where).toMatchObject({ sellerAccountId: { in: ['s1'] } })
    expect(hits[0]).toMatchObject({ entityType: 'PRICING_ASIN', entityId: 's1|B0A' })
  })

  it('SKU 范围换成 ASIN：没有对应商品时不查观察；有则按 ASIN 查', async () => {
    const none = makeDb([], [])
    expect(await featuredOfferLostEvaluator.evaluate({ db: none as never, tenantId: 't1', rule: rule({}, { skus: ['NOPE'] }), now })).toEqual([])
    expect(none.buyBoxSnapshot.findMany).not.toHaveBeenCalled()
    const some = makeDb([], [{ asin: 'B0A' }])
    await featuredOfferLostEvaluator.evaluate({ db: some as never, tenantId: 't1', rule: rule({}, { skus: ['SKU-A'] }), now })
    expect(some.buyBoxSnapshot.findMany.mock.calls[0][0].where).toMatchObject({ asin: { in: ['B0A'] } })
  })
})
