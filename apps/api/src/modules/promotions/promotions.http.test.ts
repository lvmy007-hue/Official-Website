import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 促销接口（P4-05）：权限先于参数校验、数据范围、只读（没有写入口）、列表状态（没同步 / 没促销 / 角色没批）、
// 绩效与平台费用的“尚无记录 / 尚未接入 / 无权限”区分、详情六个页签（效果基线法、商品、成本、利润与促销投入回报率、问题、广告）。

const ZONE = 'America/Los_Angeles'
const dayText = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const today = dayText(new Date())
/** 活动开始日（10 天前，含今天共 10 天）与基线起点（再往前 28 天）。 */
const startDay = shift(today, -9)
const baselineFrom = shift(startDay, -28)
const allDays = Array.from({ length: 38 }, (_, index) => shift(baselineFrom, index))

const none = () => vi.fn().mockResolvedValue([])
const promotionRecord = (over: Record<string, unknown> = {}) => ({
  id: 'pr1',
  promotionId: 'P-DEAL-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  promotionType: 'DEAL',
  couponType: null,
  title: '十月秒杀',
  status: 'RUNNING',
  revisionStatus: null,
  startAt: new Date(`${startDay}T20:00:00Z`),
  endAt: null,
  amazonCreatedAt: new Date('2026-10-01T00:00:00Z'),
  amazonUpdatedAt: new Date('2026-10-20T00:00:00Z'),
  mappingId: 'TRK-1',
  budgetType: 'AMOUNT',
  budgetValue: '500',
  budgetCurrency: 'USD',
  benefitJson: { discount: { type: 'PERCENTAGE_OFF', percentOff: 20 } },
  feeJson: { upfrontFee: { rate: { amount: 150, currencyCode: 'USD' }, frequency: 'ONE_TIME' }, variableFee: { salesPercentage: 2, feeCapAmount: { amount: 25, currencyCode: 'USD' } } },
  selectionType: 'ITEMS',
  itemCount: 2,
  itemsTruncated: false,
  issuesJson: [{ code: 'PRICE_NEAR_FLOOR', message: '折后价接近最低价', severity: 'WARNING' }],
  errorCount: 0,
  warningCount: 1,
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const itemRecord = (over: Record<string, unknown> = {}) => ({
  promotionRowId: 'pr1',
  asin: 'B0AAAAAAA1',
  sku: 'SKU-1',
  benefitType: 'DISCOUNTED_PRICE',
  discountType: 'PERCENTAGE_OFF',
  percentOff: '20',
  amountOff: null,
  fixedPrice: null,
  currency: 'USD',
  perCustomerUses: 1,
  budgetType: null,
  budgetValue: null,
  issuesJson: [],
  ...over,
})
const freshnessRow = (key: string, over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  sourceKey: key,
  lastAttemptAt: new Date(),
  lastSuccessAt: new Date(),
  dataThrough: null,
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})
const day = (text: string) => new Date(`${text}T00:00:00Z`)

/** 基线期每天 10 件（每件 20 美元、毛利 5 美元），活动期间每天 30 件。 */
const unitsOn = (date: string) => (date >= startDay ? 30 : 10)

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  return {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: ZONE }) },
    promotion: { findMany: vi.fn().mockResolvedValue([promotionRecord()]), findFirst: vi.fn().mockResolvedValue(promotionRecord()) },
    promotionItem: { findMany: vi.fn().mockResolvedValue([itemRecord(), itemRecord({ asin: 'B0AAAAAAA2', sku: 'SKU-2', issuesJson: [{ code: 'X', message: '商品问题', severity: 'ERROR' }] })]) },
    promotionMetric: { groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', mappingId: 'TRK-1', metricDate: day(today), _sum: { units: 12, sales: '240', redemptions: 12 } }]) },
    couponMetric: { groupBy: none() },
    asinDailySummary: {
      groupBy: vi
        .fn()
        .mockImplementation(async (args: { where: { asin?: unknown } }) =>
          args.where.asin
            ? allDays.map(date => ({ summaryDate: day(date), _sum: { units: unitsOn(date), salesAmount: String(unitsOn(date) * 20) } }))
            : allDays.map(date => ({ summaryDate: day(date) })),
        ),
    },
    orderItem: { aggregate: vi.fn().mockResolvedValue({ _sum: { promotionDiscount: '400' }, _count: { _all: 30, promotionDiscount: 30 } }) },
    fbaFeeEvent: {
      findMany: vi.fn().mockResolvedValue([
        { sellerAccountId: 's1', asin: 'B0AAAAAAA1', eventType: 'DealParticipationFee', feeSubtype: null, amount: '-75', postedAt: new Date(`${shift(today, -5)}T12:00:00Z`) },
        { sellerAccountId: 's1', asin: 'B0AAAAAAA2', eventType: 'DealParticipationFee', feeSubtype: null, amount: '-25', postedAt: new Date(`${shift(today, -4)}T12:00:00Z`) },
        { sellerAccountId: 's1', asin: 'B0ZZZZZZZZ', eventType: 'DealParticipationFee', feeSubtype: null, amount: '-999', postedAt: new Date(`${shift(today, -4)}T12:00:00Z`) },
      ]),
    },
    profitDaily: {
      groupBy: vi.fn().mockImplementation(async () => allDays.map(date => ({ profitDate: day(date), _sum: { profit: String(unitsOn(date) * 5) }, _count: { _all: 2, profit: 2 } }))),
    },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([{ id: 'p1', asin: 'B0AAAAAAA1', sellerSku: 'SKU-1', title: '示例商品' }]) },
    adsProfile: { findMany: none() },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    dataFreshness: {
      findMany: vi
        .fn()
        .mockResolvedValue([freshnessRow('promotions.api'), freshnessRow('rpt.promotion-performance'), freshnessRow('rpt.coupon-performance', { lastSuccessAt: null, status: 'NO_RECORD' })]),
    },
    ...over,
  } as unknown as Record<string, ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>>
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const FULL = ['analytics.read', 'orders.read', 'finance.read', 'products.read', 'ads.read']
const open = async (permissions: string[], over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}

