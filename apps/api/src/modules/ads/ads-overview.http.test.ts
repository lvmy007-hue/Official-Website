import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 广告控制台接口（P3-05）：权限与参数、尚未接入与没有记录的状态、真实数据下的指标口径、范围收窄。
// 数据读取用内存替身，按 groupBy 的分组字段分发；真实数据库的行为见 testing/ads-overview.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const dec = (value: number | null) => (value === null ? null : { toString: () => String(value) })
const sum = (impressions: number, clicks: number, spend: number | null, sales: number | null, orders: number) => ({ impressions, clicks, spend: dec(spend), sales: dec(sales), orders })
const day = (date: string, adProduct: string, values: ReturnType<typeof sum>) => ({ summaryDate: new Date(`${date}T00:00:00Z`), adProduct, _sum: values })

interface StubOptions {
  ever?: boolean
  daily?: unknown[]
  campaigns?: unknown[]
  others?: unknown[]
  /** 对比期合计（aggregate 且没有未绑定条件时返回） */
  previous?: { _sum: ReturnType<typeof sum>; _count: { _all: number } }
  unbound?: number | null
  storeRows?: unknown[]
  storePrevious?: { _sum: { salesAmount: unknown; adsSpend: unknown; adsSales: unknown }; _count: { _all: number } }
  budgeted?: unknown[]
  unknownBudget?: number
  scopedTo?: string[]
}

function prismaFor(permissions: string[], options: StubOptions = {}) {
  const empty = { _sum: sum(0, 0, null, null, 0), _count: { _all: 0 } }
  const groupBy = vi.fn(async (args: { by: string[] }) => {
    const by = args.by.join(',')
    if (by === 'summaryDate,adProduct') return options.daily ?? []
    if (by === 'currency') return options.others ?? []
    if (by === 'adsProfileId,adProduct,campaignId') return options.campaigns ?? []
    return []
  })
  // 未绑定账户的花费查询带 adsProfile.sellerAccountId = null；其余聚合是对比期合计
  const aggregate = vi.fn(async (args: { where: { adsProfile?: { sellerAccountId?: unknown } } }) =>
    args.where.adsProfile?.sellerAccountId === null ? { _sum: { spend: dec(options.unbound ?? null) } } : (options.previous ?? empty),
  )
  return {
    ...sessionStub(permissions),
    ...(options.scopedTo ? { membershipScope: { findMany: vi.fn().mockResolvedValue(options.scopedTo.map(id => ({ legalEntityId: null, sellerAccountId: id }))) } } : {}),
    sellerAccount: { findMany: vi.fn().mockResolvedValue((options.scopedTo ?? ['s1', 's2']).map(id => ({ id }))) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    adsDailySummary: {
      groupBy,
      aggregate,
      findFirst: vi.fn(async (args: { select: Record<string, boolean> }) => {
        if (args.select.id) return options.ever ? { id: 'x' } : null
        return options.daily?.length ? { refreshedAt: new Date('2026-10-12T00:00:00Z'), metricVersion: 'ads.v1' } : null
      }),
    },
    adsCampaign: {
      findMany: vi.fn(async (args: { where: { budgetType?: unknown } }) =>
        args.where.budgetType === 'DAILY' ? (options.budgeted ?? []) : [{ adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', externalCampaignId: 'c1', name: '春季推广' }],
      ),
      count: vi.fn().mockResolvedValue(options.unknownBudget ?? 0),
    },
    storeDailySummary: {
      groupBy: vi.fn().mockResolvedValue(options.storeRows ?? []),
      aggregate: vi.fn().mockResolvedValue(options.storePrevious ?? { _sum: { salesAmount: null, adsSpend: null, adsSales: null }, _count: { _all: 0 } }),
    },
    entityEvent: { findMany: vi.fn().mockResolvedValue([{ occurredAt: new Date('2026-10-05T12:00:00Z'), title: '调整预算', kind: 'ADS_CHANGE' }]) },
  }
}

const RANGE = '?from=2026-10-01&to=2026-10-10&compare=previous'
const get = async (stub: ReturnType<typeof prismaFor>, query = RANGE) => {
  harness = await createTestApp(stub)
  return harness.call('GET', `/ads/overview${query}`)
}
const cardOf = (data: { cards: Array<{ key: string }> }, key: string) => data.cards.find(card => card.key === key) as Record<string, unknown>

describe('广告控制台接口：权限与参数', () => {
  it('未登录 401，没有 ads.read 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/overview', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/overview')).status).toBe(403)
  })

  it('没有权限先于参数校验：参数不合法也先返回 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/overview?granularity=year')).status).toBe(403)
  })

  it('参数不合法 422：粒度、日期范围倒置、站点不是美国站', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    for (const query of ['?granularity=year', '?from=2026-10-10&to=2026-10-01', '?marketplaceId=A1F83G8C2ARO7P']) {
      expect((await harness.call('GET', `/ads/overview${query}`)).status, query).toBe(422)
    }
  })

  it('没有任何数据授权返回 403', async () => {
    harness = await createTestApp({ ...prismaFor(['ads.read']), membershipScope: { findMany: vi.fn().mockResolvedValue([]) } })
    expect((await harness.call('GET', '/ads/overview')).status).toBe(403)
  })
})

