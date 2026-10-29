import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// ASIN 与父体分析接口（P4-03）：权限先于参数校验、父体树排序与分页、对比选中、逐日指标与空值、变体属性透视、各页签的权限与“尚未接入”。

const dec = (value: string) => ({ toString: () => value })
const day = (text: string) => new Date(`${text}T00:00:00Z`)
const PARENT = 'B0PARENT01'
const RANGE = 'from=2026-10-08&to=2026-10-14'
const ALL = ['analytics.read', 'inventory.read', 'ads.read', 'replenishment.read', 'profit.read', 'field.profit']

const product = (id: string, asin: string, parentAsin: string | null, attrs: Record<string, string> | null, over: Record<string, unknown> = {}) => ({
  id,
  sellerAccountId: 's1',
  sellerSku: `SKU-${id}`,
  asin,
  parentAsin,
  title: `商品 ${asin}`,
  brand: '甲牌',
  imageUrl: null,
  categoryPath: '家居',
  listingStatus: 'ACTIVE',
  catalogStatus: 'FOUND',
  variantAttributes: attrs,
  ownerUserId: null,
  tagIds: [],
  ...over,
})
const PRODUCTS = [
  product('p1', 'B0CHILD001', PARENT, { color: 'Red', size: 'L' }),
  product('p2', 'B0CHILD002', PARENT, { color: 'Red', size: 'S' }),
  product('p3', 'B0CHILD003', PARENT, { color: 'Blue', size: 'L' }),
  product('p4', 'B0SINGLE01', null, null, { listingStatus: 'INACTIVE' }),
  product('p5', 'B0OTHER001', 'B0PARENT02', null),
]

const row = (asin: string, date: string, over: Record<string, unknown> = {}) => ({
  asin,
  sellerAccountId: 's1',
  date: day(date),
  source: 'DATA_KIOSK',
  orderedSales: dec('100'),
  units: 10,
  ordersCount: 8,
  sessions: 200,
  pageViews: 400,
  buyBoxPct: dec('0.9'),
  unitSessionPct: dec('0.05'),
  ...over,
})
const DAILY = [
  row('B0CHILD001', '2026-10-09'),
  row('B0CHILD001', '2026-10-09', { source: 'REPORT', orderedSales: dec('999') }),
  row('B0CHILD002', '2026-10-09', { orderedSales: dec('50'), units: 5, sessions: 100 }),
  row('B0CHILD002', '2026-10-10', { orderedSales: dec('20'), units: 2, sessions: null }),
  row('B0CHILD003', '2026-10-10', { orderedSales: dec('30'), units: 3, sessions: 60 }),
]
const group = (asin: string, sales: string, sessions: number) => ({
  sellerAccountId: 's1',
  asin,
  sku: '',
  source: 'DATA_KIOSK',
  _sum: { orderedSales: dec(sales), units: 1, ordersCount: 1, sessions, pageViews: 1 },
  _avg: { buyBoxPct: null },
})
const GROUPS = [group('B0CHILD001', '300', 600), group('B0CHILD002', '100', 300), group('B0CHILD003', '50', 100), group('B0SINGLE01', '500', 1000), group('B0OTHER001', '10', 20)]

