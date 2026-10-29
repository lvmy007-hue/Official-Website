import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 今日广告接口（P3-06）：权限与参数、接收端未配置与今日没有小时指标的状态、小时曲线与区间带、预算外推、超预算、异常、断货仍在投放、范围收窄。
// 数据读取用内存替身；真实数据库的行为见 testing/ads-today.db.test.ts。时钟固定在 2026-10-23 06:30（企业时区 UTC），避免随日期失效。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

const NOW = '2026-10-23T06:30:00Z'
const DAY_START = Date.parse('2026-10-23T00:00:00Z')
const HOUR = 3_600_000
const dec = (value: number | null) => (value === null ? null : { toString: () => String(value) })
const sum = (impressions: number, clicks: number, spend: number | null, sales: number | null, orders: number) => ({ impressions, clicks, spend: dec(spend), sales: dec(sales), orders })
/** 相对今天零点的第几个小时（负数是以前）。 */
const hourRow = (offset: number, values: ReturnType<typeof sum>) => ({ hourStart: new Date(DAY_START + offset * HOUR), _sum: values })

interface Stub {
  hours?: unknown[]
  today?: unknown[]
  baseline?: unknown[]
  others?: unknown[]
  fallbackDay?: string | null
  budgeted?: unknown[]
  outOfBudget?: { rows: unknown[]; total: number; withStatus: number }
  advertised?: unknown[]
  everAdvertised?: boolean
  profiles?: unknown[]
  snapshots?: unknown[]
  scopedTo?: string[]
}

function prismaFor(permissions: string[], options: Stub = {}) {
  const hourlyGroupBy = vi.fn(async (args: { by: string[]; where: { hourStart: { gte: Date } } }) => {
    const by = args.by.join(',')
    if (by === 'hourStart') return options.hours ?? []
    if (by === 'currency') return options.others ?? []
    // 活动级：今天零点起算的是今日，更早的是基线
    return args.where.hourStart.gte.getTime() === DAY_START ? (options.today ?? []) : (options.baseline ?? [])
  })
  const newest = options.hours?.length ? { _max: { sourceUpdatedAt: new Date('2026-10-23T06:15:00Z') } } : { _max: { sourceUpdatedAt: null } }
  return {
    ...sessionStub(permissions),
    ...(options.scopedTo ? { membershipScope: { findMany: vi.fn().mockResolvedValue(options.scopedTo.map(id => ({ legalEntityId: null, sellerAccountId: id }))) } } : {}),
    sellerAccount: {
      findMany: vi.fn().mockResolvedValue((options.scopedTo ?? ['s1']).map(id => ({ id, displayName: `店铺 ${id}` }))),
    },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    adsPerformanceHourly: { groupBy: hourlyGroupBy, aggregate: vi.fn().mockResolvedValue(newest) },
    adsDailySummary: {
      findFirst: vi.fn(async (args: { select: Record<string, boolean> }) => {
        if (!options.fallbackDay) return null
        return args.select.summaryDate ? { summaryDate: new Date(`${options.fallbackDay}T00:00:00Z`) } : { refreshedAt: new Date('2026-10-23T02:00:00Z') }
      }),
      aggregate: vi.fn().mockResolvedValue({ _sum: sum(5000, 200, 90, 360, 12) }),
    },
    adsCampaign: {
      findMany: vi.fn(async (args: { where: { budgetType?: unknown; servingStatus?: unknown } }) => {
        if (args.where.budgetType === 'DAILY') return options.budgeted ?? []
        if (args.where.servingStatus) return options.outOfBudget?.rows ?? []
        return [
          { adsProfileId: 'p1', externalCampaignId: 'c2', name: '清仓' },
          { adsProfileId: 'p1', externalCampaignId: 'c3', name: '新品' },
        ]
      }),
      count: vi.fn(async (args: { where: { servingStatus: { contains?: string; not?: null } } }) =>
        args.where.servingStatus.contains ? (options.outOfBudget?.total ?? 0) : (options.outOfBudget?.withStatus ?? 0),
      ),
    },
    adsAdvertisedProductMetric: {
      groupBy: vi.fn().mockResolvedValue(options.advertised ?? []),
      findFirst: vi.fn().mockResolvedValue(options.everAdvertised ? { id: 'x' } : null),
    },
    adsProfile: { findMany: vi.fn().mockResolvedValue(options.profiles ?? [{ id: 'p1', sellerAccountId: 's1' }]) },
    inventoryDailySnapshot: {
      groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { snapshotDate: new Date('2026-10-22T00:00:00Z') } }]),
      findMany: vi.fn().mockResolvedValue(options.snapshots ?? []),
    },
  }
}

