import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 品牌分析接口（P4-04）：权限先于参数校验、数据范围、份额按次数重算、空值不当 0、象限与断点、机会词与风险词、购物篮建议、
// 复购买家占比加权、对比期、截断、没有数据与缺品牌角色的说明、游标篡改。

const dec = (value: string) => ({ toString: () => value })
const day = (text: string) => new Date(`${text}T00:00:00Z`)
const BASE = '/analytics/brand'
const A1 = 'B0AAAAAAA1'
const A2 = 'B0AAAAAAA2'
const A3 = 'B0AAAAAAA3'
const X1 = 'B0XXXXXXX1'
const X2 = 'B0XXXXXXX2'
const NOW_START = '2026-10-11'
const PREV_START = '2026-10-04'
const PERIODS = [{ periodStart: day(NOW_START) }, { periodStart: day(PREV_START) }]

/** 搜索查询表现：一个搜索词的汇总（own 是我方次数之和，total 是市场总次数的最大值）。 */
function sqp(
  query: string,
  volume: number | null,
  own: Array<number | null>,
  total: Array<number | null>,
  over: { max?: Record<string, unknown>; sum?: Record<string, unknown>; avg?: Record<string, unknown> } = {},
) {
  const [io, co, ao, po] = own
  const [it, ct, at, pt] = total
  return {
    searchQuery: query,
    _count: { _all: 1 },
    _sum: { impressionsOwn: io, clicksOwn: co, cartAddsOwn: ao, purchasesOwn: po, purchasesSameDayOwn: null, purchasesOneDayOwn: null, purchasesTwoDayOwn: null, ...over.sum },
    _max: {
      searchVolume: volume,
      searchQueryScore: null,
      impressionsTotal: it,
      clicksTotal: ct,
      cartAddsTotal: at,
      purchasesTotal: pt,
      purchasesSameDayTotal: null,
      purchasesOneDayTotal: null,
      purchasesTwoDayTotal: null,
      impressionShare: null,
      clickShare: null,
      cartAddShare: null,
      purchaseShare: null,
      clickPriceTotal: null,
      cartAddPriceTotal: null,
      purchasePriceTotal: null,
      currency: null,
      ...over.max,
    },
    _avg: { clickPriceOwn: null, cartAddPriceOwn: null, purchasePriceOwn: null, ...over.avg },
  }
}

// 六个词：中位数 展示 0.2、点击 0.1、加购 0.1、购买 0.05；搜索量中位数 3000
const CURRENT = [
  sqp('yoga mat', 10000, [300, 60, 9, 2], [1000, 300, 90, 60], { max: { clickPriceTotal: dec('20'), currency: 'USD' }, avg: { clickPriceOwn: dec('22') }, sum: { purchasesSameDayOwn: 1 } }), // 购买断点、增长机会
  sqp('yoga block', 5000, [100, 40, 8, 4], [1000, 200, 80, 40]), // 核心优势
  sqp('mat bag', 3000, [200, 10, 5, 1], [400, 200, 50, 20]), // 点击断点
  sqp('yoga strap', 2000, [40, 10, 2, 2], [200, 100, 40, 10]), // 加购断点、利基
  sqp('foam roller', 1000, [30, 3, 1, 0], [300, 100, 20, 10]), // 观察，购买份额是 0 不是空
  sqp('no data term', 500, [null, null, null, null], [null, null, null, null]), // 官方没给次数
]
const PREVIOUS = [sqp('yoga mat', 9000, [100, 60, 9, 3], [1000, 300, 90, 60])]

const PRODUCTS = [
  { id: 'p1', asin: A1, title: '瑜伽垫', brand: 'Nova' },
  { id: 'p2', asin: A2, title: '瑜伽砖', brand: 'Nova' },
]

const freshness = (sellerAccountId: string, sourceKey: string, over: Record<string, unknown> = {}) => ({
  sellerAccountId,
  sourceKey,
  lastAttemptAt: new Date(),
  lastSuccessAt: new Date('2026-10-22T01:00:00Z'),
  dataThrough: null,
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})

interface Options {
  empty?: boolean
  noProducts?: boolean
  noAds?: boolean
  freshnessRows?: Array<Record<string, unknown>>
  extra?: Record<string, unknown>
}

