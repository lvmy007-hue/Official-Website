import { describe, expect, it, vi } from 'vitest'
import { adsOutOfBudgetEvaluator } from './ads-budget-evaluator'
import { adsCpcSurgeEvaluator, cpcSurgeOf } from './ads-cpc-evaluator'
import { adsLowReturnEvaluator, lowReturnRows, type CampaignWindowRow } from './ads-low-return-evaluator'
import { adsStockoutEvaluator, stockoutAsins } from './ads-stockout-evaluator'

// 广告预警（P3-18）：四个评估器的纯函数判断与带模拟数据库的评估流程。真实库的整条链路见 apps/api/src/testing/alerts-ads.db.test.ts。

const now = new Date('2026-10-24T08:00:00Z')
const rule = (type: string, params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
  id: 'r',
  code: 'X',
  domain: 'ADS',
  name: 'n',
  severity: 'WARNING',
  cooldownMinutes: 1,
  currentVersion: 1,
  condition: { type, params },
  scope,
})
const dec = (value: number | null) => (value === null ? null : { toString: () => String(value) })

describe('高花费低产出：lowReturnRows', () => {
  const limits = { minSpend: 50, minClicks: 20, acosThreshold: 1 }
  const row = (over: Partial<CampaignWindowRow> = {}): CampaignWindowRow => ({
    adsProfileId: 'p1',
    adProduct: 'SPONSORED_PRODUCTS',
    campaignId: 'c1',
    spend: 100,
    clicks: 50,
    orders: 0,
    sales: 0,
    ...over,
  })

  it('没有销售额也没有订单算无产出；成本销售比达到阈值（含等于）算低产出；高花费排前面', () => {
    const out = lowReturnRows(
      [
        row({ campaignId: 'none', spend: 80 }),
        row({ campaignId: 'eq', spend: 100, orders: 3, sales: 100 }),
        row({ campaignId: 'big', spend: 300, orders: 2, sales: 150 }),
        row({ campaignId: 'good', spend: 100, orders: 5, sales: 400 }),
      ],
      limits,
    )
    expect(out.map(item => [item.row.campaignId, item.kind])).toEqual([
      ['big', 'HIGH_ACOS'],
      ['eq', 'HIGH_ACOS'],
      ['none', 'NO_SALES'],
    ])
    expect(out[0].acos).toBe(2)
    expect(out[2].acos).toBeNull()
  })

  it('花费或点击不够不判断；销售额没数据（空）不判断，不当 0；销售额为 0 但有订单的矛盾数据不判断', () => {
    expect(lowReturnRows([row({ spend: 49.99 })], limits)).toEqual([])
    expect(lowReturnRows([row({ clicks: 19 })], limits)).toEqual([])
    expect(lowReturnRows([row({ sales: null })], limits)).toEqual([])
    expect(lowReturnRows([row({ sales: 0, orders: 2 })], limits)).toEqual([])
  })
})

