import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 订阅省接口（P4-06）：权限先于参数校验、数据范围、只读（没有写入口）、概览（指标卡、趋势、对比期、读取上限）、
// 没有数据时的四种原因（未开通 / 角色没批 / 尚未同步 / 尚无记录）、ASIN 明细与报价列表（合并、筛选、排序、游标、过期快照、补货采用原因）。

const day = (text: string) => new Date(`${text}T00:00:00Z`)
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const TODAY = '2026-10-24'

const metric = (metricDate: string, over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  granularity: 'DAY',
  metricDate: day(metricDate),
  activeSubscribers: 40,
  shippedUnits: 10,
  revenue: '199.9',
  currency: 'USD',
  ...over,
})
const offerRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  sellerAccountId: 's1',
  snapshotDate: day('2026-10-23'),
  sku: 'SKU-A',
  asin: 'B0AAAAAAA1',
  eligibility: 'ELIGIBLE',
  fulfillment: 'AMAZON',
  sellerFundedBasePct: '10',
  price: '19.99',
  currency: 'USD',
  inventory: 120,
  stockRisk: null,
  subscriptions: 30,
  forecastNext30: 90,
  forecastNext60: 170,
  forecastNext90: 240,
  shippedUnitsPrevMonth: 60,
  prevMonthDays: 30,
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const freshness = (over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  sourceKey: 'replenishment.api',
  lastAttemptAt: new Date(),
  lastSuccessAt: new Date(),
  dataThrough: null,
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})

const defaultMetrics = () => [
  metric(shift(TODAY, -3)),
  metric(shift(TODAY, -2), { shippedUnits: 12, revenue: '239.88', activeSubscribers: 41 }),
  metric(shift(TODAY, -40), { granularity: 'MONTH', shippedUnits: 300, revenue: '5000' }),
  // 对比期（前 30 天）里的一行
  metric(shift(TODAY, -35), { shippedUnits: 8, revenue: '100' }),
]
const defaultOffers = () => [
  offerRow(),
  offerRow({ id: 'o2', sku: 'SKU-B', asin: 'B0AAAAAAA1', subscriptions: 5, forecastNext30: 10, forecastNext60: null, forecastNext90: null }),
  offerRow({ id: 'o3', sku: 'SKU-C', asin: 'B0AAAAAAA2', eligibility: 'SUSPENDED', subscriptions: null, forecastNext30: null, forecastNext60: null, forecastNext90: null }),
]

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  return {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    subscribeSaveMetric: { findMany: vi.fn().mockResolvedValue(defaultMetrics()) },
    subscribeSaveOffer: {
      groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { snapshotDate: day('2026-10-23') } }]),
      findMany: vi.fn().mockResolvedValue(defaultOffers()),
    },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([{ id: 'p1', sellerAccountId: 's1', asin: 'B0AAAAAAA1' }]) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([freshness()]) },
    ...over,
  } as unknown as Record<string, ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>>
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[], over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}

describe('权限、范围与只读', () => {
  it('未登录 401；没有 analytics.read 时三个接口都 403（先于参数校验）', async () => {
    const { call } = await open(['analytics.read'])
    expect((await call('GET', '/subscribe-save', { auth: false })).status).toBe(401)
    await harness?.close()
    const denied = await open(['seller.read'])
    for (const path of ['/subscribe-save?from=bad', '/subscribe-save/asins?pageSize=99999', '/subscribe-save/offers?eligibility=x']) expect((await denied.call('GET', path)).status, path).toBe(403)
    expect(denied.prisma.subscribeSaveMetric.findMany).not.toHaveBeenCalled()
    expect(denied.prisma.subscribeSaveOffer.findMany).not.toHaveBeenCalled()
  })

  it('没有写入口：POST、PATCH、PUT、DELETE 都不存在', async () => {
    const { call } = await open(['analytics.read'])
    for (const path of ['/subscribe-save', '/subscribe-save/offers', '/subscribe-save/asins']) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) expect((await call(method, path, { body: {} })).status, `${method} ${path}`).toBe(404)
    }
  })

  it('查询一律带企业条件；数据范围收窄到一个店铺时三类读取都按店铺过滤', async () => {
    const scoped = { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } }
    const { call, prisma } = await open(['analytics.read'], scoped)
    expect((await call('GET', '/subscribe-save')).status).toBe(200)
    expect((await call('GET', '/subscribe-save/offers')).status).toBe(200)
    for (const mock of [prisma.subscribeSaveMetric.findMany, prisma.subscribeSaveOffer.groupBy, prisma.dataFreshness.findMany]) {
      expect(JSON.stringify(mock.mock.calls[0][0].where), mock.getMockName()).toMatch(/tenant-1[\s\S]*s1/)
    }
  })
})