function stub(permissions: string[], options: Options = {}, over: Record<string, unknown> = {}) {
  const startOf = (args: { where: { periodStart?: Date } }) => args.where.periodStart?.toISOString().slice(0, 10)
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    sellerAccount: {
      findMany: vi.fn().mockResolvedValue([
        { id: 's1', displayName: '美国主店' },
        { id: 's2', displayName: '美国二店' },
      ]),
    },
    dataFreshness: { findMany: vi.fn().mockResolvedValue(options.freshnessRows ?? [freshness('s1', 'rpt.ba.search-query')]) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue(options.noProducts ? [] : PRODUCTS) },
    adsKeyword: {
      findFirst: vi.fn().mockResolvedValue(options.noAds ? null : { id: 'k1' }),
      findMany: vi.fn().mockResolvedValue([
        { text: 'yoga mat', state: 'ENABLED' },
        { text: 'yoga block', state: 'PAUSED' },
      ]),
    },
    brandSearchQueryPerformance: {
      findMany: vi.fn().mockResolvedValue(options.empty ? [] : PERIODS),
      groupBy: vi.fn().mockImplementation(async (args: { by: string[]; where: { periodStart: Date | { in: Date[] } } }) => {
        if (options.empty) return []
        if (args.by[0] === 'asin') return [{ asin: A1, _count: { _all: 6 } }]
        if (args.by[0] === 'periodStart')
          return [
            { periodStart: day(NOW_START), ...CURRENT[0]! },
            { periodStart: day(PREV_START), ...PREVIOUS[0]! },
          ]
        return startOf(args as never) === PREV_START ? PREVIOUS : CURRENT
      }),
    },
    ...options.extra,
    ...over,
  }
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[] = ['analytics.brand.read'], options: Options = {}, over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, options, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const read = async (path: string, options: Options = {}) => {
  const { call } = await open(['analytics.brand.read'], options)
  return (await call('GET', path)).json.data
}

/** 指定词表的汇总取数替身：按 groupBy 的维度分别返回 ASIN 选项、逐期趋势与搜索词汇总。 */
const sqpGroupBy = (rows: unknown[]) =>
  vi.fn().mockImplementation(async (args: { by: string[] }) => {
    if (args.by[0] === 'asin') return [{ asin: A1, _count: { _all: 6 } }]
    if (args.by[0] === 'periodStart') return rows.map(row => ({ periodStart: day(NOW_START), ...(row as object) }))
    return rows
  })

const ROUTES = ['search-query', 'catalog', 'search-terms', 'market-basket', 'repeat-purchase']
const BRAND_MODELS = ['brandSearchQueryPerformance', 'brandSearchCatalogPerformance', 'brandSearchTerm', 'brandMarketBasket', 'brandRepeatPurchase', 'fbaProduct']
const emptyModels = () => Object.fromEntries(BRAND_MODELS.slice(1).map(model => [model, { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) }]))

describe('权限与参数', () => {
  it('未登录 401；没有 analytics.brand.read（只有 analytics.read 也不行）403 且先于参数校验，一条数据都不查', async () => {
    const { call } = await open()
    for (const route of ROUTES) expect((await call('GET', `${BASE}/${route}`, { auth: false })).status).toBe(401)
    for (const permissions of [['finance.read'], ['analytics.read']]) {
      const denied = await open(permissions, { extra: emptyModels() })
      for (const route of ROUTES) expect((await denied.call('GET', `${BASE}/${route}?period=NOPE&sort=nope:asc&cursor=%`)).status).toBe(403)
      for (const model of BRAND_MODELS) for (const mock of Object.values(denied.prisma[model] ?? {})) expect(mock).not.toHaveBeenCalled()
    }
  })

  it('周期种类、起始日对齐、维度、ASIN 格式、排序、分组不对一律 422', async () => {
    const { call } = await open(['analytics.brand.read'], { extra: emptyModels() })
    const bad = [
      'search-query?period=YEAR',
      'search-query?period=WEEK&periodStart=2026-10-12', // 周一，周要选周日
      'search-query?period=MONTH&periodStart=2026-10-11',
      'search-query?period=QUARTER&periodStart=2026-11-01',
      'search-query?dimension=SKU',
      'search-query?asin=short',
      'search-query?sort=nope:asc',
      'catalog?sort=nope:asc',
      'search-terms?filter=NOPE',
      'market-basket?sort=nope:asc',
      'repeat-purchase?dimension=PARENT',
    ]
    for (const route of bad) expect((await call('GET', `${BASE}/${route}`)).status, route).toBe(422)
    for (const route of ['search-query?period=WEEK&periodStart=2026-10-11', 'search-query?period=MONTH&periodStart=2026-10-01', 'search-query?period=QUARTER&periodStart=2026-10-01']) {
      expect((await call('GET', `${BASE}/${route}`)).status, route).toBe(200)
    }
  })

  it('范围收窄到一个店铺时每个查询都带店铺条件', async () => {
    const scoped = { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } }
    const { call, prisma } = await open(['analytics.brand.read'], { extra: emptyModels() }, scoped)
    for (const route of ROUTES) expect((await call('GET', `${BASE}/${route}`)).status).toBe(200)
    for (const model of BRAND_MODELS.slice(0, 5)) {
      const calls = Object.values(prisma[model]!).flatMap(mock => mock.mock.calls)
      for (const [args] of calls) expect(JSON.stringify(args.where)).toMatch(/tenant-1[\s\S]*s1/)
    }
    expect(JSON.stringify(prisma.sellerAccount!.findMany!.mock.calls)).toContain('s1')
  })
})

