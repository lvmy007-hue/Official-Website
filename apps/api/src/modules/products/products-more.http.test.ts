import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { policyRow, prismaFor, record } from '../inventory/inventory-http.test-helper'

// ASIN 360 剩余页签（P4-08）：流量转化、刊登与问题、评价、定价与购物车、竞品、内容与 A+ 六个页签与建议动作区的 6 条规则。
// 覆盖：权限先于参数校验也先于读数据、商品不在数据范围内是 404、参数不合法是 422、品牌分析区块没有权限是“受限”而不是 403、
// 没有数据来源的区块一律“尚未接入”。真实库的取数与范围隔离在 apps/api/src/testing/products-more.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const day = (date: string) => new Date(`${date}T00:00:00Z`)
const dec = (value: number) => ({ toString: () => String(value) })
const RANGE = 'from=2026-10-01&to=2026-10-03'

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  asin: 'B0TEST0001',
  sellerSku: 'SKU-1',
  fnsku: 'X0TEST0001',
  title: '示例商品',
  brand: '示例品牌',
  productType: 'HOME',
  listingStatus: 'ACTIVE',
  fulfillmentChannel: 'AFN',
  price: dec(19.9),
  currency: 'USD',
  imageUrl: 'https://img.example/a.jpg',
  categoryPath: 'Home > Kitchen',
  parentAsin: 'B0PARENT01',
  variantAttributes: { color: 'Red', size: 'L' },
  catalogStatus: 'FOUND',
  catalogSyncedAt: new Date('2026-10-22T02:00:00Z'),
  sourceUpdatedAt: new Date('2026-10-22T02:00:00Z'),
  sellerAccount: { displayName: '店铺一' },
  ...over,
})

const traffic = (date: string, over: Record<string, unknown> = {}) => ({
  date: day(date),
  source: 'DATA_KIOSK',
  sessions: 100,
  pageViews: 250,
  units: 5,
  orderedSales: dec(100),
  buyBoxPct: dec(0.9),
  unitSessionPct: dec(0.05),
  ...over,
})

const counts = (own: number, total: number) => ({ own, total })
const sqp = (searchQuery: string, searchVolume: number, share = 0.5, clickShare = 0.5) => ({
  searchQuery,
  searchVolume,
  impressionsOwn: counts(50, 100).own,
  impressionsTotal: counts(50, 100).total,
  clicksOwn: Math.round(clickShare * 100),
  clicksTotal: 100,
  cartAddsOwn: 50,
  cartAddsTotal: 100,
  purchasesOwn: 50,
  purchasesTotal: 100,
  impressionShare: dec(share),
  clickShare: dec(clickShare),
  cartAddShare: dec(0.5),
  purchaseShare: dec(0.5),
})

/** 数据新鲜度行：带齐字段，以免新鲜度汇总读到缺字段的行。 */
const freshRow = (lastErrorCode: string | null, lastSuccessAt: Date | null) => ({
  sellerAccountId: 's1',
  sourceKey: 'rpt.ba.search-query',
  lastAttemptAt: new Date('2026-10-22T00:00:00Z'),
  lastSuccessAt,
  dataThrough: null,
  status: lastErrorCode ? 'ERROR' : 'NORMAL',
  lastErrorCode,
})

const TABLES = [
  'salesTrafficAsinDaily',
  'brandSearchQueryPerformance',
  'brandSearchCatalogPerformance',
  'brandSearchTerm',
  'reviewMetricSnapshot',
  'reviewTopic',
  'browseNodeReviewTrend',
  'aplusAsinRelation',
] as const

function stub(permissions: string[], over: Record<string, any> = {}) {
  const tables = Object.fromEntries(
    TABLES.map(name => [name, { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), aggregate: vi.fn().mockResolvedValue({ _max: { snapshotDate: null } }) }]),
  )
  return prismaFor(permissions, {
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    fbaProduct: { findFirst: vi.fn().mockResolvedValue(product()), findMany: vi.fn().mockResolvedValue([]) },
    ...tables,
    ...over,
  })
}

async function call(permissions: string[], path: string, over: Record<string, any> = {}) {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { res: await harness.call('GET', path), prisma }
}