describe('权限、范围与只读', () => {
  it('未登录 401；没有 analytics.read 时列表与详情 403（先于参数校验）', async () => {
    const { call } = await open(['analytics.read'])
    expect((await call('GET', '/promotions', { auth: false })).status).toBe(401)
    await harness?.close()
    const denied = await open(['seller.read'])
    for (const path of ['/promotions?pageSize=99999', '/promotions/pr1']) expect((await denied.call('GET', path)).status, path).toBe(403)
  })

  it('没有写入口：POST、PATCH、DELETE 都不存在', async () => {
    const { call } = await open(['analytics.read'])
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) expect((await call(method, '/promotions/pr1', { body: {} })).status, method).toBe(404)
    expect((await call('POST', '/promotions', { body: {} })).status).toBe(404)
  })

  it('查询一律带企业条件；数据范围收窄到一个店铺时按店铺过滤，范围外的促销详情 404', async () => {
    const scoped = {
      membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) },
      promotion: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    }
    const { call, prisma } = await open(['analytics.read'], scoped)
    await call('GET', '/promotions')
    expect(JSON.stringify(prisma.promotion.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect((await call('GET', '/promotions/other')).status).toBe(404)
    expect(JSON.stringify(prisma.promotion.findFirst.mock.calls[0][0].where)).toContain('s1')
    expect((await call('GET', '/promotions/bad%20id')).status).toBe(404)
  })
})