describe('搜索查询表现', () => {
  it('份额按次数重算；官方没给次数的词份额是 null 不是 0；与上一周期对比出变化；没传周期用最近一个有数据的', async () => {
    const data = await read(`${BASE}/search-query?sort=searchVolume:desc`)
    expect(data.state).toBe('OK')
    expect(data.period).toMatchObject({ kind: 'WEEK', start: NOW_START, end: '2026-10-17', previousStart: PREV_START, defaulted: true, available: [NOW_START, PREV_START] })
    const mat = data.items.find((row: { searchQuery: string }) => row.searchQuery === 'yoga mat')
    expect(mat.shares).toMatchObject({ impression: 0.3, click: 0.2, cartAdd: 0.1 })
    expect(mat.shares.purchase).toBeCloseTo(2 / 60, 6)
    expect(mat.changes.impression).toBeCloseTo(0.2, 6) // 0.3 - 0.1
    expect(mat.changes.purchase).toBeCloseTo(2 / 60 - 0.05, 6)
    const missing = data.items.find((row: { searchQuery: string }) => row.searchQuery === 'no data term')
    expect(missing.shares).toEqual({ impression: null, click: null, cartAdd: null, purchase: null })
    expect(missing.changes.purchase).toBeNull()
    const roller = data.items.find((row: { searchQuery: string }) => row.searchQuery === 'foam roller')
    expect(roller.shares.purchase).toBe(0) // 我方购买 0 次，份额是 0
    expect(data.items[0].searchQuery).toBe('yoga mat') // 默认按搜索量从高到低
  })

  it('漏斗合计、象限与断点：中位数在全部词上算', async () => {
    const data = await read(`${BASE}/search-query`)
    expect(data.funnel.map((stage: { key: string }) => stage.key)).toEqual(['impressions', 'clicks', 'cartAdds', 'purchases'])
    expect(data.funnel[0]).toMatchObject({ market: 2900, own: 670, previousShare: 0.1 })
    expect(data.funnel[0].share).toBeCloseTo(670 / 2900, 6)
    expect(data.quadrant.state).toBe('OK')
    expect(data.quadrant.medians).toEqual({ volume: 3000, purchaseShare: 0.05 })
    expect(data.quadrant.counts).toEqual({ STAR: 2, OPPORTUNITY: 1, NICHE: 1, WATCH: 1 })
    const quadrantOf = (query: string) => data.items.find((row: { searchQuery: string }) => row.searchQuery === query).quadrant
    expect([quadrantOf('yoga mat'), quadrantOf('yoga block'), quadrantOf('yoga strap'), quadrantOf('foam roller'), quadrantOf('no data term')]).toEqual(['OPPORTUNITY', 'STAR', 'NICHE', 'WATCH', null])
    expect(data.breakpoints.state).toBe('OK')
    expect(data.breakpoints.medians).toMatchObject({ impression: 0.2, click: 0.1, cartAdd: 0.1, purchase: 0.05 })
    expect(data.breakpoints.counts).toEqual({ CLICK: 1, CART: 1, PURCHASE: 1 })
    expect(data.breakpoints.examples.CLICK[0].searchQuery).toBe('mat bag')
    expect(data.items.find((row: { searchQuery: string }) => row.searchQuery === 'yoga mat').breakpoint).toBe('PURCHASE')
  })

  it('词太少（不足 5 个带份额）不做象限与断点，写明原因', async () => {
    const few = await open(['analytics.brand.read'], {}, { brandSearchQueryPerformance: { ...stub([]).brandSearchQueryPerformance, groupBy: sqpGroupBy(CURRENT.slice(0, 3)) } })
    const data = (await few.call('GET', `${BASE}/search-query`)).json.data
    expect(data.quadrant).toMatchObject({ state: 'INSUFFICIENT', medians: null, points: [] })
    expect(data.quadrant.note).toContain('不足 5 个')
    expect(data.breakpoints).toMatchObject({ state: 'INSUFFICIENT', medians: null })
  })

  it('价格对比按搜索量加权（只有一个词带价格时就是它）；配送速度给我方、市场与份额；价格没有的是 null', async () => {
    const data = await read(`${BASE}/search-query`)
    expect(data.price.find((row: { stage: string }) => row.stage === 'click')).toMatchObject({ own: 22, market: 20, gap: 0.1 })
    expect(data.price.find((row: { stage: string }) => row.stage === 'purchase')).toMatchObject({ own: null, market: null, gap: null })
    expect(data.shipping.find((row: { speed: string }) => row.speed === 'SAME_DAY')).toMatchObject({ own: 1, market: null, share: null })
    expect(data.priceNote).toContain('加权')
  })

  it('投放状态只对页面上的词查：已投放、已暂停、未投放；没有广告同步时是“尚未接入”', async () => {
    const data = await read(`${BASE}/search-query`)
    const status = (query: string) => data.items.find((row: { searchQuery: string }) => row.searchQuery === query).advertising
    expect([status('yoga mat'), status('yoga block'), status('mat bag')]).toEqual(['ADVERTISED', 'PAUSED', 'NONE'])
    const off = await read(`${BASE}/search-query`, { noAds: true })
    expect(new Set(off.items.map((row: { advertising: string }) => row.advertising))).toEqual(new Set(['NOT_CONNECTED']))
  })

  it('ASIN 维度默认取第一个有数据的 ASIN 并只查它；品牌维度取该品牌下的全部 ASIN', async () => {
    const { call, prisma } = await open()
    const asin = (await call('GET', `${BASE}/search-query?dimension=ASIN`)).json.data
    expect(asin.selection).toEqual({ asin: A1, brand: null })
    expect(asin.asinOptions).toEqual([{ asin: A1, title: '瑜伽垫', brand: 'Nova', terms: 6 }])
    expect(asin.brandOptions).toEqual(['Nova'])
    const groupCalls = prisma.brandSearchQueryPerformance!.groupBy!.mock.calls.filter(([args]) => args.by[0] === 'searchQuery')
    expect(groupCalls.length).toBeGreaterThan(0)
    for (const [args] of groupCalls) expect(args.where.asin).toEqual({ in: [A1] })
    const brand = (await call('GET', `${BASE}/search-query?dimension=BRAND&brand=Nova`)).json.data
    expect(brand.selection).toEqual({ asin: null, brand: 'Nova' })
    const last = prisma.brandSearchQueryPerformance!.groupBy!.mock.calls.filter(([args]) => args.by[0] === 'searchQuery').at(-1)![0]
    expect(last.where.asin).toEqual({ in: [A1, A2] })
    const unknown = (await call('GET', `${BASE}/search-query?dimension=BRAND&brand=Nobody`)).json.data
    expect(unknown.state).toBe('NO_DATA')
  })

  it('趋势取所选周期搜索量最高的词、逐期 12 个点，同一批词；搜索关键词只过滤词表不改汇总', async () => {
    const { call, prisma } = await open()
    const data = (await call('GET', `${BASE}/search-query?q=block`)).json.data
    expect(data.trend).toHaveLength(12)
    expect(data.trend.at(-1).periodStart).toBe(NOW_START)
    expect(data.trend[0].periodStart < data.trend.at(-1).periodStart).toBe(true)
    const trendCall = prisma.brandSearchQueryPerformance!.groupBy!.mock.calls.find(([args]) => args.by[0] === 'periodStart')![0]
    expect(trendCall.where.searchQuery.in).toHaveLength(6)
    expect(data.items.map((row: { searchQuery: string }) => row.searchQuery)).toEqual(['yoga block'])
    expect(data.funnel[0].market).toBe(2900) // 汇总不受搜索关键词影响
    expect(data.overview.state).toBe('OK')
    expect(data.overview.rows.find((row: { root: string }) => row.root === 'yoga')).toMatchObject({ terms: 3, marketClicks: 600, ownClicks: 110 })
  })

  it('读到上限时标记截断；游标被篡改或条件变了返回 400', async () => {
    const huge = Array.from({ length: 20_000 }, (_, index) => sqp(`term ${index}`, 100, [1, 1, 1, 1], [10, 10, 10, 10]))
    const { call } = await open(
      ['analytics.brand.read'],
      {},
      { brandSearchQueryPerformance: { ...stub([]).brandSearchQueryPerformance, findMany: vi.fn().mockResolvedValue(PERIODS), groupBy: sqpGroupBy(huge) } },
    )
    const big = (await call('GET', `${BASE}/search-query?pageSize=1`)).json.data
    expect(big.truncated).toBe(true)
    expect(big.pageInfo.hasMore).toBe(true)
    const next = big.pageInfo.nextCursor as string
    expect((await call('GET', `${BASE}/search-query?pageSize=1&cursor=${encodeURIComponent(next)}`)).status).toBe(200)
    expect((await call('GET', `${BASE}/search-query?pageSize=1&q=term&cursor=${encodeURIComponent(next)}`)).status).toBe(400) // 条件变了
    expect((await call('GET', `${BASE}/search-query?cursor=garbage`)).status).toBe(400)
  })

  it('没有数据：状态 NO_DATA，说明原因，不放示例数字；所有店铺都缺品牌分析角色时写前提', async () => {
    const none = await read(`${BASE}/search-query`, { empty: true })
    expect(none).toMatchObject({ state: 'NO_DATA', items: [], trend: [], period: { start: null, available: [] } })
    expect(none.note).toContain('尚无品牌分析数据')
    expect(none.funnel.every((stage: { share: number | null }) => stage.share === null)).toBe(true)
    const noBrand = await read(`${BASE}/search-query`, {
      empty: true,
      freshnessRows: [
        freshness('s1', 'rpt.ba.search-query', { status: 'NOT_APPLICABLE', lastErrorCode: 'BA_NO_BRAND' }),
        freshness('s2', 'rpt.ba.search-query', { status: 'NOT_APPLICABLE', lastErrorCode: 'BA_NO_BRAND' }),
      ],
    })
    expect(noBrand.note).toContain('品牌备案')
    expect(noBrand.stores.map((store: { state: string }) => store.state)).toEqual(['NO_BRAND', 'NO_BRAND'])
    const mixed = await read(`${BASE}/search-query`, { empty: true, freshnessRows: [freshness('s1', 'rpt.ba.search-query', { status: 'FAILED', lastErrorCode: 'ROLE_MISSING' })] })
    expect(mixed.stores.map((store: { state: string }) => store.state)).toEqual(['FAILED', 'NO_RECORD'])
    expect(mixed.note).toContain('尚无品牌分析数据')
  })
})