describe('广告控制台接口：没有数据时如实标注', () => {
  it('从来没有广告汇总：整体“尚未接入”，指标卡没有任何数字，光环销售额也是尚未接入', async () => {
    const res = await get(prismaFor(['ads.read']))
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ state: 'NOT_CONNECTED', currency: 'USD', refreshedAt: null, unboundSpend: null })
    expect(data.cards).toHaveLength(12)
    for (const key of ['spend', 'sales', 'acos', 'roas', 'ctr', 'cpc', 'cvr']) expect(cardOf(data, key), key).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(cardOf(data, 'haloSales')).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(cardOf(data, 'adsShare')).toMatchObject({ state: 'NO_DATA', value: null })
    expect(data.trend.points).toEqual([])
    expect(data.funnel).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(data.products.map((row: { state: string }) => row.state)).toEqual(['NO_DATA', 'NOT_CONNECTED', 'NOT_CONNECTED', 'NOT_CONNECTED'])
    expect(data.targetAcos.state).toBe('NOT_CONNECTED')
    expect(data.budget.overBudget.state).toBe('NOT_CONNECTED')
    expect(data.attribution).toMatchObject({ state: 'NOT_CONNECTED', spend: null, sales: null })
  })

  it('以前有过记录但所选范围没有：整体“尚无记录”（不是尚未接入）', async () => {
    const res = await get(prismaFor(['ads.read'], { ever: true }))
    expect(res.json.data.state).toBe('NO_DATA')
    expect(cardOf(res.json.data, 'spend')).toMatchObject({ state: 'NO_DATA', value: null })
  })

  it('没有带日预算的活动：预算利用率尚无记录，说明预算类型没同步的数量', async () => {
    const res = await get(prismaFor(['ads.read'], { ever: true, unknownBudget: 3 }))
    expect(res.json.data.budget).toMatchObject({ state: 'NO_DATA', utilization: null, dailyBudgetTotal: null })
    expect(res.json.data.budget.note).toContain('3 个活动')
  })
})