describe('列表', () => {
  it('字段、中文名、折扣力度；游标多取一行；按开始时间新到旧；筛选状态、类型与关键词', async () => {
    const { call, prisma } = await open(FULL)
    const res = await call('GET', '/promotions?pageSize=20&status=RUNNING&type=DEAL&q=秒杀')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.state).toBe('OK')
    expect(data.items[0]).toMatchObject({
      id: 'pr1',
      promotionId: 'P-DEAL-1',
      typeLabel: '秒杀',
      statusLabel: '进行中',
      storeName: '美国主店',
      itemCount: 2,
      discountText: '立减 20%',
      budget: { type: 'AMOUNT', value: 500 },
    })
    expect(data.sync).toMatchObject({ status: 'NORMAL', rolePending: false })
    const args = prisma.promotion.findMany.mock.calls[0][0]
    expect(args.take).toBe(21)
    expect(JSON.stringify(args.where)).toContain('RUNNING')
    expect(JSON.stringify(args.where)).toContain('秒杀')
    expect(JSON.stringify(args.orderBy)).toContain('startAt')
    expect((await call('GET', '/promotions?status=NOPE')).status).toBe(422)
  })

  it('绩效：有行给数字；报告接入了但没有行写“尚无记录”；报告从没同步过写“尚未接入”，都不是 0', async () => {
    const coupon = promotionRecord({ id: 'pr2', promotionId: 'P-COUPON-1', promotionType: 'COUPON', mappingId: 'TRK-2' })
    const { call } = await open(FULL, { promotion: { findMany: vi.fn().mockResolvedValue([promotionRecord(), promotionRecord({ id: 'pr3', mappingId: 'TRK-9' }), coupon]), findFirst: vi.fn() } })
    const items = (await call('GET', '/promotions')).json.data.items
    expect(items[0].reported).toEqual({ state: 'OK', units: 12, sales: 240, redemptions: 12 })
    expect(items[1].reported).toEqual({ state: 'NO_RECORD', units: null, sales: null, redemptions: null })
    expect(items[2].reported).toEqual({ state: 'NOT_CONNECTED', units: null, sales: null, redemptions: null })
  })

  it('平台费用：有事件按所选商品归集；没有 finance.read 写“无权限”；按目录选品没有商品清单；价格折扣不适用', async () => {
    const rows = [promotionRecord(), promotionRecord({ id: 'pr4', promotionType: 'PRICE_DISCOUNT' }), promotionRecord({ id: 'pr5', selectionType: 'CATALOG', itemCount: null })]
    const withFinance = await open(FULL, { promotion: { findMany: vi.fn().mockResolvedValue(rows), findFirst: vi.fn() } })
    const fees = (await withFinance.call('GET', '/promotions')).json.data.items.map((item: { platformFee: unknown }) => item.platformFee)
    expect(fees).toEqual([
      { state: 'OK', amount: 100 },
      { state: 'NOT_APPLICABLE', amount: null },
      { state: 'NO_ITEMS', amount: null },
    ])
    await harness?.close()
    const limited = await open(['analytics.read'], { promotion: { findMany: vi.fn().mockResolvedValue(rows), findFirst: vi.fn() } })
    const restricted = (await limited.call('GET', '/promotions')).json.data.items
    expect(restricted.every((item: { platformFee: { state: string } }) => item.platformFee.state === 'RESTRICTED')).toBe(true)
    expect(limited.prisma.fbaFeeEvent.findMany).not.toHaveBeenCalled()
  })

  it('商品清单还没同步的促销：商品数是空，不是 0', async () => {
    const { call } = await open(FULL, { promotion: { findMany: vi.fn().mockResolvedValue([promotionRecord({ itemCount: null })]), findFirst: vi.fn() } })
    expect((await call('GET', '/promotions')).json.data.items[0].itemCount).toBeNull()
  })

  it('没有促销：同步正常写“尚无记录”；从没同步写“尚未同步”；接口角色没批给申请方式', async () => {
    const empty = { promotion: { findMany: none(), findFirst: vi.fn() } }
    const normal = await open(FULL, empty)
    const ok = (await normal.call('GET', '/promotions')).json.data
    expect(ok).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(ok.note).toContain('尚无记录')
    await harness?.close()
    const never = await open(FULL, { ...empty, dataFreshness: { findMany: none() } })
    const notSynced = (await never.call('GET', '/promotions')).json.data
    expect(notSynced).toMatchObject({ state: 'NOT_CONNECTED' })
    expect(notSynced.note).toContain('尚未同步')
    await harness?.close()
    const pending = await open(FULL, {
      ...empty,
      dataFreshness: { findMany: vi.fn().mockResolvedValue([freshnessRow('promotions.api', { status: 'UNAUTHORIZED', lastSuccessAt: null, lastErrorCode: 'ROLE_MISSING' })]) },
    })
    const guide = (await pending.call('GET', '/promotions')).json.data
    expect(guide).toMatchObject({ state: 'ROLE_PENDING', sync: { rolePending: true, status: 'UNAUTHORIZED' } })
    expect(guide.note).toContain('角色')
  })
})