// ---- 目录表现 ----
const catalogRow = (asin: string, sum: Record<string, unknown>) => ({ asin, _sum: { impressions: null, clicks: null, cartAdds: null, purchases: null, searchTrafficSales: null, ...sum } })

describe('目录表现', () => {
  const extra = (): Options['extra'] => ({
    brandSearchCatalogPerformance: {
      findMany: vi.fn().mockResolvedValue(PERIODS),
      groupBy: vi
        .fn()
        .mockImplementation(async (args: { where: { periodStart: Date } }) =>
          args.where.periodStart.toISOString().slice(0, 10) === PREV_START
            ? [catalogRow(A1, { impressions: 8000, clicks: 240, cartAdds: 36, purchases: 18 })]
            : [catalogRow(A1, { impressions: 10000, clicks: 400, cartAdds: 60, purchases: 30, searchTrafficSales: dec('660') }), catalogRow(A2, { impressions: 5000, clicks: 100 })],
        ),
    },
    salesTrafficAsinDaily: {
      groupBy: vi.fn().mockResolvedValue([
        { asin: A1, source: 'REPORT', _sum: { orderedSales: dec('9999'), sessions: 1 } },
        { asin: A1, source: 'DATA_KIOSK', _sum: { orderedSales: dec('3300'), sessions: 800 } },
      ]),
    },
  })

  it('各步转化率由次数重算；没有次数的步骤是 null；与上一周期、业务报告（数据中心优先）对照', async () => {
    const data = await read(`${BASE}/catalog?sort=impressions:desc`, { extra: extra() })
    expect(data.state).toBe('OK')
    const [first, second] = data.items
    expect(first).toMatchObject({ asin: A1, title: '瑜伽垫', productId: 'p1', brand: 'Nova', clickRate: 0.04, cartAddRate: 0.15, purchaseRate: 0.5 })
    expect(first.previous).toEqual({ clickRate: 0.03, cartAddRate: 0.15, purchaseRate: 0.5 })
    expect(first).toMatchObject({ allSales: 3300, sessions: 800, searchSalesShare: 0.2, clicksPerSession: 0.5 })
    expect(second).toMatchObject({ asin: A2, clickRate: 0.02, cartAddRate: null, purchaseRate: null, previous: null, allSales: null, searchSalesShare: null, searchTrafficSales: null })
    expect(data.summary).toMatchObject({ impressions: 15000, clicks: 500, cartAdds: 60, purchases: 30, clickRate: expect.closeTo(500 / 15000, 6) })
    expect(data.compareNote).toContain('美元')
  })

  it('按品牌筛选只看该品牌的 ASIN；没有数据时是 NO_DATA', async () => {
    const { call, prisma } = await open(['analytics.brand.read'], { extra: extra() })
    expect((await call('GET', `${BASE}/catalog?brand=Nova`)).status).toBe(200)
    const where = prisma.brandSearchCatalogPerformance!.groupBy!.mock.calls[0]![0].where
    expect(where.asin).toEqual({ in: [A1, A2] })
    const nobody = (await call('GET', `${BASE}/catalog?brand=Nobody`)).json.data
    expect(nobody).toMatchObject({ state: 'NO_DATA', items: [] })
    const empty = await read(`${BASE}/catalog`, { empty: true, extra: { brandSearchCatalogPerformance: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) } } })
    expect(empty.state).toBe('NO_DATA')
    expect(empty.summary.clickRate).toBeNull()
  })
})