const DAILY = [
  day('2026-10-01', 'SPONSORED_PRODUCTS', sum(1000, 50, 40, 160, 5)),
  day('2026-10-02', 'SPONSORED_PRODUCTS', sum(2000, 100, 60, 240, 8)),
  day('2026-10-02', 'SPONSORED_BRANDS', sum(500, 10, 10, null, 0)),
]
const CAMPAIGNS = [
  { adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c1', _sum: sum(2000, 100, 70, 280, 9) },
  { adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c2', _sum: sum(1000, 60, 40, 0, 0) },
  { adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c3', _sum: sum(500, 5, 6, 12, 1) },
]
const STORE = [
  { summaryDate: new Date('2026-10-01T00:00:00Z'), _sum: { salesAmount: dec(400), adsSpend: dec(40), adsSales: dec(160) } },
  { summaryDate: new Date('2026-10-02T00:00:00Z'), _sum: { salesAmount: dec(600), adsSpend: dec(60), adsSales: dec(240) } },
]

describe('广告控制台接口：有数据', () => {
  it('指标按口径计算：花费、销售额、ACoS、ROAS、点击率、单次点击成本、转化率；比率为空不是 0', async () => {
    const res = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY, campaigns: CAMPAIGNS, storeRows: STORE }))
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    expect(data.refreshedAt).toBe('2026-10-12T00:00:00.000Z')
    // 合计：曝光 3500、点击 160、花费 110、销售额 400（品牌推广那天没给销售额，不当 0 加）、订单 13
    expect(cardOf(data, 'spend')).toMatchObject({ state: 'OK', value: 110 })
    expect(cardOf(data, 'sales')).toMatchObject({ state: 'OK', value: 400 })
    expect(cardOf(data, 'acos').value).toBeCloseTo(0.275, 6)
    expect(cardOf(data, 'roas').value).toBeCloseTo(400 / 110, 6)
    expect(cardOf(data, 'ctr').value).toBeCloseTo(160 / 3500, 6)
    expect(cardOf(data, 'cpc').value).toBeCloseTo(110 / 160, 6)
    expect(cardOf(data, 'cvr').value).toBeCloseTo(13 / 160, 6)
    expect(cardOf(data, 'adsShare').value).toBeCloseTo(0.1, 6)
    expect(cardOf(data, 'organicSales')).toMatchObject({ state: 'OK', value: 600 })
    expect(cardOf(data, 'spend').trend).toHaveLength(10)
    expect((cardOf(data, 'spend').trend as Array<number | null>).slice(0, 3)).toEqual([40, 70, null])
  })

  it('广告产品结构：已有数据的类型有数，没有行的已接入类型“尚无记录”，未接入类型“未接入”', async () => {
    const res = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY }))
    const rows = res.json.data.products as Array<{ adProduct: string; state: string; spend: number | null; spendShare: number | null }>
    expect(rows.map(row => [row.adProduct, row.state])).toEqual([
      ['SPONSORED_PRODUCTS', 'OK'],
      ['SPONSORED_BRANDS', 'OK'],
      ['SPONSORED_DISPLAY', 'NOT_CONNECTED'],
      ['SPONSORED_TELEVISION', 'NOT_CONNECTED'],
    ])
    expect(rows[0]).toMatchObject({ spend: 100 })
    expect(rows[0]!.spendShare).toBeCloseTo(100 / 110, 6)
    expect(res.json.data.funnel.value).toMatchObject({ impressions: 3500, clicks: 160, orders: 13 })
  })

  it('趋势按粒度分桶，事件落在企业时区的日子上；店铺口径的总销售额与自然销售额同图', async () => {
    const res = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY, storeRows: STORE }), `${RANGE}&granularity=week`)
    const data = res.json.data
    expect(data.granularity).toBe('week')
    // 10 月 1 日是周四：9-28 那周含 1 日与 2 日；10-05 那周整周没有记录，值为空而不是 0
    expect(data.trend.points).toEqual([
      { key: '2026-09-28', spend: 110, sales: 400 },
      { key: '2026-10-05', spend: null, sales: null },
    ])
    expect(data.trend.events).toEqual([{ date: '2026-10-05', label: '调整预算', kind: 'ADS_CHANGE' }])
    expect(data.mix.points).toEqual([
      { key: '2026-09-28', totalSales: 1000, adSales: 400, organicSales: 600, adSpend: 100, adsShare: 0.1 },
      { key: '2026-10-05', totalSales: null, adSales: null, organicSales: null, adSpend: null, adsShare: null },
    ])
  })

  it('四象限与异常活动：花费无转化、花费超过销售额被标出；活动名来自活动管理，没有记录用编号', async () => {
    const res = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY, campaigns: CAMPAIGNS }))
    const data = res.json.data
    // c1 花费 70 销售额 280 有订单（正常）；c2 花费 40 点击 60 没有订单（花费无转化）；c3 花费不到 20（不判断）
    expect(data.anomalies.count).toBe(1)
    expect(data.anomalies.items.map((item: { campaignId: string; kind: string; name: string }) => [item.campaignId, item.kind, item.name])).toEqual([['c2', 'NO_CONVERSION', 'c2']])
    expect(cardOf(data, 'anomalies')).toMatchObject({ state: 'OK', value: 1 })
    expect(data.quadrant.withoutSales).toBe(1)
    expect(data.quadrant.points.map((point: { campaignId: string; name: string }) => [point.campaignId, point.name])).toEqual([
      ['c1', '春季推广'],
      ['c3', 'c3'],
    ])
  })

  it('指标树归因：两期都有点击、花费、订单、销售额才拆；缺任一项不补 0 并说明', async () => {
    const previous = { _sum: sum(1500, 100, 80, 200, 4), _count: { _all: 3 } }
    const res = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY, previous }))
    const attribution = res.json.data.attribution
    expect(attribution.state).toBe('OK')
    expect(attribution.spend).toMatchObject({ before: 80, after: 110 })
    expect(attribution.spend.factors.map((factor: { key: string }) => factor.key)).toEqual(['clicks', 'cpc'])
    expect(attribution.sales.factors.map((factor: { key: string }) => factor.key)).toEqual(['clicks', 'cvr', 'aov'])
    const none = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY, previous: { _sum: sum(0, 0, null, null, 0), _count: { _all: 0 } } }))
    expect(none.json.data.attribution).toMatchObject({ state: 'NO_DATA', spend: null, sales: null })
  })

  it('预算利用率：按当前日预算 × 天数估算；给出每天花费', async () => {
    const budgeted = [{ adsProfileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', externalCampaignId: 'c1', budget: dec(10), startDate: null, endDate: null }]
    const res = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY, campaigns: CAMPAIGNS, budgeted }))
    const budget = res.json.data.budget
    expect(budget).toMatchObject({ state: 'OK', dailyBudgetTotal: 10, budgetedCampaigns: 1 })
    expect(budget.utilization).toBeCloseTo(70 / (10 * 10), 6)
    expect(budget.note).toContain('估算')
    expect(budget.days).toHaveLength(10)
    expect(cardOf(res.json.data, 'budgetUtilization')).toMatchObject({ state: 'OK' })
  })

  it('其他币种单独列出、不并入；全部店铺成员能看到未绑定广告账户的花费', async () => {
    const res = await get(prismaFor(['ads.read'], { ever: true, daily: DAILY, others: [{ currency: 'CAD', _sum: { spend: dec(30) } }], unbound: 25, storeRows: STORE }))
    expect(res.json.data.otherCurrencies).toEqual([{ currency: 'CAD', spend: 30 }])
    expect(res.json.data.unboundSpend).toBe(25)
    expect(cardOf(res.json.data, 'spend').note).toContain('未绑定店铺')
  })

  it('受限成员：广告查询带店铺范围条件，不查未绑定账户的花费', async () => {
    const stub = prismaFor(['ads.read'], { ever: true, daily: DAILY, scopedTo: ['s1'] })
    const res = await get(stub)
    expect(res.status).toBe(200)
    expect(res.json.data.unboundSpend).toBeNull()
    const where = stub.adsDailySummary.groupBy.mock.calls[0]![0] as unknown as { where: { adsProfile: unknown; currency: string } }
    expect(where.where.adsProfile).toEqual({ sellerAccountId: { in: ['s1'] } })
    expect(where.where.currency).toBe('USD')
    // 受限成员看不到未绑定账户：没有任何一次聚合是按“未绑定”条件查的
    const unboundQueries = stub.adsDailySummary.aggregate.mock.calls.filter(call => (call[0] as { where: { adsProfile?: { sellerAccountId?: unknown } } }).where.adsProfile?.sellerAccountId === null)
    expect(unboundQueries).toHaveLength(0)
    const storeWhere = (stub.storeDailySummary.groupBy.mock.calls[0]![0] as { where: { sellerAccountId: unknown } }).where
    expect(storeWhere.sellerAccountId).toEqual({ in: ['s1'] })
  })
})