interface Options {
  ads?: 'none' | 'unsynced' | 'data'
  batch?: boolean
}
function stub(permissions: string[], options: Options = {}) {
  const base = sessionStub(permissions)
  const prisma: Record<string, unknown> = {
    ...base,
    membership: { ...base.membership, findMany: vi.fn().mockResolvedValue([]) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    fbaProduct: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { where: { OR?: Array<{ parentAsin?: string }> } }) =>
          args.where.OR ? PRODUCTS.filter(item => item.parentAsin === args.where.OR![0]!.parentAsin) : PRODUCTS,
        ),
    },
    productVariantRelation: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { where: { parentAsin: string } }) =>
          args.where.parentAsin === PARENT ? ['B0CHILD001', 'B0CHILD002', 'B0CHILD003', 'B0CHILD004'].map(childAsin => ({ childAsin, variationTheme: 'COLOR_SIZE' })) : [],
        ),
    },
    salesTrafficAsinDaily: {
      groupBy: vi.fn().mockResolvedValue(GROUPS),
      findMany: vi
        .fn()
        .mockImplementation(async (args: { where: { asin: { in: string[] }; date: { gte: Date; lte: Date } } }) =>
          DAILY.filter(item => args.where.asin.in.includes(item.asin) && item.date >= args.where.date.gte && item.date <= args.where.date.lte),
        ),
    },
    asinDailySummary: { findMany: vi.fn().mockResolvedValue([{ summaryDate: day('2026-10-09'), units: 5, adsSales: dec('20'), inventoryAvailable: 50 }]) },
    fbaReturnCase: { findFirst: vi.fn().mockResolvedValue({ id: 'r1' }), findMany: vi.fn().mockResolvedValue([{ returnDate: day('2026-10-09'), quantity: 1 }]) },
    salesRankSnapshot: {
      findMany: vi.fn().mockResolvedValue([
        { snapshotDate: day('2026-10-09'), rank: 120 },
        { snapshotDate: day('2026-10-09'), rank: 80 },
      ]),
    },
    profitDaily: { count: vi.fn().mockResolvedValue(2), aggregate: vi.fn().mockResolvedValue({ _sum: { profit: dec('12.345') }, _count: { profit: 1 } }) },
    fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([]) },
    replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(null) },
    replenishmentBatch: { findFirst: vi.fn().mockResolvedValue(options.batch ? { id: 'b1' } : null) },
    replenishmentRecommendation: { findMany: vi.fn().mockResolvedValue([]) },
    adsProfile: { findMany: vi.fn().mockResolvedValue(options.ads === 'none' || !options.ads ? [] : [{ id: 'ap1', sellerAccountId: 's1' }]) },
    adsAdvertisedProductMetric: {
      findFirst: vi.fn().mockResolvedValue(options.ads === 'data' ? { id: 'm1' } : null),
      groupBy: vi.fn().mockResolvedValue([{ advertisedAsin: 'B0CHILD001', _sum: { spend: dec('10'), sales: dec('50'), orders: 4 } }]),
    },
    adsAd: { groupBy: vi.fn().mockResolvedValue([{ asin: 'B0CHILD002', state: 'ENABLED', _count: { _all: 2 } }]) },
    entityEvent: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'e2',
          occurredAt: new Date('2026-10-12T01:00:00Z'),
          kind: 'variation.attribute_change',
          title: '变体属性 color 由「Red」变为「Rose」',
          detailJson: { before: 'Red', after: 'Rose', childAsin: 'B0CHILD001' },
          actorKind: 'AMAZON',
          actorId: null,
        },
        {
          id: 'e1',
          occurredAt: new Date('2026-10-11T01:00:00Z'),
          kind: 'variation.child_added',
          title: '新增子体 B0CHILD003',
          detailJson: { childAsin: 'B0CHILD003', before: null, after: PARENT },
          actorKind: 'AMAZON',
          actorId: null,
        },
      ]),
    },
  }
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[] = ['analytics.read'], options: Options = {}) => {
  const prisma = stub(permissions, options)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const read = async (path: string, permissions: string[] = ['analytics.read'], options: Options = {}) => {
  const { call } = await open(permissions, options)
  const response = await call('GET', path)
  expect(response.status).toBe(200)
  return response.json.data
}
const TABS = ['', '/matrix', '/trend', '/traffic', '/inventory', '/ads', '/reviews', '/changes']

describe('权限与参数', () => {
  it('未登录 401；没有 analytics.read 403 且先于参数校验，一条数据都不查', async () => {
    const { call } = await open()
    expect((await call('GET', '/analytics/asins', { auth: false })).status).toBe(401)
    expect((await call('GET', `/analytics/parents/${PARENT}`, { auth: false })).status).toBe(401)
    const denied = await open(['finance.read'])
    for (const path of ['/analytics/asins?select=bad&risk=NOPE', ...TABS.map(tab => `/analytics/parents/bad!${tab}?metric=nope&pivot=a`)]) {
      expect((await denied.call('GET', path)).status).toBe(403)
    }
    for (const model of ['fbaProduct', 'salesTrafficAsinDaily', 'productVariantRelation', 'entityEvent']) for (const mock of Object.values(denied.prisma[model]!)) expect(mock).not.toHaveBeenCalled()
  })

  it('页签权限：库存页签要 inventory.read、广告页签要 ads.read，缺了 403 且不查库；其余页签只要 analytics.read', async () => {
    const { call, prisma } = await open()
    for (const tab of ['/inventory', '/ads']) expect((await call('GET', `/analytics/parents/${PARENT}${tab}?metric=nope`)).status).toBe(403)
    expect(prisma.fbaProduct!.findMany!).not.toHaveBeenCalled()
    for (const tab of ['', '/matrix', '/trend', '/traffic', '/reviews', '/changes']) expect((await call('GET', `/analytics/parents/${PARENT}${tab}`)).status).toBe(200)
  })

  it('选中对象、父体编号、风险、指标、透视维度格式不对一律 422；范围内没有的父体 404', async () => {
    const { call } = await open()
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].map(letter => `asin:B0000000${letter}1`).join(',')
    for (const path of [
      '/analytics/asins?select=foo:bar',
      `/analytics/asins?select=${six}`,
      '/analytics/asins?risk=NOPE',
      '/analytics/asins?issue=NOPE',
      '/analytics/parents/short',
      `/analytics/parents/${PARENT}/matrix?metric=nope`,
      `/analytics/parents/${PARENT}/matrix?pivot=a`,
      `/analytics/parents/${PARENT}/matrix?pivot=a,a`,
    ]) {
      expect((await call('GET', path)).status).toBe(422)
    }
    expect((await call('GET', '/analytics/parents/B0NOPARENT')).status).toBe(404)
  })

  it('风险筛选要 inventory.read；每个查询都带企业条件，收窄到一个店铺时带店铺条件', async () => {
    const { call } = await open()
    expect((await call('GET', '/analytics/asins?risk=HIGH')).status).toBe(403)
    const scoped = stub(['analytics.read'])
    scoped.membershipScope = { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) }
    await harness?.close()
    harness = await createTestApp(scoped)
    expect((await harness.call('GET', `/analytics/asins?${RANGE}`)).status).toBe(200)
    expect((await harness.call('GET', `/analytics/parents/${PARENT}/matrix?${RANGE}`)).status).toBe(200)
    for (const mock of [scoped.fbaProduct!.findMany!, scoped.salesTrafficAsinDaily!.groupBy!, scoped.salesTrafficAsinDaily!.findMany!, scoped.productVariantRelation!.findMany!]) {
      for (const [args] of mock.mock.calls) expect(JSON.stringify(args.where)).toMatch(/tenant-1[\s\S]*s1/)
    }
  })
})