// ---- 热门搜索词 ----
const term = (department: string, searchTerm: string, rank: number | null, slots: Array<[string | null, string | null]> = []) => ({
  department,
  searchTerm,
  searchFrequencyRank: rank,
  clickedAsin1: slots[0]?.[0] ?? null,
  clickedTitle1: null,
  clickShare1: slots[0]?.[1] ? dec(slots[0][1]) : null,
  conversionShare1: null,
  clickedAsin2: slots[1]?.[0] ?? null,
  clickedTitle2: null,
  clickShare2: slots[1]?.[1] ? dec(slots[1][1]) : null,
  conversionShare2: null,
  clickedAsin3: null,
  clickedTitle3: null,
  clickShare3: null,
  conversionShare3: null,
})

describe('热门搜索词', () => {
  const extra = (): Options['extra'] => ({
    brandSearchTerm: {
      findMany: vi.fn().mockImplementation(async (args: { distinct?: string[]; where: { periodStart: Date | { in: Date[] }; searchTerm?: string } }) => {
        if (args.distinct) return PERIODS
        if (args.where.searchTerm) {
          return [
            { ...term('Sports', 'yoga mat', 40, [[A1, '0.4']]), periodStart: day(PREV_START) },
            {
              ...term('Sports', 'yoga mat', 50, [
                [A1, '0.3'],
                [X1, '0.2'],
              ]),
              periodStart: day(NOW_START),
            },
          ]
        }
        if ((args.where.periodStart as Date).toISOString().slice(0, 10) === PREV_START)
          return [term('Sports', 'yoga mat', 40, [[A1, '0.4']]), term('Sports', 'yoga strap', 120, [[X1, '0.5']]), term('Sports', 'dup', 30, [[X1, '0.5']])]
        return [
          term('Sports', 'dup', 30, [[X1, '0.5']]),
          term('Sports', 'dup', 31, [[X2, '0.5']]), // 另一家店铺存的同一个词，去重后只留排名靠前的
          term('Sports', 'yoga mat', 50, [
            [A1, '0.3'],
            [X1, '0.2'],
          ]),
          term('Sports', 'yoga strap', 80, [[X1, '0.5']]),
          term('Sports', 'new term', 200, [[X2, '0.1']]),
          term('Sports', 'no rank', null),
        ]
      }),
    },
  })

  it('我方进前三、风险词（掉出前三或份额下降 5 个百分点）、机会词（排名上升 20% 且没进前三）；上一周期没有的词不判断；重复行去重', async () => {
    const data = await read(`${BASE}/search-terms`, { extra: extra() })
    expect(data.items.map((row: { searchTerm: string }) => row.searchTerm)).toEqual(['dup', 'yoga mat', 'yoga strap', 'new term', 'no rank'])
    const row = (name: string) => data.items.find((item: { searchTerm: string }) => item.searchTerm === name)
    expect(row('yoga mat')).toMatchObject({ rank: 50, previousRank: 40, rankChange: -10, inTop3: true, group: 'RISK' })
    expect(row('yoga mat').slots[0]).toMatchObject({ rank: 1, asin: A1, clickShare: 0.3, own: true })
    expect(row('yoga mat').slots[1]).toMatchObject({ asin: X1, own: false })
    expect(row('yoga strap')).toMatchObject({ rank: 80, previousRank: 120, rankChange: 40, inTop3: false, group: 'OPPORTUNITY' })
    expect(row('new term')).toMatchObject({ previousRank: null, rankChange: null, group: null })
    expect(row('no rank').rank).toBeNull()
    expect(data.groupCounts).toEqual({ top3: 1, OPPORTUNITY: 1, RISK: 1 })
    expect(data.ownAsinCount).toBe(2)
    expect(data.competitorNote).toContain('P4-12')
    expect(data.groupBasis).toContain('机会词')
  })

  it('分组筛选与搜索；选中一个词时返回它 12 个周期的排名与我方份额', async () => {
    const { call } = await open(['analytics.brand.read'], { extra: extra() })
    const risk = (await call('GET', `${BASE}/search-terms?filter=RISK`)).json.data
    expect(risk.items.map((item: { searchTerm: string }) => item.searchTerm)).toEqual(['yoga mat'])
    const top3 = (await call('GET', `${BASE}/search-terms?filter=TOP3`)).json.data
    expect(top3.items).toHaveLength(1)
    const search = (await call('GET', `${BASE}/search-terms?q=strap&term=Yoga%20Mat`)).json.data
    expect(search.items.map((item: { searchTerm: string }) => item.searchTerm)).toEqual(['yoga strap'])
    expect(search.history.term).toBe('yoga mat')
    expect(search.history.points).toHaveLength(12)
    expect(search.history.points.at(-1)).toEqual({ periodStart: NOW_START, rank: 50, ownBestClickShare: 0.3, inTop3: true })
    expect(search.history.points.at(-2)).toEqual({ periodStart: PREV_START, rank: 40, ownBestClickShare: 0.4, inTop3: true })
    expect(search.history.points[0]).toEqual({ periodStart: expect.any(String), rank: null, ownBestClickShare: null, inTop3: false })
    expect((await call('GET', `${BASE}/search-terms`)).json.data.history).toBeNull()
  })

  it('没有同步到我方商品时不判断分组和前三，写出我方 ASIN 数为 0', async () => {
    const data = await read(`${BASE}/search-terms`, { noProducts: true, extra: extra() })
    expect(data.ownAsinCount).toBe(0)
    expect(data.groupCounts).toEqual({ top3: 0, OPPORTUNITY: 0, RISK: 0 })
    expect(data.items.every((item: { group: string | null }) => item.group === null)).toBe(true)
  })
})

