import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 业务报告接口（P4-02）：权限先于参数校验、数据范围、来源取舍、空值不当 0、对比期与归因、ASIN 排序与游标、截断、没有数据与缺品牌角色的说明。

const dec = (value: string) => ({ toString: () => value })
const day = (text: string) => new Date(`${text}T00:00:00Z`)
const BASE = '/analytics/sales-traffic'
const CURRENT = 'from=2026-10-08&to=2026-10-14'
const WITH_COMPARE = `${CURRENT}&compare=previous`

const daily = (date: string, over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  date: day(date),
  source: 'DATA_KIOSK',
  orderedSales: dec('100'),
  unitsOrdered: 10,
  ordersCount: 8,
  sessions: 200,
  pageViews: 400,
  buyBoxPct: dec('0.9'),
  unitSessionPct: dec('0.05'),
  unitsRefunded: 1,
  ...over,
})

const CURRENT_ROWS = [daily('2026-10-08'), daily('2026-10-08', { source: 'REPORT', orderedSales: dec('999') }), daily('2026-10-10', { sessions: null, pageViews: null, unitsRefunded: null })]
const PREVIOUS_ROWS = [daily('2026-10-02', { orderedSales: dec('50'), unitsOrdered: 5, ordersCount: 4, sessions: 100, pageViews: 200 })]
const WEEK_ROWS = [daily('2026-10-04'), daily('2026-10-11')]

const group = (sellerAccountId: string, asin: string, source: string, sum: Record<string, unknown>, buyBox: string | null = null) => ({
  sellerAccountId,
  asin,
  sku: '',
  source,
  _sum: { orderedSales: null, units: null, ordersCount: null, sessions: null, pageViews: null, ...sum },
  _avg: { buyBoxPct: buyBox === null ? null : dec(buyBox) },
})
const ASIN_GROUPS = [
  group('s1', 'B000000001', 'DATA_KIOSK', { orderedSales: dec('300'), units: 30, ordersCount: 25, sessions: 600, pageViews: 900 }, '0.8'),
  group('s1', 'B000000001', 'REPORT', { orderedSales: dec('999'), units: 99 }),
  group('s1', 'B000000002', 'REPORT', { orderedSales: dec('500'), units: 10 }),
  group('s2', 'B000000003', 'DATA_KIOSK', { orderedSales: dec('100'), units: 0, sessions: 50 }),
  group('s1', 'B000000004', 'DATA_KIOSK', {}),
]

const freshnessRow = (sellerAccountId: string, over: Record<string, unknown> = {}) => ({
  sellerAccountId,
  sourceKey: 'dk.sales-traffic.date',
  lastAttemptAt: new Date(),
  lastSuccessAt: new Date('2026-10-22T01:00:00Z'),
  dataThrough: null,
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})

interface Options {
  empty?: boolean
  freshness?: Array<Record<string, unknown>>
  huge?: boolean
}