const PATHS: Array<[string, string]> = [
  ['/products/p1/traffic', 'products.read'],
  ['/products/p1/listing', 'listing.read'],
  ['/products/p1/reviews', 'reviews.read'],
  ['/products/p1/pricing', 'pricing.read'],
  ['/products/p1/competitors', 'competitors.read'],
  ['/products/p1/content', 'aplus.read'],
]
const ALL = ['products.read', 'listing.read', 'reviews.read', 'pricing.read', 'competitors.read', 'aplus.read', 'analytics.brand.read']

describe('权限、范围与参数', () => {
  it('缺页签权限：403，坏参数也不会先看到 422，也不读商品与业务表', async () => {
    for (const [path, need] of PATHS) {
      const permissions = ALL.filter(item => item !== need)
      const { res, prisma } = await call(permissions, `${path}?from=bad&to=bad&period=DAY`)
      expect(res.status, path).toBe(403)
      expect(prisma.fbaProduct.findFirst, path).not.toHaveBeenCalled()
      for (const table of TABLES) expect((prisma as any)[table].findMany, `${path} ${table}`).not.toHaveBeenCalled()
      await harness?.close()
      harness = undefined
    }
  })

  it('商品不在成员数据范围内或不存在：404（按企业、美国站、成员范围查）', async () => {
    for (const [path] of PATHS) {
      const { res, prisma } = await call(ALL, path, { fbaProduct: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } })
      expect(res.status, path).toBe(404)
      expect(prisma.fbaProduct.findFirst.mock.calls[0][0].where, path).toMatchObject({ id: 'p1', tenantId: 'tenant-1', marketplaceId: 'ATVPDKIKX0DER' })
      await harness?.close()
      harness = undefined
    }
  })

  it('日期与周期参数不合法：422（只给 from、周期种类不对、周期起始日没对齐）', async () => {
    for (const query of ['from=2026-10-01', 'period=DAY', 'period=MONTH&periodStart=2026-10-02', 'periodStart=2026-10-05']) {
      const { res } = await call(ALL, `/products/p1/traffic?${query}`)
      expect(res.status, query).toBe(422)
      await harness?.close()
      harness = undefined
    }
    const { res } = await call(ALL, '/products/p1/competitors?period=MONTH&periodStart=2026-10-02')
    expect(res.status).toBe(422)
  })
})