describe('父体树与选中', () => {
  it('树按销售额从高到低：没有父体的单独成项，父体 = 子体相加，子体按销售额排序', async () => {
    const data = await read(`/analytics/asins?${RANGE}`)
    expect(data.tree.map((node: { key: string }) => node.key)).toEqual(['asin:B0SINGLE01', `parent:${PARENT}`, 'parent:B0PARENT02'])
    const parent = data.tree[1]
    expect(parent).toMatchObject({ kind: 'parent', childCount: 3, sales: 450, sessions: 1000 })
    expect(parent.children.map((child: { asin: string }) => child.asin)).toEqual(['B0CHILD001', 'B0CHILD002', 'B0CHILD003'])
    expect(data.filters).toMatchObject({ brands: ['甲牌'], categories: ['家居'], tags: [], owners: [] })
  })

  it('没有指定选中对象时默认选销售额最高的一项；游标分页并校验条件绑定', async () => {
    const { call } = await open()
    const first = (await call('GET', `/analytics/asins?${RANGE}&pageSize=1`)).json.data
    expect(first.selectionDefaulted).toBe(true)
    expect(first.selection[0]).toMatchObject({ key: 'asin:B0SINGLE01' })
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 3 })
    const second = (await call('GET', `/analytics/asins?${RANGE}&pageSize=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).json.data
    expect(second.tree[0].key).toBe(`parent:${PARENT}`)
    expect((await call('GET', `/analytics/asins?${RANGE}&pageSize=1&q=x&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
  })

  it('筛选：关键词、刊登状态都先在商品目录上做，树里只剩符合条件的', async () => {
    expect((await read(`/analytics/asins?${RANGE}&issue=INACTIVE`)).tree.map((node: { key: string }) => node.key)).toEqual(['asin:B0SINGLE01'])
    expect((await read(`/analytics/asins?${RANGE}&q=child002`)).tree.map((node: { key: string }) => node.key)).toEqual([`parent:${PARENT}`])
  })

  it('对比模式：父体与子体并排；父体逐日相加、来源只用数据中心；没有记录的值是 null', async () => {
    const data = await read(`/analytics/asins?${RANGE}&select=parent:${PARENT},asin:B0CHILD001`, ALL)
    expect(data.selectionDefaulted).toBe(false)
    const [parent, child] = data.selection
    expect(parent).toMatchObject({ key: `parent:${PARENT}`, memberCount: 4 })
    expect(parent.points).toHaveLength(7)
    expect(parent.points[0]).toMatchObject({ date: '2026-10-08', sales: null, units: null, conversion: null, price: null })
    expect(parent.points[1]).toMatchObject({ date: '2026-10-09', sales: 150, units: 15, sessions: 300, adsSales: 20, organicSales: 130, daysOfSupply: 20 })
    expect(parent.points[1].returnRate).toBeCloseTo(1 / 15, 5)
    expect(parent.totals).toMatchObject({ sales: 200, units: 20, sessions: 360, conversion: 0.05, adsSales: 20, organicSales: 180, salesRank: null })
    expect(parent.gaps.salesRank).toContain('父体没有自己的销售排名')
    expect(child.totals).toMatchObject({ sales: 100, salesRank: 80 })
  })

  it('广告、退货、库存没有来源时对应指标为 null 并写明原因', async () => {
    const { call, prisma } = await open()
    prisma.asinDailySummary!.findMany!.mockResolvedValue([])
    prisma.fbaReturnCase!.findFirst!.mockResolvedValue(null)
    const data = (await call('GET', `/analytics/asins?${RANGE}&select=asin:B0CHILD001`)).json.data
    expect(data.selection[0].totals).toMatchObject({ sales: 100, adsSales: null, organicSales: null, returnRate: null, daysOfSupply: null })
    expect(Object.keys(data.selection[0].gaps).sort()).toEqual(['adsSales', 'daysOfSupply', 'organicSales', 'returnRate'])
  })
})