describe('概览', () => {
  it('指标卡、对比期、趋势、月度、预计出货依据；取消数永远是尚未接入', async () => {
    const { call } = await open(['analytics.read'])
    const res = await call('GET', '/subscribe-save')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.state).toBe('OK')
    expect(data.range).toEqual({ from: shift(TODAY, -29), to: TODAY, days: 30, defaulted: true })
    expect(data.compare).toMatchObject({ from: shift(TODAY, -59), to: shift(TODAY, -30) })
    const card = (key: string) => data.cards.find((item: { key: string }) => item.key === key)
    expect(card('activeSubscribers')).toMatchObject({ state: 'OK', value: 41, note: `截至 ${shift(TODAY, -2)}` })
    expect(card('shippedUnits')).toMatchObject({ state: 'OK', value: 22, previous: 8 })
    expect(card('revenue')).toMatchObject({ state: 'OK', value: 439.78, currency: 'USD', previous: 100, others: [] })
    expect(card('cancellations')).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(card('forecast30')).toMatchObject({ state: 'OK', value: 100 })
    expect(card('forecast60')).toMatchObject({ state: 'OK', value: 170 })
    expect(card('offers')).toMatchObject({ value: 3, note: '可订阅 2，不可订阅或已暂停 1' })
    expect(data.trend.currency).toBe('USD')
    expect(data.trend.points).toHaveLength(30)
    expect(data.trend.coverage).toEqual({ dataDays: 2, rangeDays: 30 })
    expect(data.trend.points.find((point: { date: string }) => point.date === shift(TODAY, -2))).toMatchObject({ shippedUnits: 12, revenue: 239.88, activeSubscribers: 41 })
    expect(data.trend.points.find((point: { date: string }) => point.date === shift(TODAY, -1))).toMatchObject({ shippedUnits: null, revenue: null })
    expect(data.trend.months).toEqual([{ month: shift(TODAY, -40).slice(0, 7), activeSubscribers: 40, shippedUnits: 300, revenue: 5000 }])
    expect(data.forecast).toMatchObject({ snapshotDate: '2026-10-23', offers: 3, offersWithForecast: 2, staleStores: [], usedInReplenishment: 2 })
    expect(data.sync).toMatchObject({ status: 'NORMAL', rolePending: false })
    expect(data.basis).toContain('不当 0')
    expect(data.replenishNote).toContain('补货建议')
  })

  it('选了日期范围就用所选；读取日级指标时带上对比期的起点', async () => {
    const { call, prisma } = await open(['analytics.read'])
    const from = shift(TODAY, -6)
    const res = await call('GET', `/subscribe-save?from=${from}&to=${shift(TODAY, -1)}&compare=previous`)
    expect(res.json.data.range).toMatchObject({ from, to: shift(TODAY, -1), days: 6, defaulted: false })
    expect(res.json.data.trend.points).toHaveLength(6)
    expect(JSON.stringify(prisma.subscribeSaveMetric.findMany.mock.calls[0][0].where)).toContain(`${shift(from, -6)}T00:00:00.000Z`)
  })

  it('对比期没有记录时不给“对比值”，而不是 0', async () => {
    const { call } = await open(['analytics.read'], { subscribeSaveMetric: { findMany: vi.fn().mockResolvedValue([metric(shift(TODAY, -2))]) } })
    const data = (await call('GET', '/subscribe-save')).json.data
    expect(data.cards.find((item: { key: string }) => item.key === 'shippedUnits').previous).toBeNull()
  })

  it('不同币种不相加：金额最大的币种进卡，其余列在 others', async () => {
    const rows = [metric(shift(TODAY, -3)), metric(shift(TODAY, -2), { currency: 'CAD', revenue: '50' })]
    const { call } = await open(['analytics.read'], { subscribeSaveMetric: { findMany: vi.fn().mockResolvedValue(rows) } })
    const revenue = (await call('GET', '/subscribe-save')).json.data.cards.find((item: { key: string }) => item.key === 'revenue')
    expect(revenue).toMatchObject({ value: 199.9, currency: 'USD', others: [{ currency: 'CAD', amount: 50 }] })
  })

  it('快照超过 7 天：预测卡写“数据已过期”，不沿用旧预测；补货采用数为 0', async () => {
    const old = [offerRow({ snapshotDate: day('2026-10-10') })]
    const { call } = await open(['analytics.read'], {
      subscribeSaveOffer: { groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { snapshotDate: day('2026-10-10') } }]), findMany: vi.fn().mockResolvedValue(old) },
    })
    const data = (await call('GET', '/subscribe-save')).json.data
    expect(data.cards.find((item: { key: string }) => item.key === 'forecast30')).toMatchObject({ state: 'STALE', value: null })
    expect(data.forecast).toMatchObject({ staleStores: ['美国主店'], usedInReplenishment: 0 })
  })

  it('读取量超过上限：标记 truncated', async () => {
    const many = Array.from({ length: 20_000 }, (_, index) => metric(shift(TODAY, -(index % 20)), { sellerAccountId: `s${index}` }))
    const { call, prisma } = await open(['analytics.read'], { subscribeSaveMetric: { findMany: vi.fn().mockResolvedValue(many) } })
    const data = (await call('GET', '/subscribe-save')).json.data
    expect(data.truncated).toBe(true)
    expect(prisma.subscribeSaveMetric.findMany.mock.calls[0][0].take).toBe(20_000)
  })
})