describe('流量转化', () => {
  it('逐日流量：每天一个点，没有记录的日子是空；数据中心优先；合计的转化率与购物车获得率只含有记录的日子', async () => {
    const rows = [traffic('2026-10-01', { source: 'REPORT', sessions: 1 }), traffic('2026-10-01'), traffic('2026-10-03', { sessions: 300, units: 0, buyBoxPct: dec(0.5), unitSessionPct: null })]
    const { res } = await call(ALL, `/products/p1/traffic?${RANGE}`, { salesTrafficAsinDaily: { findMany: vi.fn().mockResolvedValue(rows), findFirst: vi.fn() } })
    expect(res.status).toBe(200)
    const { daily, range, pending } = res.json.data
    expect(range).toEqual({ from: '2026-10-01', to: '2026-10-03', defaulted: false })
    expect(daily.state).toBe('OK')
    expect(daily.points.map((point: { date: string }) => point.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(daily.points[0]).toMatchObject({ sessions: 100, unitSessionPct: 0.05 })
    expect(daily.points[1]).toEqual({ date: '2026-10-02', sessions: null, pageViews: null, units: null, sales: null, buyBoxPct: null, unitSessionPct: null })
    expect(daily.points[2]).toMatchObject({ sessions: 300, units: 0, unitSessionPct: 0 })
    expect(daily.summary).toMatchObject({ sessions: 400, units: 5, days: 2, unitSessionPct: 0.0125, buyBoxPct: 0.6 })
    expect(pending.map((item: { key: string }) => item.key)).toEqual(['device', 'cartRate', 'hourly'])
    expect(pending.every((item: { state: string }) => item.state === 'NOT_CONNECTED')).toBe(true)
  })

  it('从没同步过是“尚未接入”，同步过但没有数据是“尚无记录”，都不显示 0', async () => {
    const never = await call(ALL, `/products/p1/traffic?${RANGE}`)
    expect(never.res.json.data.daily).toMatchObject({ state: 'NOT_CONNECTED', summary: null })
    expect(never.res.json.data.daily.points.every((point: { sessions: number | null }) => point.sessions === null)).toBe(true)
    await harness?.close()
    harness = undefined
    const synced = await call(ALL, `/products/p1/traffic?${RANGE}`, { dataFreshness: { findMany: vi.fn().mockResolvedValue([freshRow(null, new Date('2026-10-22T00:00:00Z'))]) } })
    expect(synced.res.json.data.daily.state).toBe('NO_DATA')
  })

  it('没有品牌分析权限：搜索词与目录表现是“受限”（不是 403），也不读品牌分析表', async () => {
    const { res, prisma } = await call(['products.read'], `/products/p1/traffic?${RANGE}`)
    expect(res.status).toBe(200)
    expect(res.json.data.searchFunnel).toMatchObject({ state: 'RESTRICTED', terms: [], period: null })
    expect(res.json.data.catalogFunnel).toMatchObject({ state: 'RESTRICTED', current: null })
    expect(prisma.brandSearchQueryPerformance.findMany).not.toHaveBeenCalled()
    expect(prisma.brandSearchCatalogPerformance.findFirst).not.toHaveBeenCalled()
  })

  it('核心搜索词：漏斗合计与上一周期对比、断点诊断、只含这个 ASIN 的词（查询带企业、店铺与 ASIN）', async () => {
    const terms = [sqp('a', 100), sqp('b', 90), sqp('c', 80), sqp('d', 70), sqp('e', 60), sqp('低点击', 200, 0.5, 0.1)]
    const findMany = vi.fn().mockImplementation((args: { select?: { periodStart?: boolean }; where: { periodStart?: Date } }) => {
      if (args.select?.periodStart) return Promise.resolve([{ periodStart: day('2026-10-18') }, { periodStart: day('2026-10-11') }])
      return Promise.resolve(args.where.periodStart?.toISOString().startsWith('2026-10-18') ? terms : [sqp('a', 100, 0.25, 0.25)])
    })
    const { res, prisma } = await call(ALL, `/products/p1/traffic?${RANGE}`, { brandSearchQueryPerformance: { findMany, findFirst: vi.fn() } })
    const { searchFunnel } = res.json.data
    expect(searchFunnel.state).toBe('OK')
    expect(searchFunnel.period).toMatchObject({ kind: 'WEEK', start: '2026-10-18', end: '2026-10-24', previousStart: '2026-10-11' })
    expect(searchFunnel.termCount).toBe(6)
    expect(searchFunnel.terms[0]).toMatchObject({ searchQuery: '低点击', breakpoint: 'CLICK' })
    expect(searchFunnel.breakpoints).toMatchObject({ state: 'OK', counts: { CLICK: 1, CART: 0, PURCHASE: 0 } })
    expect(searchFunnel.stages[0]).toMatchObject({ key: 'impressions', share: 0.5, previousShare: 0.5 })
    expect(searchFunnel.stages[1].previousShare).toBe(0.25)
    for (const call of prisma.brandSearchQueryPerformance.findMany.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', asin: 'B0TEST0001', reportPeriod: 'WEEK' })
    }
  })

  it('没有搜索词数据：从没同步过品牌分析报告是“尚未接入”，没有品牌分析角色也是“尚未接入”并说明原因', async () => {
    const never = await call(ALL, `/products/p1/traffic?${RANGE}`)
    expect(never.res.json.data.searchFunnel).toMatchObject({ state: 'NOT_CONNECTED', terms: [], termCount: 0 })
    expect(never.res.json.data.catalogFunnel).toMatchObject({ state: 'NOT_CONNECTED', current: null })
    await harness?.close()
    harness = undefined
    const noBrand = await call(ALL, `/products/p1/traffic?${RANGE}`, { dataFreshness: { findMany: vi.fn().mockResolvedValue([freshRow('BA_NO_BRAND', null)]) } })
    expect(noBrand.res.json.data.searchFunnel.state).toBe('NOT_CONNECTED')
    expect(noBrand.res.json.data.searchFunnel.note).toContain('品牌备案')
  })

  it('目录表现：本期与上一周期的展示、点击、加购、购买；非美元的销售额不当作美元', async () => {
    const metrics = (impressions: number, currency = 'USD') => ({
      impressions,
      clicks: 10,
      cartAdds: 4,
      purchases: 2,
      clickRate: dec(0.1),
      conversionRate: dec(0.2),
      searchTrafficSales: dec(80),
      currency,
    })
    const findMany = vi.fn().mockResolvedValue([{ periodStart: day('2026-10-18') }])
    const findFirst = vi
      .fn()
      .mockImplementation((args: { where: { periodStart: Date } }) => Promise.resolve(args.where.periodStart.toISOString().startsWith('2026-10-18') ? metrics(1000, 'CAD') : metrics(800)))
    const { res } = await call(ALL, `/products/p1/traffic?${RANGE}`, { brandSearchCatalogPerformance: { findMany, findFirst } })
    const { catalogFunnel } = res.json.data
    expect(catalogFunnel.state).toBe('OK')
    expect(catalogFunnel.current).toMatchObject({ impressions: 1000, clicks: 10, searchTrafficSales: null })
    expect(catalogFunnel.previous).toMatchObject({ impressions: 800, searchTrafficSales: 80 })
  })
})

describe('刊登与问题、评价、内容与 A+', () => {
  it('刊登：只给目录同步已有的真实资料，问题、质量分、限制与属性对照逐项“尚未接入”', async () => {
    const { res } = await call(ALL, '/products/p1/listing')
    expect(res.status).toBe(200)
    const facts = Object.fromEntries(res.json.data.facts.map((fact: { label: string; value: string | null }) => [fact.label, fact.value]))
    expect(facts).toMatchObject({ 刊登状态: '在售', 配送方式: '亚马逊物流 FBA', 商品类型: 'HOME', 目录核对: '目录已核对', 主图: '已有', '父 ASIN': 'B0PARENT01' })
    expect(res.json.data.pending.map((item: { key: string }) => item.key)).toEqual(['issues', 'quality', 'restrictions', 'attributes'])
    expect(JSON.stringify(res.json.data)).not.toMatch(/"score"|质量分：\d/)
  })

  it('刊登：目录没同步过时没有目录时间也没有主图，不编造', async () => {
    const { res } = await call(ALL, '/products/p1/listing', {
      fbaProduct: { findFirst: vi.fn().mockResolvedValue(product({ catalogStatus: null, catalogSyncedAt: null, imageUrl: null, productType: null, parentAsin: null })), findMany: vi.fn() },
    })
    const facts = Object.fromEntries(res.json.data.facts.map((fact: { label: string; value: string | null }) => [fact.label, fact.value]))
    expect(facts).toMatchObject({ 目录核对: '目录尚未同步', 目录同步时间: null, 主图: null, 商品类型: null, '父 ASIN': null })
  })

  it('评价：没有评分与主题时三块都是“无数据”并写原因，只有请求评价覆盖率仍是“尚未接入”', async () => {
    const { res } = await call(ALL, '/products/p1/reviews')
    expect(res.status).toBe(200)
    expect(Object.keys(res.json.data).sort()).toEqual(['basis', 'category', 'pending', 'rating', 'topics'])
    expect(res.json.data.rating).toMatchObject({ state: 'NO_DATA', latest: null, points: [] })
    expect(res.json.data.topics).toMatchObject({ state: 'NO_DATA', positive: [], negative: [] })
    expect(res.json.data.category.state).toBe('NO_DATA')
    expect(res.json.data.pending.map((item: { key: string }) => item.key)).toEqual(['coverage'])
    expect(res.json.data.pending.every((item: { workPackage: string }) => item.workPackage === 'P4-13')).toBe(true)
  })

  it('内容：目录已取到的字段（标题、品牌、类目、类型、变体属性、主图），其余逐项“尚未接入”', async () => {
    const { res } = await call(ALL, '/products/p1/content')
    expect(res.json.data.imageUrl).toBe('https://img.example/a.jpg')
    const facts = Object.fromEntries(res.json.data.facts.map((fact: { label: string; value: string | null }) => [fact.label, fact.value]))
    expect(facts).toMatchObject({ 标题: '示例商品', 品牌: '示例品牌', 类目路径: 'Home > Kitchen', 商品类型: 'HOME', 变体属性: 'color：Red；size：L' })
    expect(res.json.data.pending.map((item: { key: string }) => item.key)).toEqual(['listingContent', 'compare', 'othersChanged'])
    expect(res.json.data.aplus).toMatchObject({ state: 'NO_DATA', items: [], truncated: false })
  })
})

describe('定价与购物车', () => {
  it('标价、逐日成交均价与推荐报价获得率；推荐报价、竞争报价、价格历史、价格事件“尚未接入”', async () => {
    const summary = [
      { summaryDate: day('2026-10-01'), units: 4, salesAmount: dec(80), currency: 'USD' },
      { summaryDate: day('2026-10-02'), units: 0, salesAmount: dec(0), currency: 'USD' },
    ]
    const { res } = await call(ALL, `/products/p1/pricing?${RANGE}`, {
      asinDailySummary: { findMany: vi.fn().mockResolvedValue(summary), groupBy: vi.fn() },
      salesTrafficAsinDaily: { findMany: vi.fn().mockResolvedValue([traffic('2026-10-01')]), findFirst: vi.fn() },
    })
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.listPrice).toMatchObject({ value: 19.9, currency: 'USD' })
    expect(data.daily.state).toBe('OK')
    expect(data.daily.points[0]).toEqual({ date: '2026-10-01', units: 4, sales: 80, avgPrice: 20, buyBoxPct: 0.9 })
    expect(data.daily.points[1]).toMatchObject({ units: 0, avgPrice: null, buyBoxPct: null })
    expect(data.daily.points[2]).toEqual({ date: '2026-10-03', units: null, sales: null, avgPrice: null, buyBoxPct: null })
    expect(data.daily).toMatchObject({ avgPrice: 20, buyBoxPct: 0.9 })
    expect(data.pending.map((item: { key: string }) => item.key)).toEqual(['winPrice', 'offers', 'history', 'events'])
  })

  it('没有标价与任何销售记录：标价为空、日度是“尚未接入”或“尚无记录”', async () => {
    const { res } = await call(ALL, `/products/p1/pricing?${RANGE}`, { fbaProduct: { findFirst: vi.fn().mockResolvedValue(product({ price: null })), findMany: vi.fn() } })
    expect(res.json.data.listPrice.value).toBeNull()
    expect(res.json.data.daily).toMatchObject({ state: 'NOT_CONNECTED', avgPrice: null, buyBoxPct: null })
  })
})

describe('竞品', () => {
  const hotRow = (searchTerm: string, asins: string[]) => ({
    searchTerm,
    searchFrequencyRank: 120,
    clickedAsin1: asins[0] ?? null,
    clickedTitle1: '第一名',
    clickShare1: dec(0.3),
    conversionShare1: dec(0.2),
    clickedAsin2: asins[1] ?? null,
    clickedTitle2: '第二名',
    clickShare2: dec(0.2),
    conversionShare2: dec(0.1),
    clickedAsin3: asins[2] ?? null,
    clickedTitle3: '第三名',
    clickShare3: dec(0.1),
    conversionShare3: dec(0.1),
  })
  const sqpFindMany = vi
    .fn()
    .mockImplementation((args: { select?: { periodStart?: boolean } }) =>
      args.select?.periodStart ? Promise.resolve([{ periodStart: day('2026-10-18') }]) : Promise.resolve([sqp('yoga mat', 100), sqp('yoga block', 50)]),
    )

  it('核心搜索词在热门搜索词里点击份额前三：标出本品、本企业其他商品与外部商品', async () => {
    const { res, prisma } = await call(ALL, '/products/p1/competitors', {
      brandSearchQueryPerformance: { findMany: sqpFindMany, findFirst: vi.fn() },
      brandSearchTerm: { findMany: vi.fn().mockResolvedValue([hotRow('yoga mat', ['B0OTHER001', 'B0TEST0001', 'B0OWN00001'])]) },
      fbaProduct: { findFirst: vi.fn().mockResolvedValue(product()), findMany: vi.fn().mockResolvedValue([{ asin: 'B0OWN00001' }]) },
    })
    expect(res.status).toBe(200)
    const { terms, pending } = res.json.data
    expect(terms.state).toBe('OK')
    expect(terms.period).toMatchObject({ kind: 'WEEK', start: '2026-10-18' })
    expect(terms.rows).toHaveLength(1)
    expect(terms.rows[0]).toMatchObject({ searchTerm: 'yoga mat', frequencyRank: 120, selfRank: 2 })
    expect(terms.rows[0].slots.map((slot: { isSelf: boolean; isOwn: boolean }) => [slot.isSelf, slot.isOwn])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ])
    expect(pending).toEqual([])
    expect(prisma.brandSearchTerm.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', reportPeriod: 'WEEK' })
    expect(prisma.fbaProduct.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1' })
  })

  it('热门搜索词里一个核心词都没有：尚无记录（已同步过）或尚未接入（没同步过），不列空行', async () => {
    const base = { brandSearchQueryPerformance: { findMany: sqpFindMany, findFirst: vi.fn() } }
    const never = await call(ALL, '/products/p1/competitors', base)
    expect(never.res.json.data.terms).toMatchObject({ state: 'NOT_CONNECTED', rows: [] })
    await harness?.close()
    harness = undefined
    const synced = await call(ALL, '/products/p1/competitors', { ...base, dataFreshness: { findMany: vi.fn().mockResolvedValue([freshRow(null, new Date('2026-10-22T00:00:00Z'))]) } })
    expect(synced.res.json.data.terms).toMatchObject({ state: 'NO_DATA', rows: [] })
  })

  it('这个 ASIN 没有搜索词数据：取不到核心词，说明原因', async () => {
    const { res } = await call(ALL, '/products/p1/competitors')
    expect(res.json.data.terms).toMatchObject({ state: 'NOT_CONNECTED', period: null, rows: [] })
    expect(res.json.data.terms.note).toContain('核心搜索词')
  })
})

describe('建议动作区的 6 条规则', () => {
  const withInventory = (permissions: string[]) =>
    stub(permissions, {
      fbaProduct: {
        findFirst: vi.fn().mockResolvedValue(product()),
        findMany: vi
          .fn()
          .mockImplementation((args: { select?: { listingStatus?: boolean } }) =>
            Promise.resolve(
              args.select?.listingStatus
                ? [{ id: 'p1', sellerSku: 'SKU-1', fnsku: 'X0TEST0001', listingStatus: 'ACTIVE' }]
                : [{ sellerAccountId: 's1', sellerSku: 'SKU-1', title: '示例商品', brand: '示例品牌' }],
            ),
          ),
      },
      fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([record()]), findFirst: vi.fn().mockResolvedValue({ id: 'inv-1' }) },
      replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(policyRow()), findMany: vi.fn().mockResolvedValue([policyRow()]), create: vi.fn() },
    })

  it('没有库存权限：库存类规则“无权查看”，其余“尚未接入”（动作区本身是受限，不是 403）', async () => {
    const prisma = withInventory(['products.read'])
    harness = await createTestApp(prisma)
    const { data } = (await harness.call('GET', '/products/p1/actions')).json
    expect(data).toMatchObject({ state: 'RESTRICTED', items: [] })
    expect(data.rules.map((rule: { key: string; state: string }) => [rule.key, rule.state])).toEqual([
      ['PRICE_ABOVE_WIN', 'NOT_CONNECTED'],
      ['LOW_COVER', 'RESTRICTED'],
      ['LISTING_ERROR', 'NOT_CONNECTED'],
      ['NEGATIVE_REVIEW', 'NOT_CONNECTED'],
      ['AGING_FEE', 'RESTRICTED'],
      ['CONTENT_CHANGED', 'NOT_CONNECTED'],
    ])
  })

  it('有库存权限：库存类规则按库存建议判断；其余规则永远不会被当作“没触发”', async () => {
    harness = await createTestApp(withInventory(['products.read', 'inventory.read', 'replenishment.read']))
    const { data } = (await harness.call('GET', '/products/p1/actions')).json
    expect(data.rules).toHaveLength(6)
    const states = Object.fromEntries(data.rules.map((rule: { key: string; state: string }) => [rule.key, rule.state]))
    expect(['TRIGGERED', 'CLEAR']).toContain(states.LOW_COVER)
    expect(['TRIGGERED', 'CLEAR']).toContain(states.AGING_FEE)
    for (const key of ['PRICE_ABOVE_WIN', 'LISTING_ERROR', 'NEGATIVE_REVIEW', 'CONTENT_CHANGED']) expect(states[key]).toBe('NOT_CONNECTED')
    const ids = data.items.map((item: { id: string }) => item.id)
    expect(states.LOW_COVER === 'TRIGGERED').toBe(ids.includes('replenish'))
    expect(states.AGING_FEE === 'TRIGGERED').toBe(ids.includes('aging'))
  })
})