describe('高花费低产出：评估器', () => {
  const makeDb = (over: Record<string, unknown> = {}) => ({
    adsDailySummary: {
      groupBy: vi.fn(async (_args: { where: Record<string, any>; having: Record<string, any> }) => [
        { adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c1', _sum: { spend: dec(120), sales: dec(0), clicks: 80, orders: 0 } },
        { adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c2', _sum: { spend: dec(90), sales: dec(300), clicks: 60, orders: 9 } },
        { adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c3', _sum: { spend: dec(200), sales: dec(100), clicks: 90, orders: 4 } },
        { adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c4', _sum: { spend: dec(70), sales: null, clicks: 40, orders: 0 } },
      ]),
    },
    adsCampaign: { findMany: vi.fn(async () => [{ id: 'camp-1', adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', externalCampaignId: 'c1', name: '品牌词活动' }]) },
    adsProfile: { findMany: vi.fn(async () => [{ id: 'p1', sellerAccountId: 's1' }]) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
    ...over,
  })

  it('命中：无销售额的与成本销售比过高的；有记录的链到活动详情，没记录的按 档案|产品|编号 登记；不给影响金额；销售额空的不报', async () => {
    const db = makeDb()
    const hits = await adsLowReturnEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.high-spend-low-return'), now })
    expect(hits.map(hit => hit.entityId)).toEqual(['p1|SPONSORED_PRODUCTS|c3', 'camp-1'])
    expect(hits[1]).toMatchObject({ entityType: 'CAMPAIGN', sellerAccountId: 's1', entityLabel: '品牌词活动（一店）' })
    expect(hits[0]).toMatchObject({ entityType: 'ADS_CAMPAIGN', entityLabel: '活动 c3（一店）' })
    expect(hits[1].title).toBe('广告活动“品牌词活动”近 7 天花费 USD 120、点击 80 次，没有广告销售额')
    expect(hits[0].title).toContain('广告成本销售比 200%')
    expect(hits[0].evidence).toMatchObject({ kind: 'HIGH_ACOS', spend: 200, sales: 100, acos: 2, range: '2026-10-17 至 2026-10-23' })
    expect(hits[1].evidence).toMatchObject({ kind: 'NO_SALES', sales: 0, acos: null })
    expect(hits.every(hit => hit.impact === undefined)).toBe(true)
  })

  it('窗口到昨天为止、只看美元活动级汇总；店铺范围经广告档案过滤；阈值夹在范围内并写进查询的 having', async () => {
    const db = makeDb()
    await adsLowReturnEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.high-spend-low-return', { windowDays: 9999, minSpend: 0 }, { sellerAccountIds: ['s1'] }), now })
    const args = db.adsDailySummary.groupBy.mock.calls[0][0]
    expect(args.where).toMatchObject({ tenantId: 't1', currency: 'USD', campaignId: { not: '' }, adsProfile: { sellerAccountId: { in: ['s1'] } } })
    expect(args.where.summaryDate.gte.toISOString().slice(0, 10)).toBe('2026-08-25')
    expect(args.where.summaryDate.lte.toISOString().slice(0, 10)).toBe('2026-10-23')
    expect(args.having).toEqual({ spend: { _sum: { gte: 0.01 } } })
  })

  it('没有候选时不再查活动、档案与店铺', async () => {
    const db = makeDb({ adsDailySummary: { groupBy: vi.fn(async () => []) } })
    expect(await adsLowReturnEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.high-spend-low-return'), now })).toEqual([])
    expect(db.adsCampaign.findMany).not.toHaveBeenCalled()
    expect(db.adsProfile.findMany).not.toHaveBeenCalled()
  })
})

describe('单次点击成本突增：cpcSurgeOf', () => {
  const limits = { ratio: 1.5, minClicks: 30, minBaselineClicks: 100 }

  it('最近成本不低于基线的指定倍数（含等于）才算；多花的钱 =（最近成本 - 基线成本）× 最近点击', () => {
    const out = cpcSurgeOf({ spend: 90, clicks: 60 }, { spend: 100, clicks: 100 }, limits)
    expect(out).toMatchObject({ recentCpc: 1.5, baselineCpc: 1, ratio: 1.5 })
    expect(out?.extraSpend).toBeCloseTo(30)
    expect(cpcSurgeOf({ spend: 89, clicks: 60 }, { spend: 100, clicks: 100 }, limits)).toBeNull()
  })

  it('没有基线、样本不够、花费没数据或为 0（算不出成本）都不判断', () => {
    expect(cpcSurgeOf({ spend: 90, clicks: 60 }, undefined, limits)).toBeNull()
    expect(cpcSurgeOf({ spend: 90, clicks: 29 }, { spend: 100, clicks: 100 }, limits)).toBeNull()
    expect(cpcSurgeOf({ spend: 90, clicks: 60 }, { spend: 100, clicks: 99 }, limits)).toBeNull()
    expect(cpcSurgeOf({ spend: null, clicks: 60 }, { spend: 100, clicks: 100 }, limits)).toBeNull()
    expect(cpcSurgeOf({ spend: 90, clicks: 60 }, { spend: null, clicks: 100 }, limits)).toBeNull()
    expect(cpcSurgeOf({ spend: 90, clicks: 60 }, { spend: 0, clicks: 100 }, limits)).toBeNull()
  })
})

describe('单次点击成本突增：评估器', () => {
  const group = (campaignId: string, spend: number, clicks: number, profile = 'p1') => ({ adsProfileId: profile, adProduct: 'SPONSORED_PRODUCTS', campaignId, _sum: { spend: dec(spend), clicks } })
  const makeDb = () => ({
    adsDailySummary: {
      groupBy: vi.fn(async (args: { where: Record<string, any> }) =>
        args.where.adsProfileId ? [group('c1', 100, 100), group('c2', 100, 100), group('c3', 50, 40)] : [group('c1', 90, 60), group('c2', 60, 60), group('c3', 40, 40), group('c9', 80, 50)],
      ),
    },
    adsCampaign: { findMany: vi.fn(async () => [{ id: 'camp-1', adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', externalCampaignId: 'c1', name: '自动活动' }]) },
    adsProfile: { findMany: vi.fn(async () => [{ id: 'p1', sellerAccountId: null }]) },
    sellerAccount: { findMany: vi.fn(async () => []) },
  })

  it('命中：成本涨到基线 1.5 倍的活动；c2 没涨、c3 基线点击不够、c9 没有基线都不报；影响金额是多花的钱；档案没绑店铺则不带店铺', async () => {
    const db = makeDb()
    const hits = await adsCpcSurgeEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.cpc-surge'), now })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'CAMPAIGN', entityId: 'camp-1', sellerAccountId: null, entityLabel: '自动活动' })
    expect(hits[0].title).toBe('广告活动“自动活动”近 3 天单次点击成本 USD 1.5，是此前 14 天（1）的 1.5 倍')
    expect(hits[0].evidence).toMatchObject({
      recentCpc: 1.5,
      baselineCpc: 1,
      ratio: 1.5,
      recentClicks: 60,
      baselineClicks: 100,
      extraSpend: 30,
      recentRange: '2026-10-21 至 2026-10-23',
      baselineRange: '2026-10-07 至 2026-10-20',
    })
    expect(hits[0].impact).toEqual({ min: 30, max: 30, currency: 'USD' })
  })

  it('最近期到昨天为止、基线期紧接其前；基线只查最近期出现的档案与活动；店铺范围经档案过滤；没有候选时不查基线', async () => {
    const db = makeDb()
    await adsCpcSurgeEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.cpc-surge', {}, { sellerAccountIds: ['s1'] }), now })
    const [recent, baseline] = db.adsDailySummary.groupBy.mock.calls.map(call => call[0] as { where: Record<string, any> })
    expect(recent.where.summaryDate.gte.toISOString().slice(0, 10)).toBe('2026-10-21')
    expect(recent.where.summaryDate.lte.toISOString().slice(0, 10)).toBe('2026-10-23')
    expect(recent.where).toMatchObject({ currency: 'USD', adsProfile: { sellerAccountId: { in: ['s1'] } } })
    expect(baseline.where.summaryDate.gte.toISOString().slice(0, 10)).toBe('2026-10-07')
    expect(baseline.where.summaryDate.lt.toISOString().slice(0, 10)).toBe('2026-10-21')
    expect(baseline.where.campaignId).toEqual({ in: ['c1', 'c2', 'c3', 'c9'] })
    const empty = { ...makeDb(), adsDailySummary: { groupBy: vi.fn(async () => []) } }
    expect(await adsCpcSurgeEvaluator.evaluate({ db: empty as never, tenantId: 't1', rule: rule('ads.cpc-surge'), now })).toEqual([])
    expect(empty.adsDailySummary.groupBy).toHaveBeenCalledTimes(1)
  })
})

describe('断货商品仍在投放：stockoutAsins', () => {
  const storeOf = new Map<string, string | null>([
    ['p1', 's1'],
    ['p2', null],
  ])
  const spend = (asin: string, date: string, amount: number, profile = 'p1') => ({ adsProfileId: profile, asin, date, spend: amount })
  const snap = (asin: string, sellable: number | null, snapshotDate = '2026-10-23', sellerAccountId = 's1') => ({ sellerAccountId, asin, sellable, snapshotDate })
  const base = { storeOf, minSpend: 5, oldestSnapshot: '2026-10-21' }

  it('可售合计为 0 且回看期有花费：日均花费 = 花费 ÷ 有花费的天数；多个 SKU 的可售相加；日均高的排前面', () => {
    const out = stockoutAsins({
      ...base,
      spend: [spend('A', '2026-10-22', 10), spend('A', '2026-10-23', 20), spend('B', '2026-10-23', 40)],
      snapshots: [snap('A', 0), snap('A', 0), snap('B', 0)],
    })
    expect(out.map(item => [item.asin, item.spend, item.days, item.dailyWaste])).toEqual([
      ['B', 40, 1, 40],
      ['A', 30, 2, 15],
    ])
    const summed = stockoutAsins({ ...base, spend: [spend('A', '2026-10-23', 10)], snapshots: [snap('A', 0), snap('A', 3)] })
    expect(summed).toEqual([])
  })

  it('不算：有库存、没有快照、可售没给（空）、快照太旧、花费不到下限、档案没绑店铺', () => {
    const cases = [
      { spend: [spend('A', '2026-10-23', 10)], snapshots: [snap('A', 1)] },
      { spend: [spend('A', '2026-10-23', 10)], snapshots: [] },
      { spend: [spend('A', '2026-10-23', 10)], snapshots: [snap('A', null)] },
      { spend: [spend('A', '2026-10-23', 10)], snapshots: [snap('A', 0, '2026-10-20')] },
      { spend: [spend('A', '2026-10-23', 4.99)], snapshots: [snap('A', 0)] },
      { spend: [spend('A', '2026-10-23', 10, 'p2')], snapshots: [snap('A', 0)] },
      { spend: [spend('', '2026-10-23', 10)], snapshots: [snap('', 0)] },
    ]
    for (const item of cases) expect(stockoutAsins({ ...base, ...item })).toEqual([])
  })

  it('快照日期恰好等于最长天数边界算有效', () => {
    expect(stockoutAsins({ ...base, spend: [spend('A', '2026-10-23', 10)], snapshots: [snap('A', 0, '2026-10-21')] })).toHaveLength(1)
  })
})

describe('断货商品仍在投放：评估器', () => {
  const makeDb = (over: Record<string, unknown> = {}) => ({
    adsAdvertisedProductMetric: {
      groupBy: vi.fn(async (_args: { where: Record<string, any> }) => [
        { adsProfileId: 'p1', advertisedAsin: 'B0A', reportDate: new Date('2026-10-23'), _sum: { spend: dec(12) } },
        { adsProfileId: 'p1', advertisedAsin: 'B0A', reportDate: new Date('2026-10-24'), _sum: { spend: dec(6) } },
        { adsProfileId: 'p1', advertisedAsin: 'B0B', reportDate: new Date('2026-10-24'), _sum: { spend: dec(30) } },
      ]),
    },
    adsProfile: { findMany: vi.fn(async () => [{ id: 'p1', sellerAccountId: 's1' }]) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
    inventoryDailySnapshot: {
      groupBy: vi.fn(async () => [{ sellerAccountId: 's1', _max: { snapshotDate: new Date('2026-10-24') } }]),
      findMany: vi.fn(async (_args: { where: Record<string, any> }) => [
        { sellerAccountId: 's1', asin: 'B0A', sellable: 0, snapshotDate: new Date('2026-10-24') },
        { sellerAccountId: 's1', asin: 'B0B', sellable: 50, snapshotDate: new Date('2026-10-24') },
      ]),
    },
    fbaProduct: { findMany: vi.fn(async (_args: { where: Record<string, any> }) => [{ id: 'prod-A', sellerAccountId: 's1', asin: 'B0A', title: '示例商品' }]) },
    ...over,
  })

  it('命中：断货且仍在花钱的 ASIN（B0B 有库存不报）；链到商品全景；影响金额是日均花费；证据带库存与快照日期', async () => {
    const db = makeDb()
    const hits = await adsStockoutEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.stockout-advertising'), now })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'ASIN', entityId: 'prod-A', sellerAccountId: 's1', entityLabel: 'B0A（一店）' })
    expect(hits[0].title).toBe('ASIN B0A 可售库存为 0，近 3 天广告仍在花钱（日均 USD 9）')
    expect(hits[0].evidence).toMatchObject({ asin: 'B0A', title: '示例商品', spend: 18, spendDays: 2, dailyWaste: 9, sellable: 0, snapshotDate: '2026-10-24', lookbackDays: 3 })
    expect(hits[0].impact).toEqual({ min: 9, max: 9, currency: 'USD' })
    const where = db.adsAdvertisedProductMetric.groupBy.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 't1', currency: 'USD', spend: { gt: 0 } })
    expect(where.reportDate.gte.toISOString().slice(0, 10)).toBe('2026-10-22')
    expect(where.reportDate.lte.toISOString().slice(0, 10)).toBe('2026-10-24')
    expect(db.inventoryDailySnapshot.findMany.mock.calls[0][0].where).toMatchObject({ source: 'API', asin: { in: ['B0A', 'B0B'] } })
  })

  it('没有商品记录时按店铺 × ASIN 登记；SKU 与店铺范围换成 ASIN 与档案条件', async () => {
    const db = makeDb({ fbaProduct: { findMany: vi.fn(async (args: { where: Record<string, any> }) => (args.where.sellerSku ? [{ asin: 'B0A' }] : [])) } })
    const hits = await adsStockoutEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.stockout-advertising', {}, { sellerAccountIds: ['s1'], skus: ['SKU-A'] }), now })
    expect(hits[0]).toMatchObject({ entityType: 'ADS_ASIN', entityId: 's1|B0A' })
    expect(db.fbaProduct.findMany.mock.calls[0][0].where).toMatchObject({ sellerSku: { in: ['SKU-A'] }, sellerAccountId: { in: ['s1'] } })
    expect(db.adsAdvertisedProductMetric.groupBy.mock.calls[0][0].where).toMatchObject({ advertisedAsin: { in: ['B0A'] }, adsProfile: { sellerAccountId: { in: ['s1'] } } })
  })

  it('没有花费、没有绑定店铺的档案、没有库存快照时直接返回空，不再往下查', async () => {
    const noSpend = makeDb({ adsAdvertisedProductMetric: { groupBy: vi.fn(async () => []) } })
    expect(await adsStockoutEvaluator.evaluate({ db: noSpend as never, tenantId: 't1', rule: rule('ads.stockout-advertising'), now })).toEqual([])
    expect(noSpend.adsProfile.findMany).not.toHaveBeenCalled()
    const unbound = makeDb({ adsProfile: { findMany: vi.fn(async () => [{ id: 'p1', sellerAccountId: null }]) } })
    expect(await adsStockoutEvaluator.evaluate({ db: unbound as never, tenantId: 't1', rule: rule('ads.stockout-advertising'), now })).toEqual([])
    expect(unbound.inventoryDailySnapshot.groupBy).not.toHaveBeenCalled()
    const noSnapshot = makeDb({ inventoryDailySnapshot: { groupBy: vi.fn(async () => []), findMany: vi.fn() } })
    expect(await adsStockoutEvaluator.evaluate({ db: noSnapshot as never, tenantId: 't1', rule: rule('ads.stockout-advertising'), now })).toEqual([])
    expect(noSnapshot.inventoryDailySnapshot.findMany).not.toHaveBeenCalled()
  })

  it('快照最长天数可调：快照早于边界就不报', async () => {
    const stale = makeDb({
      inventoryDailySnapshot: {
        groupBy: vi.fn(async () => [{ sellerAccountId: 's1', _max: { snapshotDate: new Date('2026-10-20') } }]),
        findMany: vi.fn(async () => [{ sellerAccountId: 's1', asin: 'B0A', sellable: 0, snapshotDate: new Date('2026-10-20') }]),
      },
    })
    expect(await adsStockoutEvaluator.evaluate({ db: stale as never, tenantId: 't1', rule: rule('ads.stockout-advertising'), now })).toEqual([])
    expect(await adsStockoutEvaluator.evaluate({ db: stale as never, tenantId: 't1', rule: rule('ads.stockout-advertising', { maxSnapshotAgeDays: 30 }), now })).toHaveLength(1)
  })
})

describe('超预算：评估器', () => {
  const campaign = (id: string, servingStatus: string | null, over: Record<string, unknown> = {}) => ({
    id,
    name: `活动${id}`,
    adProduct: 'SPONSORED_PRODUCTS',
    servingStatus,
    budget: dec(20),
    budgetType: 'DAILY',
    currency: 'USD',
    sourceUpdatedAt: new Date('2026-10-24T01:00:00Z'),
    adsProfile: { sellerAccountId: 's1', sellerAccount: { displayName: '一店' } },
    ...over,
  })

  it('命中：投放状态带预算用完（不分大小写、子串）的启用中活动；链到活动详情；不给影响金额', async () => {
    const db = {
      adsCampaign: {
        findMany: vi.fn(async (_args: { where: Record<string, any> }) => [
          campaign('a', 'CAMPAIGN_OUT_OF_BUDGET'),
          campaign('b', 'campaign_out_of_budget', { adsProfile: { sellerAccountId: null, sellerAccount: null }, budget: null }),
        ]),
      },
    }
    const hits = await adsOutOfBudgetEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.out-of-budget'), now })
    expect(hits.map(hit => [hit.entityType, hit.entityId, hit.sellerAccountId])).toEqual([
      ['CAMPAIGN', 'a', 's1'],
      ['CAMPAIGN', 'b', null],
    ])
    expect(hits[0]).toMatchObject({ entityLabel: '活动a（一店）', title: '广告活动“活动a”预算已用完（投放状态 CAMPAIGN_OUT_OF_BUDGET）' })
    expect(hits[0].evidence).toMatchObject({ budget: 20, budgetType: 'DAILY', currency: 'USD', statusUpdatedAt: '2026-10-24T01:00:00.000Z' })
    expect(hits[1].entityLabel).toBe('活动b')
    expect(hits[1].evidence).toMatchObject({ budget: null })
    expect(hits.every(hit => hit.impact === undefined)).toBe(true)
    expect(db.adsCampaign.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 't1',
      state: { equals: 'ENABLED', mode: 'insensitive' },
      servingStatus: { contains: 'OUT_OF_BUDGET', mode: 'insensitive' },
    })
  })

  it('店铺范围经广告档案过滤；读到的状态不含预算用完时（防御）不报；没有记录返回空', async () => {
    const db = { adsCampaign: { findMany: vi.fn(async (_args: { where: Record<string, any> }) => [campaign('c', 'RUNNING'), campaign('d', null)]) } }
    expect(await adsOutOfBudgetEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('ads.out-of-budget', {}, { sellerAccountIds: ['s1'] }), now })).toEqual([])
    expect(db.adsCampaign.findMany.mock.calls[0][0].where).toMatchObject({ adsProfile: { sellerAccountId: { in: ['s1'] } } })
    const empty = { adsCampaign: { findMany: vi.fn(async () => []) } }
    expect(await adsOutOfBudgetEvaluator.evaluate({ db: empty as never, tenantId: 't1', rule: rule('ads.out-of-budget'), now })).toEqual([])
  })
})