// ---- 购物篮 ----
const pair = (asin: string, pairedAsin: string, pct: string | null, rank: number | null) => ({ asin, pairedAsin, combinationPct: pct === null ? null : dec(pct), purchaseRank: rank })

describe('购物篮分析', () => {
  const extra = (): Options['extra'] => ({
    brandMarketBasket: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { distinct?: string[]; where: { periodStart: Date } }) =>
          args.distinct
            ? PERIODS
            : args.where.periodStart.toISOString().slice(0, 10) === PREV_START
              ? [pair(A1, A2, '0.10', 1)]
              : [pair(A1, A2, '0.12', 1), pair(A1, X1, '0.06', 2), pair(A1, X1, '0.03', 5), pair(A1, X2, '0.02', 3), pair(A2, X1, null, null)],
        ),
    },
  })

  it('建议：同篮的是我方另一个 ASIN 且同篮率够高 → 捆绑；别家商品够高 → 商品定向；太低或没值不建议；重复行去重；矩阵', async () => {
    const data = await read(`${BASE}/market-basket`, { extra: extra() })
    expect(data.items).toHaveLength(4)
    const row = (asin: string, paired: string) => data.items.find((item: { asin: string; pairedAsin: string }) => item.asin === asin && item.pairedAsin === paired)
    expect(row(A1, A2)).toMatchObject({ pairedOwn: true, advice: 'BUNDLE', previousPct: 0.1, purchaseRank: 1, asinTitle: '瑜伽垫', pairedTitle: '瑜伽砖' })
    expect(row(A1, A2).change).toBeCloseTo(0.02, 6)
    expect(row(A1, X1)).toMatchObject({ pairedOwn: false, advice: 'PRODUCT_TARGETING', combinationPct: 0.06, previousPct: null, change: null })
    expect(row(A1, X2).advice).toBeNull()
    expect(row(A2, X1)).toMatchObject({ combinationPct: null, advice: null })
    expect(data.adviceCounts).toEqual({ BUNDLE: 1, PRODUCT_TARGETING: 1 })
    expect(data.matrix.rows).toEqual([A1])
    expect(data.matrix.columns).toEqual([A2, X1, X2])
    expect(data.matrix.cells).toEqual([[0.12, 0.06, 0.02]])
    expect(data.matrix.max).toBe(0.12)
    expect(data.adviceBasis).toContain('不会自动执行')
  })

  it('按 ASIN 与关键词过滤；没有数据时是 NO_DATA 且矩阵为空', async () => {
    const { call } = await open(['analytics.brand.read'], { extra: extra() })
    const only = (await call('GET', `${BASE}/market-basket?asin=${A2}`)).json.data
    expect(only.items).toHaveLength(1)
    const search = (await call('GET', `${BASE}/market-basket?q=${encodeURIComponent('瑜伽砖')}`)).json.data
    expect(search.items.map((item: { pairedAsin: string }) => item.pairedAsin)).toEqual([A2, X1])
    // 关键词同时匹配“本品标题”和“同篮商品标题”：瑜伽砖是 A2 的标题，所以 A2 作主品的那一行也在
    const empty = await read(`${BASE}/market-basket`, { extra: { brandMarketBasket: { findMany: vi.fn().mockResolvedValue([]) } } })
    expect(empty).toMatchObject({ state: 'NO_DATA', items: [], matrix: { rows: [], columns: [], cells: [], max: null } })
  })
})