describe('没有数据时的原因', () => {
  const emptyOver = (rows: unknown[]) => ({
    subscribeSaveMetric: { findMany: vi.fn().mockResolvedValue([]) },
    subscribeSaveOffer: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue(rows) },
  })

  it.each([
    ['没开通订阅省', [freshness({ status: 'NOT_APPLICABLE' })], 'NOT_APPLICABLE', '没有开通订阅省'],
    ['接口角色没批', [freshness({ status: 'UNAUTHORIZED', lastErrorCode: 'ROLE_MISSING', lastSuccessAt: null })], 'ROLE_PENDING', '开发者控制台'],
    ['还没同步过', [], 'NOT_CONNECTED', '尚未同步'],
    ['同步正常但没有记录', [freshness()], 'NO_DATA', '尚无记录'],
  ])('%s：三个接口的状态与说明一致，没有示例行', async (_name, rows, state, text) => {
    const { call } = await open(['analytics.read'], emptyOver(rows))
    for (const path of ['/subscribe-save', '/subscribe-save/asins', '/subscribe-save/offers']) {
      const data = (await call('GET', path)).json.data
      expect(data.state, path).toBe(state)
      expect(data.note, path).toContain(text)
      if (path !== '/subscribe-save') expect(data.items, path).toEqual([])
    }
    const cards = (await call('GET', '/subscribe-save')).json.data.cards as Array<{ value: number | null }>
    expect(cards.every(card => card.value === null)).toBe(true)
  })
})