describe('父体详情', () => {
  it('身份区：子体数、销售额、转化率；净利润与库存风险没有权限时是受限，不是 0', async () => {
    const plain = await read(`/analytics/parents/${PARENT}?${RANGE}`)
    expect(plain).toMatchObject({ parentAsin: PARENT, childCount: 4, sales: 200, conversion: 0.05, brand: '甲牌', category: '家居', variationTheme: 'COLOR_SIZE', storeNames: ['美国主店'] })
    expect(plain.netProfit).toMatchObject({ state: 'RESTRICTED', value: null })
    expect(plain.riskChildren).toMatchObject({ state: 'RESTRICTED', value: null })
    const full = await read(`/analytics/parents/${PARENT}?${RANGE}`, ALL)
    expect(full.netProfit).toMatchObject({ state: 'OK', value: 12.35 })
    expect(full.netProfit.note).toContain('1 / 2')
    expect(full.riskChildren.state).toBe('NO_DATA')
  })

  it('子体贡献矩阵：按销售额排序、占比、变体属性透视（没填的归“未填写”）、可改透视维度', async () => {
    const data = await read(`/analytics/parents/${PARENT}/matrix?${RANGE}`)
    expect(data.rows.map((item: { asin: string }) => item.asin)).toEqual(['B0CHILD001', 'B0CHILD002', 'B0CHILD003', 'B0CHILD004'])
    expect(data.rows[0]).toMatchObject({ sales: 100, share: 0.5, conversion: 0.05, risk: null })
    expect(data.rows[3]).toMatchObject({ title: null, sales: null, share: null })
    expect(data.scale).toEqual({ min: 30, max: 100 })
    expect(data.riskState.state).toBe('RESTRICTED')
    expect(data.pivot).toMatchObject({ state: 'OK', dimensions: ['color', 'size'], rowDim: 'color', colDim: 'size' })
    expect(data.pivot.rowValues).toEqual(['Red', 'Blue', '未填写'])
    expect(data.pivot.cells.find((cell: { row: string; col: string }) => cell.row === 'Red' && cell.col === 'S')).toMatchObject({ sales: 70, asins: ['B0CHILD002'] })
    const swapped = await read(`/analytics/parents/${PARENT}/matrix?${RANGE}&pivot=size,color&metric=risk`, ALL)
    expect(swapped.pivot).toMatchObject({ rowDim: 'size', colDim: 'color' })
    expect(swapped.scale).toBeNull()
    expect(swapped.riskState.state).toBe('NO_DATA')
    expect((await read(`/analytics/parents/${PARENT}/matrix?${RANGE}&pivot=foo,bar`)).pivot.note).toContain('所选维度不在')
  })

  it('子体趋势逐日对齐，没有记录的日子为 null', async () => {
    const data = await read(`/analytics/parents/${PARENT}/trend?${RANGE}`)
    expect(data.dates).toHaveLength(7)
    expect(data.series.map((item: { asin: string }) => item.asin)).toEqual(['B0CHILD001', 'B0CHILD002', 'B0CHILD003', 'B0CHILD004'])
    expect(data.series[0].sales).toEqual([null, 100, null, null, null, null, null])
    expect(data.series[1].sessions).toEqual([null, 100, null, null, null, null, null])
    expect(data.others).toBeNull()
  })

  it('流量分布：占比，对比期没有记录时对比与变化为 null', async () => {
    const data = await read(`/analytics/parents/${PARENT}/traffic?${RANGE}&compare=previous`)
    expect(data.totalSessions).toBe(360)
    expect(data.rows[0]).toMatchObject({ asin: 'B0CHILD001', sessions: 200, compareSessions: null, shareChange: null })
    expect(data.rows[0].share).toBeCloseTo(0.555556, 5)
    expect(data.compareRange).toMatchObject({ from: '2026-10-01', to: '2026-10-07' })
    expect(data.compareTotalSessions).toBeNull()
  })

  it('库存与补货：没有策略与库存记录时说明原因；没有补货读取权限时补货部分受限', async () => {
    const limited = await read(`/analytics/parents/${PARENT}/inventory?${RANGE}`, ['analytics.read', 'inventory.read'])
    expect(limited).toMatchObject({ policyState: 'NOT_CONNECTED', replenishmentState: 'RESTRICTED', state: 'NO_DATA' })
    expect(limited.rows).toHaveLength(4)
    expect(limited.rows[0]).toMatchObject({ sellable: null, risk: null, recommendedQty: null })
    expect((await read(`/analytics/parents/${PARENT}/inventory?${RANGE}`, ALL)).replenishmentState).toBe('NO_DATA')
    expect((await read(`/analytics/parents/${PARENT}/inventory?${RANGE}`, ALL, { batch: true })).replenishmentState).toBe('OK')
  })

  it('广告覆盖：没有绑定账户或日报表没同步是“尚未接入”（不当成没投广告）；有数据时标出覆盖缺口', async () => {
    const none = await read(`/analytics/parents/${PARENT}/ads?${RANGE}`, ALL, { ads: 'none' })
    expect(none).toMatchObject({ adsState: 'NOT_CONNECTED', rows: [], coveredCount: 0 })
    expect(none.adsNote).toContain('还没有绑定广告账户')
    const unsynced = await read(`/analytics/parents/${PARENT}/ads?${RANGE}`, ALL, { ads: 'unsynced' })
    expect(unsynced).toMatchObject({ adsState: 'NOT_CONNECTED', rows: [] })
    expect(unsynced.adsNote).toContain('日报表还没有同步')
    const data = await read(`/analytics/parents/${PARENT}/ads?${RANGE}`, ALL, { ads: 'data' })
    expect(data).toMatchObject({ adsState: 'OK', coveredCount: 1, gapCount: 1, totalSpend: 10, totalAdsSales: 50 })
    const byAsin = Object.fromEntries(data.rows.map((item: { asin: string }) => [item.asin, item]))
    expect(byAsin.B0CHILD001).toMatchObject({ coverage: 'COVERED', acos: 0.2, totalSales: 100, adsShare: 0.5, gap: false })
    expect(byAsin.B0CHILD002).toMatchObject({ coverage: 'NO_SPEND', enabledAds: 2, gap: false })
    expect(byAsin.B0CHILD003).toMatchObject({ coverage: 'NO_ADS', gap: true })
    expect(byAsin.B0CHILD004).toMatchObject({ coverage: 'NO_ADS', totalSales: null, gap: false })
  })

  it('评论主题尚未接入；变体结构变更历史按时间倒序带前后值与来源', async () => {
    const reviews = await read(`/analytics/parents/${PARENT}/reviews?${RANGE}`)
    expect(reviews).toMatchObject({ reviewsState: 'NOT_CONNECTED', positive: [], negative: [] })
    expect(reviews.reviewsNote).toContain('P4-13')
    const changes = await read(`/analytics/parents/${PARENT}/changes`)
    expect(changes.items.map((item: { id: string }) => item.id)).toEqual(['e2', 'e1'])
    expect(changes.items[0]).toMatchObject({ kindLabel: '变体属性变化', before: 'Red', after: 'Rose', childAsin: 'B0CHILD001', actor: '亚马逊' })
    expect(changes.items[1]).toMatchObject({ kindLabel: '新增子体', before: null, after: PARENT })
    expect(changes.note).toBeNull()
  })
})