function stub(permissions: string[], options: Options = {}, over: Record<string, unknown> = {}) {
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: {
      findMany: vi.fn().mockResolvedValue([
        { id: 's1', displayName: '美国主店' },
        { id: 's2', displayName: '美国二店' },
      ]),
    },
    salesTrafficDaily: {
      findMany: vi.fn().mockImplementation(async (args: { where: { granularity: string; date: { gte: Date } } }) => {
        if (options.empty) return []
        if (options.huge) return Array.from({ length: 20_000 }, (_, index) => daily('2026-10-08', { sellerAccountId: `x${index}` }))
        if (args.where.granularity === 'WEEK') return WEEK_ROWS
        return args.where.date.gte.toISOString().slice(0, 10) >= '2026-10-08' ? CURRENT_ROWS : PREVIOUS_ROWS
      }),
    },
    salesTrafficAsinDaily: {
      groupBy: vi.fn().mockImplementation(async () => (options.empty ? [] : ASIN_GROUPS)),
      findMany: vi
        .fn()
        .mockImplementation(async () => (options.empty ? [] : [daily('2026-10-09', { units: 4, unitsOrdered: undefined }), daily('2026-10-09', { source: 'REPORT', orderedSales: dec('1') })])),
    },
    storeDailySummary: { aggregate: vi.fn().mockResolvedValue({ _sum: { adsSales: dec('30') }, _count: { adsSales: options.empty ? 0 : 3 } }) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue(options.freshness ?? [freshnessRow('s1'), freshnessRow('s2')]) },
    fbaProduct: {
      findMany: vi.fn().mockResolvedValue([{ id: 'p1', sellerAccountId: 's1', sellerSku: 'SKU-1', asin: 'B000000001', title: '护眼台灯', parentAsin: 'B00000000P' }]),
    },
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
const open = async (permissions: string[] = ['analytics.read'], options: Options = {}, over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, options, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const read = async (path: string, options: Options = {}) => {
  const { call } = await open(['analytics.read'], options)
  return (await call('GET', path)).json.data
}
type Card = { key: string; value: number | null; compareValue: number | null; change: number | null }

describe('权限与参数', () => {
  it('未登录 401；没有 analytics.read 403 且先于参数校验，一条数据都不查', async () => {
    const { call } = await open()
    for (const route of ['summary', 'by-date', 'by-asin', 'trends']) expect((await call('GET', `${BASE}/${route}`, { auth: false })).status).toBe(401)
    const denied = await open(['finance.read'])
    for (const route of ['summary?from=nope', 'by-date?granularity=nope', 'by-asin?sort=nope:asc&cursor=%', 'trends?asin=bad']) {
      expect((await denied.call('GET', `${BASE}/${route}`)).status).toBe(403)
    }
    for (const model of ['salesTrafficDaily', 'salesTrafficAsinDaily', 'storeDailySummary', 'fbaProduct']) {
      for (const mock of Object.values(denied.prisma[model]!)) expect(mock).not.toHaveBeenCalled()
    }
  })

  it('日期、粒度、层级、排序、ASIN 格式不对一律 422', async () => {
    const { call } = await open()
    for (const route of ['summary?from=nope&to=2026-10-01', 'by-date?granularity=YEAR', 'by-asin?level=GRANDPARENT', 'by-asin?sort=nope:asc', 'trends', 'trends?asin=short']) {
      expect((await call('GET', `${BASE}/${route}`)).status).toBe(422)
    }
  })

  it('范围收窄到一个店铺时每个查询都带店铺条件，别的店铺的数据读不到', async () => {
    const scoped = { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } }
    const { call, prisma } = await open(['analytics.read'], {}, scoped)
    for (const route of [`summary?${WITH_COMPARE}`, `by-date?${CURRENT}`, `by-asin?${CURRENT}&level=SKU`, `trends?${CURRENT}&asin=B000000001`]) {
      expect((await call('GET', `${BASE}/${route}`)).status).toBe(200)
    }
    const mocks = [
      prisma.salesTrafficDaily!.findMany!,
      prisma.salesTrafficAsinDaily!.findMany!,
      prisma.salesTrafficAsinDaily!.groupBy!,
      prisma.storeDailySummary!.aggregate!,
      prisma.fbaProduct!.findMany!,
      prisma.dataFreshness!.findMany!,
    ]
    for (const mock of mocks) {
      expect(mock.mock.calls.length).toBeGreaterThan(0)
      for (const [args] of mock.mock.calls) expect(JSON.stringify(args.where)).toMatch(/tenant-1[\s\S]*s1/)
    }
    expect(JSON.stringify(prisma.sellerAccount!.findMany!.mock.calls)).toContain('s1')
  })

  it('只读美元行', async () => {
    const { call, prisma } = await open()
    await call('GET', `${BASE}/summary?${CURRENT}`)
    await call('GET', `${BASE}/by-asin?${CURRENT}`)
    for (const [args] of prisma.salesTrafficDaily!.findMany!.mock.calls) expect(args.where.currency).toBe('USD')
    for (const [args] of prisma.salesTrafficAsinDaily!.groupBy!.mock.calls) expect(args.where.currency).toBe('USD')
    expect(prisma.storeDailySummary!.aggregate!.mock.calls[0]![0].where.currency).toBe('USD')
  })
})

describe('销售仪表盘', () => {
  it('同日两个来源只用数据中心；指标卡带对比期变化；缺会话的天不当 0', async () => {
    const data = await read(`${BASE}/summary?${WITH_COMPARE}`)
    expect(data.state).toBe('OK')
    expect(data.range).toEqual({ from: '2026-10-08', to: '2026-10-14', days: 7, defaulted: false })
    const cards = data.cards as Card[]
    const sales = cards.find(card => card.key === 'orderedSales')!
    expect(sales).toMatchObject({ value: 200, compareValue: 50 })
    expect(sales.change).toBeCloseTo(3, 6)
    expect(cards.find(card => card.key === 'sessions')).toMatchObject({ value: 200, compareValue: 100 })
    expect(cards.find(card => card.key === 'unitsRefunded')).toMatchObject({ value: 1 })
    expect(data.coverage).toEqual({ days: 7, withData: 2, reportOnly: 0 })
    expect(data.latestDate).toBe('2026-10-10')
    expect(data.currency).toBe('USD')
  })

  it('趋势逐日补齐，没有记录的日子各项为空；对比期趋势单独给出', async () => {
    const data = await read(`${BASE}/summary?${WITH_COMPARE}`)
    expect(data.trend).toHaveLength(7)
    expect(data.trend[0]).toMatchObject({ date: '2026-10-08', source: 'DATA_KIOSK', orderedSales: 100 })
    expect(data.trend[1]).toMatchObject({ date: '2026-10-09', source: null, orderedSales: null, sessions: null })
    expect(data.trend[2]).toMatchObject({ date: '2026-10-10', sessions: null, unitSessionPct: 0.05 })
    expect(data.compare).toMatchObject({ mode: 'previous', from: '2026-10-01', to: '2026-10-07' })
    expect(data.compareTrend).toHaveLength(7)
    expect(data.compareTrend[1]).toMatchObject({ date: '2026-10-02', orderedSales: 50 })
  })

  it('归因三个因子 + 广告拆分 + 设备拆分尚未接入', async () => {
    const data = await read(`${BASE}/summary?${WITH_COMPARE}`)
    expect(data.attribution.mode).toBe('THREE_FACTOR')
    expect(data.attribution.sales).toEqual({ before: 50, after: 200 })
    expect(data.attributionNote).toBeNull()
    expect(data.split).toEqual({ state: 'OK', note: null, adsSales: 30, organicSales: 170, adsShare: 0.15 })
    expect(data.deviceSplit.state).toBe('NOT_CONNECTED')
    expect(data.deviceSplit.note).toContain('尚未接入')
    expect(data.funnel.map((step: { key: string }) => step.key)).toEqual(['sessions', 'pageViews', 'ordersCount', 'unitsOrdered'])
  })

  it('没选对比期：没有变化与归因，并说明原因；没选日期默认最近 30 天并对比上一期', async () => {
    const data = await read(`${BASE}/summary?${CURRENT}`)
    expect(data.compare).toBeNull()
    expect(data.compareTrend).toBeNull()
    expect(data.attribution).toBeNull()
    expect(data.attributionNote).toContain('没有选择对比期')
    expect((data.cards as Card[]).every(card => card.compareValue === null && card.change === null)).toBe(true)
    const defaulted = await read(`${BASE}/summary`)
    expect(defaulted.range).toMatchObject({ days: 30, defaulted: true })
    expect(defaulted.compare).not.toBeNull()
  })

  it('读到上限被截断时标出', async () => {
    const data = await read(`${BASE}/summary?${CURRENT}`, { huge: true })
    expect(data.truncated).toBe(true)
    expect(await read(`${BASE}/summary?${CURRENT}`)).toMatchObject({ truncated: false })
  })
})

describe('没有数据与取得情况', () => {
  it('没有记录：NO_DATA 与原因，指标是空而不是 0，广告拆分不拆', async () => {
    const data = await read(`${BASE}/summary?${CURRENT}`, { empty: true })
    expect(data.state).toBe('NO_DATA')
    expect(data.note).toContain('销售与流量')
    expect((data.cards as Card[]).every(card => card.value === null)).toBe(true)
    expect(data.latestDate).toBeNull()
    expect(data.coverage.withData).toBe(0)
    expect(data.split.state).toBe('NO_DATA')
  })

  it('所有店铺都缺品牌分析角色：说明前提；每家店各有状态', async () => {
    const noBrand = [freshnessRow('s1', { status: 'UNAUTHORIZED', lastErrorCode: 'DK_NO_BRAND' }), freshnessRow('s2', { status: 'UNAUTHORIZED', lastErrorCode: 'DK_NO_BRAND' })]
    const data = await read(`${BASE}/summary?${CURRENT}`, { empty: true, freshness: noBrand })
    expect(data.note).toContain('品牌分析')
    expect(data.stores.map((store: { state: string }) => store.state)).toEqual(['NO_BRAND', 'NO_BRAND'])
    expect(data.stores[0].note).toContain('未授权')
    const mixed = await read(`${BASE}/summary?${CURRENT}`, { freshness: [freshnessRow('s1'), freshnessRow('s2', { status: 'FAILED', lastErrorCode: 'PARSE_HEADER' })] })
    expect(mixed.stores.map((store: { state: string }) => store.state)).toEqual(['AVAILABLE', 'FAILED'])
    expect(mixed.stores[1].note).not.toContain('PARSE_HEADER')
    const none = await read(`${BASE}/summary?${CURRENT}`, { freshness: [] })
    expect(none.stores.map((store: { state: string }) => store.state)).toEqual(['NO_RECORD', 'NO_RECORD'])
  })
})

describe('按日期', () => {
  it('日粒度逐日补齐，并带对比期点与范围合计', async () => {
    const data = await read(`${BASE}/by-date?${WITH_COMPARE}`)
    expect(data.granularity).toBe('DAY')
    expect(data.points).toHaveLength(7)
    expect(data.comparePoints).toHaveLength(7)
    expect(data.totals).toMatchObject({ orderedSales: 200, unitsOrdered: 20 })
    expect(data.compareNote).toBeNull()
  })

  it('周粒度读到包含起点的那一周（周日起），只列有记录的周；选了对比期时说明被忽略', async () => {
    const { call, prisma } = await open()
    const data = (await call('GET', `${BASE}/by-date?${WITH_COMPARE}&granularity=WEEK`)).json.data
    expect(data.points.map((point: { date: string }) => point.date)).toEqual(['2026-10-04', '2026-10-11'])
    expect(data.comparePoints).toBeNull()
    expect(data.compare).toBeNull()
    expect(data.compareNote).toContain('只支持按日')
    const [args] = prisma.salesTrafficDaily!.findMany!.mock.calls[0]!
    expect(args.where.granularity).toBe('WEEK')
    expect(args.where.date.gte.toISOString().slice(0, 10)).toBe('2026-10-04')
  })

  it('没选日期时月粒度默认最近 12 个月', async () => {
    const data = await read(`${BASE}/by-date?granularity=MONTH`)
    expect(data.range.defaulted).toBe(true)
    expect(data.range.from.endsWith('-01')).toBe(true)
  })
})

describe('按 ASIN', () => {
  const list = async (query = '') => {
    const { call } = await open()
    return call('GET', `${BASE}/by-asin?${CURRENT}${query}`)
  }

  it('默认按销售额从高到低；同键两个来源只用数据中心；比率用合计相除，缺值为空不是 0', async () => {
    const data = (await list()).json.data
    expect(data.level).toBe('CHILD')
    expect(data.items.map((item: { asin: string }) => item.asin)).toEqual(['B000000002', 'B000000001', 'B000000003', 'B000000004'])
    const first = data.items.find((item: { asin: string }) => item.asin === 'B000000001')
    expect(first).toMatchObject({ orderedSales: 300, unitsOrdered: 30, sessions: 600, unitSessionPct: 0.05, avgPrice: 10, buyBoxPct: 0.8, storeName: '美国主店' })
    expect(first).toMatchObject({ title: '护眼台灯', parentAsin: 'B00000000P', productId: 'p1' })
    const noSessions = data.items[0]
    expect(noSessions).toMatchObject({ orderedSales: 500, unitsOrdered: 10, sessions: null, unitSessionPct: null, avgPrice: 50, buyBoxPct: null, title: null, productId: null })
    expect(data.items.find((item: { asin: string }) => item.asin === 'B000000003')).toMatchObject({ unitsOrdered: 0, avgPrice: null, unitSessionPct: 0, storeName: '美国二店' })
    expect(data.items[3]).toMatchObject({ orderedSales: null, unitsOrdered: null, avgPrice: null })
  })

  it('升序排在最后的仍是没有值的行；按会话排序', async () => {
    const asc = (await list('&sort=orderedSales:asc')).json.data.items.map((item: { asin: string }) => item.asin)
    expect(asc).toEqual(['B000000003', 'B000000001', 'B000000002', 'B000000004'])
    const bySessions = (await list('&sort=sessions:desc')).json.data.items.map((item: { asin: string }) => item.asin)
    expect(bySessions).toEqual(['B000000001', 'B000000003', 'B000000002', 'B000000004'])
  })

  it('游标翻页：第二页接着第一页；条件变了游标失效 400；乱写的游标 400', async () => {
    const first = (await list('&pageSize=2')).json.data
    expect(first.items).toHaveLength(2)
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 4 })
    const second = (await list(`&pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).json.data
    expect(second.items.map((item: { asin: string }) => item.asin)).toEqual(['B000000003', 'B000000004'])
    expect(second.pageInfo).toMatchObject({ hasMore: false, nextCursor: null })
    expect((await list(`&pageSize=2&sort=sessions:desc&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
    expect((await list('&cursor=garbage')).status).toBe(400)
  })

  it('SKU 层级带 SKU 并按 SKU 找商品；搜索词进数据库条件；父体层级不查商品目录', async () => {
    const { call, prisma } = await open()
    const sku = (await call('GET', `${BASE}/by-asin?${CURRENT}&level=SKU&q=sku-1`)).json.data
    expect(sku.level).toBe('SKU')
    expect(JSON.stringify(prisma.salesTrafficAsinDaily!.groupBy!.mock.calls[0]![0].where)).toContain('sku-1')
    expect(prisma.fbaProduct!.findMany!).toHaveBeenCalled()
    prisma.fbaProduct!.findMany!.mockClear()
    await call('GET', `${BASE}/by-asin?${CURRENT}&level=PARENT`)
    expect(prisma.fbaProduct!.findMany!).not.toHaveBeenCalled()
  })

  it('没有数据：NO_DATA 与空列表', async () => {
    const { call } = await open(['analytics.read'], { empty: true })
    const data = (await call('GET', `${BASE}/by-asin?${CURRENT}`)).json.data
    expect(data).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(data.pageInfo).toMatchObject({ hasMore: false, approxTotal: 0 })
  })
})

describe('单个 ASIN 趋势', () => {
  it('逐日点：同日两个来源只用数据中心，没有记录的日子为空；ASIN 转大写并带商品标题', async () => {
    const { call, prisma } = await open()
    const data = (await call('GET', `${BASE}/trends?${CURRENT}&asin=b000000001`)).json.data
    expect(data).toMatchObject({ asin: 'B000000001', title: '护眼台灯', productId: 'p1', state: 'OK' })
    expect(data.points).toHaveLength(7)
    expect(data.points[1]).toMatchObject({ date: '2026-10-09', source: 'DATA_KIOSK', orderedSales: 100 })
    expect(data.points[0]).toMatchObject({ source: null, orderedSales: null })
    expect(prisma.salesTrafficAsinDaily!.findMany!.mock.calls[0]![0].where).toMatchObject({ asin: 'B000000001', asinGranularity: 'CHILD' })
  })

  it('没有记录：NO_DATA，标题为空', async () => {
    const { call } = await open(['analytics.read'], { empty: true }, { fbaProduct: { findMany: vi.fn().mockResolvedValue([]) } })
    const data = (await call('GET', `${BASE}/trends?${CURRENT}&asin=B000000009`)).json.data
    expect(data).toMatchObject({ state: 'NO_DATA', title: null, productId: null })
    expect(data.totals.orderedSales).toBeNull()
  })
})