describe('ASIN 明细', () => {
  it('同店铺同 ASIN 的 SKU 合并；默认按未来 30 天预计出货从大到小；带 ASIN 360 编号与补货采用情况', async () => {
    const { call } = await open(['analytics.read'])
    const res = await call('GET', '/subscribe-save/asins')
    expect(res.status).toBe(200)
    const { items, snapshotDate, staleStores } = res.json.data
    expect(snapshotDate).toBe('2026-10-23')
    expect(staleStores).toEqual([])
    expect(items.map((row: { asin: string }) => row.asin)).toEqual(['B0AAAAAAA1', 'B0AAAAAAA2'])
    expect(items[0]).toMatchObject({ skus: ['SKU-A', 'SKU-B'], subscriptions: 35, forecastNext30: 100, forecastNext60: 170, productId: 'p1', replenishment: { used: true, reason: null } })
    expect(items[1]).toMatchObject({ subscriptions: null, forecastNext30: null, productId: null, replenishment: { used: false, reason: 'INELIGIBLE' } })
  })

  it('搜索、排序（没有值的排最后）、游标翻页不重不漏；非法排序 422；换了条件的旧游标 400', async () => {
    const { call } = await open(['analytics.read'])
    expect((await call('GET', '/subscribe-save/asins?q=aaa2')).json.data.items).toHaveLength(1)
    const asc = (await call('GET', '/subscribe-save/asins?sort=forecastNext30:asc')).json.data.items.map((row: { asin: string }) => row.asin)
    expect(asc).toEqual(['B0AAAAAAA1', 'B0AAAAAAA2'])
    const first = (await call('GET', '/subscribe-save/asins?pageSize=1')).json.data
    expect(first.items).toHaveLength(1)
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 2 })
    const second = (await call('GET', `/subscribe-save/asins?pageSize=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).json.data
    expect([...first.items, ...second.items].map((row: { asin: string }) => row.asin)).toEqual(['B0AAAAAAA1', 'B0AAAAAAA2'])
    expect(second.pageInfo.hasMore).toBe(false)
    expect((await call('GET', '/subscribe-save/asins?sort=price:asc')).status).toBe(422)
    expect((await call('GET', `/subscribe-save/asins?pageSize=1&q=x&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
    expect((await call('GET', '/subscribe-save/asins?cursor=garbage')).status).toBe(400)
  })

  it('筛选后没有结果：状态是尚无记录并提示放宽条件，不显示成“未开通”', async () => {
    const { call } = await open(['analytics.read'])
    const data = (await call('GET', '/subscribe-save/asins?q=zzzz')).json.data
    expect(data).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(data.note).toContain('放宽筛选条件')
  })
})

describe('报价参与列表', () => {
  it('每个店铺 SKU 一行：可订阅状态中文、折扣、价格、库存、补货采用原因', async () => {
    const { call } = await open(['analytics.read'])
    const { items } = (await call('GET', '/subscribe-save/offers')).json.data
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ sku: 'SKU-A', eligibilityLabel: '可订阅', discountPct: 10, price: 19.99, currency: 'USD', inventory: 120, storeName: '美国主店', replenishment: { used: true } })
    const suspended = items.find((row: { sku: string }) => row.sku === 'SKU-C')
    expect(suspended).toMatchObject({ eligibilityLabel: '已暂停', forecastNext30: null, replenishment: { used: false, reason: 'INELIGIBLE' } })
  })

  it('按可订阅状态筛选与按价格排序；非法状态 422', async () => {
    const { call } = await open(['analytics.read'])
    const only = (await call('GET', '/subscribe-save/offers?eligibility=SUSPENDED')).json.data.items
    expect(only.map((row: { sku: string }) => row.sku)).toEqual(['SKU-C'])
    expect((await call('GET', '/subscribe-save/offers?sort=price:asc')).status).toBe(200)
    expect((await call('GET', '/subscribe-save/offers?eligibility=x')).status).toBe(422)
  })

  it('快照过期的店铺：行仍显示，补货一列写“已超过 7 天”，页面能拿到店名', async () => {
    const old = [offerRow({ snapshotDate: day('2026-10-10') })]
    const { call } = await open(['analytics.read'], {
      subscribeSaveOffer: { groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { snapshotDate: day('2026-10-10') } }]), findMany: vi.fn().mockResolvedValue(old) },
    })
    const data = (await call('GET', '/subscribe-save/offers')).json.data
    expect(data.staleStores).toEqual(['美国主店'])
    expect(data.items[0].replenishment).toEqual({ used: false, reason: 'STALE' })
  })

  it('读取每个店铺最近一次快照：先按店铺取最新日期，再只读这些日期的报价', async () => {
    const { call, prisma } = await open(['analytics.read'])
    await call('GET', '/subscribe-save/offers')
    expect(JSON.stringify(prisma.subscribeSaveOffer.findMany.mock.calls[0][0].where)).toContain('2026-10-23T00:00:00.000Z')
    expect(prisma.subscribeSaveOffer.findMany.mock.calls[0][0].take).toBe(20_000)
  })
})