// ---- 重复购买 ----
const repeat = (periodStart: string, asin: string, over: Record<string, unknown>) => ({
  periodStart: day(periodStart),
  asin,
  orders: null,
  uniqueCustomers: null,
  repeatCustomersPct: null,
  repeatRevenue: null,
  repeatRevenuePct: null,
  currency: 'USD',
  ...over,
})

describe('重复购买', () => {
  const extra = (): Options['extra'] => ({
    brandRepeatPurchase: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(PERIODS)
        .mockResolvedValue([
          repeat(NOW_START, A1, { orders: 100, uniqueCustomers: 80, repeatCustomersPct: dec('0.2'), repeatRevenue: dec('500'), repeatRevenuePct: dec('0.25') }),
          repeat(NOW_START, A2, { orders: 50, uniqueCustomers: 20, repeatCustomersPct: dec('0.1'), repeatRevenue: dec('100'), repeatRevenuePct: dec('0.1') }),
          repeat(NOW_START, A3, { orders: 10, repeatCustomersPct: dec('0.5') }),
          repeat(PREV_START, A1, { uniqueCustomers: 40, repeatCustomersPct: dec('0.1') }),
        ]),
    },
  })

  it('汇总：订单数、买家数相加；复购买家占比按买家数加权；复购销售额占比由各行倒推；没给的是 null', async () => {
    const data = await read(`${BASE}/repeat-purchase?sort=repeatRevenue:desc`, { extra: extra() })
    expect(data.state).toBe('OK')
    expect(data.dimension).toBe('ASIN')
    expect(data.summary).toMatchObject({ orders: 160, uniqueCustomers: 100, repeatRevenue: 600 })
    expect(data.summary.repeatCustomersPct).toBeCloseTo(0.18, 6)
    expect(data.summary.repeatRevenuePct).toBeCloseTo(0.2, 6) // 600 ÷ (500/0.25 + 100/0.1)
    const first = data.items[0]
    expect(first).toMatchObject({ asin: A1, label: A1, title: '瑜伽垫', productId: 'p1', previousRepeatCustomersPct: 0.1 })
    expect(first.repeatCustomersChange).toBeCloseTo(0.1, 6)
    const third = data.items.find((item: { asin: string }) => item.asin === A3)
    expect(third).toMatchObject({ uniqueCustomers: null, repeatRevenue: null, repeatRevenuePct: null, repeatCustomersPct: 0.5, repeatCustomersChange: null })
    expect(data.repeatNote).toContain('复购买家占比')
  })

  it('品牌维度：没登记品牌的商品归“未登记品牌”；12 个周期的趋势，缺的周期各项为空', async () => {
    const data = await read(`${BASE}/repeat-purchase?dimension=BRAND`, { extra: extra() })
    const labels = data.items.map((item: { label: string }) => item.label).sort()
    expect(labels).toEqual(['Nova', '未登记品牌'])
    const nova = data.items.find((item: { label: string }) => item.label === 'Nova')
    expect(nova).toMatchObject({ asins: 2, asin: null, orders: 150, uniqueCustomers: 100 })
    expect(data.trend).toHaveLength(12)
    expect(data.trend.at(-1)).toMatchObject({ periodStart: NOW_START, orders: 160 })
    expect(data.trend.at(-2)).toMatchObject({ periodStart: PREV_START, uniqueCustomers: 40, orders: null })
    expect(data.trend[0]).toMatchObject({ orders: null, uniqueCustomers: null, repeatCustomersPct: null })
    const onlyNova = await read(`${BASE}/repeat-purchase?dimension=ASIN&brand=Nova`, { extra: extra() })
    expect(onlyNova.items.map((item: { asin: string }) => item.asin).sort()).toEqual([A1, A2])
  })

  it('币种不是美元的复购销售额当作没给；没有数据是 NO_DATA', async () => {
    const eur = {
      brandRepeatPurchase: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce(PERIODS)
          .mockResolvedValue([repeat(NOW_START, A1, { orders: 5, repeatRevenue: dec('77'), repeatRevenuePct: dec('0.5'), currency: 'EUR' })]),
      },
    }
    const data = await read(`${BASE}/repeat-purchase`, { extra: eur })
    expect(data.items[0]).toMatchObject({ orders: 5, repeatRevenue: null })
    const empty = await read(`${BASE}/repeat-purchase`, { empty: true, extra: { brandRepeatPurchase: { findMany: vi.fn().mockResolvedValue([]) } } })
    expect(empty).toMatchObject({ state: 'NO_DATA', items: [], trend: [] })
    expect(empty.summary).toEqual({ orders: null, uniqueCustomers: null, repeatCustomersPct: null, repeatRevenue: null, repeatRevenuePct: null })
  })
})