describe('详情', () => {
  it('效果：基线法——活动期间实际对比活动前 28 天的日均，增量与提升幅度；促销自带的绩效报告数字另列', async () => {
    const { call, prisma } = await open(FULL)
    const res = await call('GET', '/promotions/P-DEAL-1')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.promotion).toMatchObject({ id: 'pr1', mappingId: 'TRK-1', typeLabel: '秒杀' })
    expect(data.write).toMatchObject({ supported: false })
    expect(data.write.note).toContain('只读')
    expect(JSON.stringify(prisma.promotion.findFirst.mock.calls[0][0].where)).toMatch(/"id":"P-DEAL-1"[\s\S]*"promotionId":"P-DEAL-1"/)
    expect(data.effect).toMatchObject({
      state: 'OK',
      window: { from: startDay, to: today, days: 10 },
      baseline: { state: 'OK', usedDays: 28, excludedDays: 0 },
      actual: { units: 300, sales: 6000 },
      expected: { units: 100, sales: 2000 },
      incremental: { units: 200, sales: 4000, liftPct: 200 },
      reported: { state: 'OK', units: 12, sales: 240 },
    })
    expect(data.effect.daily).toHaveLength(10)
    expect(data.effect.daily[0]).toMatchObject({ date: startDay, actualUnits: 30, baselineUnits: 10 })
    expect(data.methodNote).toContain('不是亚马逊给的数字')
  })

  it('成本与利润：折扣成本来自订单明细，平台费用只算所选商品的费用事件；增量毛利 ÷（折扣 + 费用）= 促销投入回报率', async () => {
    const { call } = await open(FULL)
    const { cost, profit } = (await call('GET', '/promotions/pr1')).json.data
    expect(cost.discount).toMatchObject({ state: 'OK', amount: 400, orderLines: 30 })
    expect(cost.platformFee).toMatchObject({ state: 'OK', amount: 100, lines: [{ label: 'DealParticipationFee', amount: 100, count: 2 }] })
    expect(cost.total).toBe(500)
    expect(cost.feePreview).toEqual({ upfront: { amount: 150, currency: 'USD', frequency: 'ONE_TIME' }, variablePct: 2, capAmount: 25 })
    expect(profit).toMatchObject({ state: 'OK', actualProfit: 1500, expectedProfit: 500, incrementalProfit: 1000 })
    expect(profit.roi).toMatchObject({ value: 2, denominator: 500 })
  })

  it('权限分页签放行：缺 orders.read、finance.read、field.profit、ads.read 时对应页签写“无权限”，也不去查那些表', async () => {
    const { call, prisma } = await open(['analytics.read'])
    const { cost, profit, ads, items } = (await call('GET', '/promotions/pr1')).json.data
    expect(cost.discount.state).toBe('RESTRICTED')
    expect(cost.platformFee.state).toBe('RESTRICTED')
    expect(cost.total).toBeNull()
    expect(profit.state).toBe('RESTRICTED')
    expect(ads.state).toBe('RESTRICTED')
    expect(items.items[0].productId).toBeNull()
    for (const model of ['orderItem', 'fbaFeeEvent', 'profitDaily', 'fbaProduct']) {
      const calls = Object.values(prisma[model] ?? {}).flatMap(fn => fn.mock.calls)
      expect(calls, model).toHaveLength(0)
    }
  })

  it('商品：折扣力度、商品主数据链接（有 products.read）、商品级问题', async () => {
    const { call } = await open(FULL)
    const { items, issues } = (await call('GET', '/promotions/pr1')).json.data
    expect(items).toMatchObject({ state: 'OK', total: 2, truncated: false })
    expect(items.items[0]).toMatchObject({ asin: 'B0AAAAAAA1', sku: 'SKU-1', productId: 'p1', productTitle: '示例商品', benefitText: '立减 20%', perCustomerUses: 1 })
    expect(items.items[1]).toMatchObject({ asin: 'B0AAAAAAA2', productId: null, issues: [{ code: 'X', severity: 'ERROR' }] })
    expect(issues).toMatchObject({ state: 'OK', itemIssueCount: 1, promotionIssues: [{ code: 'PRICE_NEAR_FLOOR', severity: 'WARNING' }] })
  })

  it('同期有其他促销的日子不进基线：有效日不足时不给增量，不拿 0 或凑数', async () => {
    const other = { startAt: new Date(`${shift(baselineFrom, 0)}T20:00:00Z`), endAt: new Date(`${shift(startDay, -3)}T20:00:00Z`) }
    const { call, prisma } = await open(FULL, { promotion: { findMany: vi.fn().mockResolvedValue([other]), findFirst: vi.fn().mockResolvedValue(promotionRecord()) } })
    const { effect, profit } = (await call('GET', '/promotions/pr1')).json.data
    expect(effect.state).toBe('INSUFFICIENT')
    expect(effect.baseline).toMatchObject({ state: 'INSUFFICIENT', usedDays: 2 })
    expect(effect.actual).toEqual({ units: 300, sales: 6000 })
    expect(effect.expected).toEqual({ units: null, sales: null })
    expect(effect.incremental).toEqual({ units: null, sales: null, liftPct: null })
    expect(effect.note).toContain('不给增量估算')
    expect(profit.state).toBe('INSUFFICIENT')
    expect(profit.incrementalProfit).toBeNull()
    expect(profit.roi.value).toBeNull()
    expect(prisma.promotion.findMany.mock.calls[0][0].where.id).toEqual({ not: 'pr1' })
  })

  it('按目录选品、还没开始、已取消：各页签直接说明原因，不去算', async () => {
    const catalog = await open(FULL, {
      promotion: { findMany: none(), findFirst: vi.fn().mockResolvedValue(promotionRecord({ selectionType: 'CATALOG', itemCount: null })) },
      promotionItem: { findMany: none() },
    })
    const first = (await catalog.call('GET', '/promotions/pr1')).json.data
    expect(first.effect).toMatchObject({ state: 'NO_ITEMS', actual: { units: null, sales: null } })
    expect(first.items).toMatchObject({ state: 'NO_ITEMS', items: [] })
    expect(first.cost.state).toBe('NO_ITEMS')
    expect(first.profit.state).toBe('NO_ITEMS')
    expect(catalog.prisma.asinDailySummary.groupBy).not.toHaveBeenCalled()
    await harness?.close()
    const future = await open(FULL, {
      promotion: { findMany: none(), findFirst: vi.fn().mockResolvedValue(promotionRecord({ status: 'UPCOMING', startAt: new Date(`${shift(today, 5)}T20:00:00Z`) })) },
    })
    const upcoming = (await future.call('GET', '/promotions/pr1')).json.data
    expect([upcoming.effect.state, upcoming.cost.state, upcoming.profit.state, upcoming.ads.state]).toEqual(['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'])
    expect(upcoming.cost.feePreview).not.toBeNull()
    await harness?.close()
    const cancelled = await open(FULL, { promotion: { findMany: none(), findFirst: vi.fn().mockResolvedValue(promotionRecord({ status: 'CANCELLED' })) } })
    expect((await cancelled.call('GET', '/promotions/pr1')).json.data.effect.state).toBe('NO_EFFECT')
  })

  it('绩效报告没有这个促销：写“尚无记录”；折扣金额全空写“尚无记录”，不是 0', async () => {
    const { call } = await open(FULL, {
      promotionMetric: { groupBy: none() },
      orderItem: { aggregate: vi.fn().mockResolvedValue({ _sum: { promotionDiscount: null }, _count: { _all: 8, promotionDiscount: 0 } }) },
    })
    const { effect, cost, profit } = (await call('GET', '/promotions/pr1')).json.data
    expect(effect.reported).toMatchObject({ state: 'NO_RECORD', units: null, sales: null })
    expect(effect.reported.note).toContain('尚无记录')
    expect(cost.discount).toMatchObject({ state: 'NO_DATA', amount: null, orderLines: 8 })
    expect(cost.total).toBeNull()
    expect(profit.roi.value).toBeNull()
    expect(profit.note).toContain('不给促销投入回报率')
  })

  it('广告：店铺没有绑定广告账户写“尚未接入”', async () => {
    const { call } = await open(FULL)
    expect((await call('GET', '/promotions/pr1')).json.data.ads).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
  })
})