const get = async (stub: ReturnType<typeof prismaFor>, query = '', { sink = true } = {}) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  if (sink) vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
  else vi.stubEnv('AMAZON_ADS_STREAM_SINK', '')
  harness = await createTestApp(stub)
  return harness.call('GET', `/ads/today${query}`)
}

describe('今日广告接口：权限与参数', () => {
  it('未登录 401，没有 ads.read 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/today', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/today')).status).toBe(403)
  })

  it('没有权限先于参数校验：日期范围倒置也先返回 403；有权限时倒置返回 422', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/today?from=2026-10-10&to=2026-10-01')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', '/ads/today?from=2026-10-10&to=2026-10-01')).status).toBe(422)
  })

  it('没有任何数据授权返回 403', async () => {
    harness = await createTestApp({ ...prismaFor(['ads.read']), membershipScope: { findMany: vi.fn().mockResolvedValue([]) } })
    expect((await harness.call('GET', '/ads/today')).status).toBe(403)
  })
})

describe('今日广告接口：接收端未配置', () => {
  it('正式“未接入”：不去查小时指标，没有今日数字，退化展示最近一天的日报表汇总', async () => {
    const stub = prismaFor(['ads.read'], { fallbackDay: '2026-10-22' })
    const res = await get(stub, '', { sink: false })
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ streamState: 'NOT_CONNECTED', businessDate: '2026-10-23', currency: 'USD', asOf: null })
    expect(data.note).toContain('未接入')
    expect(data.updateNote).toContain('滞后')
    expect(data.totals).toMatchObject({ state: 'NOT_CONNECTED', value: null, yesterdaySameHour: null })
    expect(data.hours).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
    expect(data.fallback).toMatchObject({ summaryDate: '2026-10-22', refreshedAt: '2026-10-23T02:00:00.000Z', totals: { spend: 90, clicks: 200, sales: 360, orders: 12 } })
    expect(data.fallback.totals.cpc).toBeCloseTo(0.45, 6)
    expect(data.anomalies).toMatchObject({ state: 'NOT_CONNECTED', count: 0, items: [] })
    expect(stub.adsPerformanceHourly.groupBy).not.toHaveBeenCalled()
  })

  it('没有任何日报表汇总：没有退化数据，也不是 0', async () => {
    const res = await get(prismaFor(['ads.read']), '', { sink: false })
    expect(res.json.data.fallback).toBeNull()
    expect(res.json.data.totals.value).toBeNull()
  })

  it('预算与超预算、断货仍在投放不依赖数据流：数据流没接入时仍然给出', async () => {
    const budgeted = [{ adsProfileId: 'p1', externalCampaignId: 'c1', adProduct: 'SPONSORED_PRODUCTS', name: '春季推广', budget: dec(100) }]
    const outOfBudget = { rows: [{ adsProfileId: 'p1', externalCampaignId: 'c2', adProduct: 'SPONSORED_PRODUCTS', name: '清仓', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' }], total: 1, withStatus: 2 }
    const res = await get(prismaFor(['ads.read'], { budgeted, outOfBudget }), '', { sink: false })
    const data = res.json.data
    expect(data.budget).toMatchObject({ state: 'NOT_CONNECTED', dailyBudgetTotal: 100, spentToday: null, progress: null, rows: [] })
    expect(data.budget.note).toContain('今日花费与预算进度算不出')
    expect(data.outOfBudget).toMatchObject({ state: 'OK', count: 1 })
    expect(data.outOfBudget.rows[0]).toMatchObject({ campaignId: 'c2', name: '清仓', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' })
  })
})

describe('今日广告接口：接收端已配置但今天没有小时指标', () => {
  it('状态“尚无记录”（不是未接入），同样退化展示日报表', async () => {
    const res = await get(prismaFor(['ads.read'], { fallbackDay: '2026-10-22' }))
    const data = res.json.data
    expect(data.streamState).toBe('NO_DATA')
    expect(data.note).toContain('今天还没有收到小时指标')
    expect(data.totals).toMatchObject({ state: 'NO_DATA', value: null })
    expect(data.fallback.summaryDate).toBe('2026-10-22')
    expect(data.hours.items).toEqual([])
  })
})

// 今天 00 至 06 点每小时：曝光 1000、点击 20、花费 10、销售额 40、订单 1；昨天 00 至 02 点每小时点击 10、花费 5。
const TODAY_HOURS = Array.from({ length: 7 }, (_, hour) => hourRow(hour, sum(1000, 20, 10, 40, 1)))
const YESTERDAY_HOURS = [-24, -23, -22].map(offset => hourRow(offset, sum(500, 10, 5, 10, 0)))
// 03 点的历史同时段样本：前 1、2、3 天
const HISTORY_AT_3 = [-21, -45, -69].map((offset, index) => hourRow(offset, sum(300, [10, 20, 15][index]!, [4, 8, 6][index]!, 0, 0)))
const HOURS = [...HISTORY_AT_3, ...YESTERDAY_HOURS, ...TODAY_HOURS]
const campaign = (id: string, values: ReturnType<typeof sum>) => ({ adsProfileId: 'p1', entityId: id, _sum: values })
const TODAY = [campaign('c1', sum(5000, 100, 70, 200, 3)), campaign('c2', sum(2000, 40, 30, 0, 0)), campaign('c3', sum(1000, 40, 40, 80, 2))]
const BASELINE = [campaign('c3', sum(4000, 200, 100, 300, 9)), campaign('c1', sum(9000, 600, 300, 900, 20))]
const budget = (id: string, value: number, product = 'SPONSORED_PRODUCTS') => ({ adsProfileId: 'p1', externalCampaignId: id, adProduct: product, name: `活动 ${id}`, budget: dec(value) })
const BUDGETED = [budget('c1', 100), budget('c2', 40), budget('c3', 40), budget('c4', 5)]

describe('今日广告接口：有小时指标', () => {
  const live = async (extra: Stub = {}) => (await get(prismaFor(['ads.read'], { hours: HOURS, today: TODAY, baseline: BASELINE, budgeted: BUDGETED, ...extra }))).json.data

  it('今日指标：花费、点击、单次点击成本、销售额；截至时刻取小时指标的来源更新时间；对比昨天同时刻', async () => {
    const data = await live()
    expect(data.streamState).toBe('LIVE')
    expect(data.note).toBeNull()
    expect(data.asOf).toBe('2026-10-23T06:15:00.000Z')
    expect(data.totals.state).toBe('OK')
    expect(data.totals.value).toMatchObject({ spend: 70, clicks: 140, impressions: 7000, sales: 280, orders: 7 })
    expect(data.totals.value.cpc).toBeCloseTo(0.5, 6)
    // 昨天 00 至 06 点里有小时指标的是 00 至 02 点（各花费 5、点击 10）与 03 点（花费 4、点击 10，即区间带的第一条样本）：花费 19、点击 40
    expect(data.totals.yesterdaySameHour).toMatchObject({ spend: 19, clicks: 40 })
    expect(data.fallback).toBeNull()
  })

  it('小时曲线：24 个小时，已过去的有数、未到的为空；没有小时指标行的小时是 null；样本够才给区间带', async () => {
    const data = await live({ hours: [...HISTORY_AT_3, ...TODAY_HOURS.filter((_, hour) => hour !== 4)] })
    const items = data.hours.items as Array<{ hourStart: string; elapsed: boolean; spend: number | null; clicks: number | null; band: unknown }>
    expect(items).toHaveLength(24)
    expect(items[0]).toMatchObject({ hourStart: '2026-10-23T00:00:00.000Z', elapsed: true, spend: 10, clicks: 20 })
    expect(items[4]).toMatchObject({ elapsed: true, spend: null, clicks: null })
    expect(items[6]).toMatchObject({ elapsed: true, spend: 10 })
    expect(items[7]).toMatchObject({ elapsed: false, spend: null, clicks: null, band: null })
    expect(items[3]!.band).toEqual({ spendMin: 4, spendMax: 8, clicksMin: 10, clicksMax: 20, samples: 3 })
    expect(items[2]!.band).toBeNull()
    expect(data.hours.historyDays).toBe(14)
  })

  it('预算：花费与日预算合计、进度、耗尽外推；没有小时指标的活动“今天还没有花费”；按进度从高到低', async () => {
    const data = await live()
    const b = data.budget
    expect(b.state).toBe('OK')
    expect(b.note).toContain('估算')
    // 日预算 100+40+40+5 = 185；已花 70+30+40 = 140（c4 没有小时指标行）
    expect(b).toMatchObject({ dailyBudgetTotal: 185, spentToday: 140, budgetedCampaigns: 4, ambiguous: 0 })
    expect(b.progress).toBeCloseTo(140 / 185, 6)
    expect(b.rows.map((row: { campaignId: string; exhaust: string }) => [row.campaignId, row.exhaust])).toEqual([
      ['c3', 'EXHAUSTED'],
      ['c2', 'PROJECTED'],
      ['c1', 'PROJECTED'],
      ['c4', 'NO_SPEND'],
    ])
    // c2：6.5 小时花了 30，余 10，再 2.1667 小时（约 08:40）
    const c2 = b.rows.find((row: { campaignId: string }) => row.campaignId === 'c2')
    expect(c2).toMatchObject({ spend: 30, dailyBudget: 40 })
    expect(c2.exhaustAt).toBe('2026-10-23T08:40:00.000Z')
    expect(b.rows.find((row: { campaignId: string }) => row.campaignId === 'c4')).toMatchObject({ spend: null, progress: null, exhaustAt: null })
  })

  it('同一档案里活动编号重复的预算活动：不确认花费归属，从预算合计里排除并说明', async () => {
    const data = await live({ budgeted: [...BUDGETED, budget('c1', 60, 'SPONSORED_BRANDS')] })
    expect(data.budget).toMatchObject({ dailyBudgetTotal: 85, budgetedCampaigns: 5, ambiguous: 2 })
    expect(data.budget.note).toContain('2 个活动的编号')
    expect(data.budget.rows.map((row: { campaignId: string }) => row.campaignId)).not.toContain('c1')
  })

  it('没有日预算的活动记录：预算“尚无记录”', async () => {
    const data = await live({ budgeted: [] })
    expect(data.budget).toMatchObject({ state: 'NO_DATA', dailyBudgetTotal: null, rows: [] })
  })

  it('超预算状态只看活动管理接口的投放状态：没有同步过投放状态时尚无记录，不是 0 个', async () => {
    const none = await live({ outOfBudget: { rows: [], total: 0, withStatus: 0 } })
    expect(none.outOfBudget).toMatchObject({ state: 'NO_DATA', count: 0 })
    expect(none.outOfBudget.note).toContain('没有活动同步过投放状态')
    const synced = await live({ outOfBudget: { rows: [], total: 0, withStatus: 5 } })
    expect(synced.outOfBudget).toMatchObject({ state: 'OK', count: 0, rows: [] })
  })

  it('异常：单次点击成本突增与花费无转化；活动名来自活动管理，按花费从高到低', async () => {
    const data = await live()
    expect(data.anomalies.state).toBe('OK')
    // c3：今日单次点击成本 1，基线 0.5，两倍；c2：花费 30、点击 40 但没有订单；c1：基线单次点击成本 0.5、今日 0.7，不到 1.5 倍
    expect(data.anomalies.items.map((item: { campaignId: string; kind: string; name: string }) => [item.campaignId, item.kind, item.name])).toEqual([
      ['c3', 'CPC_SURGE', '新品'],
      ['c2', 'SPEND_NO_CONVERSION', '清仓'],
    ])
    expect(data.anomalies.items[0]).toMatchObject({ baselineCpc: 0.5, ratio: 2, spend: 40, clicks: 40 })
    expect(data.anomalies.count).toBe(2)
    expect(data.anomalies.rules).toMatchObject({ CPC_RATIO: 1.5, NO_CONVERSION_MIN_SPEND: 20 })
  })

  it('其他币种的小时指标单独列出，不并入', async () => {
    const data = await live({ others: [{ currency: 'GBP', _sum: { spend: dec(12.5) } }] })
    expect(data.otherCurrencies).toEqual([{ currency: 'GBP', spend: 12.5 }])
  })

  it('小时指标与活动级查询都只取活动级美元行', async () => {
    const stub = prismaFor(['ads.read'], { hours: HOURS, today: TODAY })
    await get(stub)
    const wheres = stub.adsPerformanceHourly.groupBy.mock.calls.map(call => (call[0] as unknown as { where: { entityType: string; currency: unknown } }).where)
    expect(wheres.length).toBeGreaterThan(0)
    for (const where of wheres) expect(where.entityType).toBe('CAMPAIGN')
    expect(wheres.filter(where => where.currency === 'USD').length).toBe(3)
  })

  it('受限成员：小时指标与预算查询都带店铺范围条件', async () => {
    const stub = prismaFor(['ads.read'], { hours: HOURS, today: TODAY, scopedTo: ['s1'] })
    const res = await get(stub)
    expect(res.status).toBe(200)
    const hourly = stub.adsPerformanceHourly.groupBy.mock.calls[0]![0] as unknown as { where: { adsProfile: unknown } }
    expect(hourly.where.adsProfile).toEqual({ sellerAccountId: { in: ['s1'] } })
    const campaigns = stub.adsCampaign.findMany.mock.calls[0]![0] as unknown as { where: { adsProfile: unknown } }
    expect(campaigns.where.adsProfile).toEqual({ sellerAccountId: { in: ['s1'] } })
  })
})

const advertised = (asin: string, date: string, spend: number) => ({ adsProfileId: 'p1', advertisedAsin: asin, reportDate: new Date(`${date}T00:00:00Z`), _sum: { spend: dec(spend) } })
const snapshot = (asin: string, sellable: number | null, sku = 'SKU') => ({ sellerAccountId: 's1', asin, sellable, snapshotDate: new Date('2026-10-22T00:00:00Z'), sku })

describe('今日广告接口：断货商品仍在投放', () => {
  const ADVERTISED = [
    advertised('B0AAA', '2026-10-21', 6),
    advertised('B0AAA', '2026-10-22', 6),
    advertised('B0AAA', '2026-10-23', 6),
    advertised('B0BBB', '2026-10-22', 10),
    advertised('B0CCC', '2026-10-22', 50),
  ]

  it('回看近 3 天有花费的商品，最近一次库存快照可售为 0 的列出，日均浪费 = 花费 ÷ 有花费的天数', async () => {
    const snapshots = [snapshot('B0AAA', 0, 'S1'), snapshot('B0AAA', 0, 'S2'), snapshot('B0BBB', 5)]
    const res = await get(prismaFor(['ads.read'], { everAdvertised: true, advertised: ADVERTISED, snapshots }), '', { sink: false })
    const stockout = res.json.data.stockout
    expect(stockout.state).toBe('OK')
    expect(stockout.items).toHaveLength(1)
    expect(stockout.items[0]).toMatchObject({ asin: 'B0AAA', sellerAccountId: 's1', storeName: '店铺 s1', sellable: 0, snapshotDate: '2026-10-22', spend: 18, days: 3, dailyWaste: 6 })
    expect(stockout.note).toContain('不是实时库存')
  })

  it('同一 ASIN 有的 SKU 还有货就不算断货；可售数量没给的不判断', async () => {
    const snapshots = [snapshot('B0AAA', 0, 'S1'), snapshot('B0AAA', 3, 'S2'), snapshot('B0BBB', null)]
    const res = await get(prismaFor(['ads.read'], { everAdvertised: true, advertised: ADVERTISED, snapshots }), '', { sink: false })
    expect(res.json.data.stockout).toMatchObject({ state: 'OK', items: [] })
  })

  it('被推广商品日报表从没有记录：尚未接入；回看期没有记录：尚无记录；有花费但没有库存快照可对照：尚无记录', async () => {
    const never = await get(prismaFor(['ads.read']), '', { sink: false })
    expect(never.json.data.stockout).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
    const quiet = await get(prismaFor(['ads.read'], { everAdvertised: true }), '', { sink: false })
    expect(quiet.json.data.stockout).toMatchObject({ state: 'NO_DATA', items: [] })
    const noStock = await get(prismaFor(['ads.read'], { everAdvertised: true, advertised: ADVERTISED, snapshots: [] }), '', { sink: false })
    expect(noStock.json.data.stockout.state).toBe('NO_DATA')
    expect(noStock.json.data.stockout.note).toContain('没有库存快照可对照')
  })

  it('广告账户没有绑定店铺：对不上库存，说明数量，不猜', async () => {
    const res = await get(prismaFor(['ads.read'], { everAdvertised: true, advertised: ADVERTISED, profiles: [{ id: 'p1', sellerAccountId: null }], snapshots: [snapshot('B0AAA', 0)] }), '', {
      sink: false,
    })
    expect(res.json.data.stockout.state).toBe('NO_DATA')
    expect(res.json.data.stockout.note).toContain('没有绑定店铺')
  })
})
