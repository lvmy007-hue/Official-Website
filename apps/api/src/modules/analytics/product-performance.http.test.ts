import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 商品表现宽表接口（P6-22）：权限先于参数校验、七个维度聚合、本期上期涨跌、汇总行等于明细之和（精确到分）、列权限降级、SKU 维度多 SKU 的口径、迷你趋势与慢指标。

const dec = (value: string) => ({ toString: () => value })
const day = (text: string) => new Date(`${text}T00:00:00Z`)
const RANGE = 'from=2026-10-08&to=2026-10-14&compare=previous'
const BASE = ['analytics.read']
const PATH = '/analytics/product-performance'

const product = (id: string, asin: string, sku: string, over: Record<string, unknown> = {}) => ({
  id,
  sellerAccountId: 's1',
  asin,
  sellerSku: sku,
  title: `商品 ${asin}`,
  imageUrl: null,
  parentAsin: 'B0PARENT01',
  brand: '甲牌',
  categoryPath: '家居',
  ownerUserId: 'u1',
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const PRODUCTS = [
  product('p1', 'B0AAAAAAA1', 'SKU-A1'),
  product('p2', 'B0AAAAAAA2', 'SKU-A2'),
  product('p3', 'B0AAAAAAA3', 'SKU-A3A', { parentAsin: null, brand: '乙牌', ownerUserId: null }),
  product('p4', 'B0AAAAAAA3', 'SKU-A3B', { parentAsin: null, brand: '乙牌', ownerUserId: null }),
]

const sum = (over: Record<string, unknown>) => ({ sellerAccountId: 's1', _avg: { buyBoxPct: dec('0.9') }, ...over })
const NOW_FACTS = [
  sum({ asin: 'B0AAAAAAA1', _sum: { units: 10, salesAmount: dec('100.005'), sessions: 200, pageViews: 400, adsSpend: dec('20'), adsSales: dec('80') } }),
  sum({ asin: 'B0AAAAAAA2', _sum: { units: 5, salesAmount: dec('40.5'), sessions: 100, pageViews: 150, adsSpend: null, adsSales: null } }),
  sum({ asin: 'B0AAAAAAA3', _sum: { units: 2, salesAmount: dec('10.25'), sessions: 40, pageViews: 60, adsSpend: dec('1.1'), adsSales: dec('3') } }),
]
const BEFORE_FACTS = [sum({ asin: 'B0AAAAAAA1', _sum: { units: 5, salesAmount: dec('50'), sessions: 100, pageViews: 200, adsSpend: dec('20'), adsSales: dec('40') } })]

const profitGroup = (sku: string, asin: string, profit: string, over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  sku,
  asin,
  _count: { _all: 3 },
  _sum: { revenue: dec('100'), refunds: dec('10'), profit: dec(profit), productCost: dec('30'), firstMileCost: dec('5'), units: 10, costedUnits: 10, ...over },
})

function stub(permissions: string[]) {
  const base = sessionStub(permissions)
  const prisma = {
    ...base,
    membership: { ...base.membership, findMany: vi.fn().mockResolvedValue([{ userId: 'u1', user: { displayName: '王五', email: 'w@x.com' } }]) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue(PRODUCTS), groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', asin: 'B0AAAAAAA3', _count: { _all: 2 } }]) },
    asinDailySummary: {
      groupBy: vi.fn().mockImplementation(async (args: { by: string[]; where: { summaryDate: { gte: Date } } }) => {
        if (args.by.includes('summaryDate')) return [{ sellerAccountId: 's1', asin: 'B0AAAAAAA1', summaryDate: day('2026-10-09'), _sum: { salesAmount: dec('30.5') } }]
        return args.where.summaryDate.gte.getTime() === day('2026-10-08').getTime() ? NOW_FACTS : BEFORE_FACTS
      }),
    },
    salesTrafficAsinDaily: {
      groupBy: vi.fn().mockResolvedValue([
        { sellerAccountId: 's1', asin: 'B0AAAAAAA1', source: 'DATA_KIOSK', _sum: { ordersCount: 8, b2bSales: dec('12.5') } },
        { sellerAccountId: 's1', asin: 'B0AAAAAAA1', source: 'REPORT', _sum: { ordersCount: 99, b2bSales: dec('99') } },
      ]),
    },
    profitDaily: {
      groupBy: vi.fn().mockImplementation(async (args: { where: { profit?: null; profitDate: { gte: Date } } }) => {
        if (args.where.profit === null) return []
        return args.where.profitDate.gte.getTime() === day('2026-10-08').getTime() ? [profitGroup('SKU-A1', 'B0AAAAAAA1', '40'), profitGroup('SKU-A3A', 'B0AAAAAAA3', '7.5')] : []
      }),
    },
    fbaInventoryRecord: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ sellerAccountId: 's1', sellerSku: 'SKU-A1', fulfillableQuantity: 70, inboundWorkingQuantity: 5, inboundShippedQuantity: 10, inboundReceivingQuantity: 0 }]),
    },
    fbaReturnCase: { findFirst: vi.fn().mockResolvedValue({ id: 'r1' }), groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', asin: 'B0AAAAAAA1', _sum: { quantity: 1 } }]) },
    reviewMetricSnapshot: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', asin: 'B0AAAAAAA1', avgRating: dec('4.5'), ratingCount: 100 }]) },
  }
  return prisma
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[] = BASE) => {
  const prisma = stub(permissions)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const post = async (action: string, body: unknown, permissions: string[] = BASE) => {
  const { call } = await open(permissions)
  const response = await call('POST', `${PATH}/${action}?${RANGE}`, { body })
  expect(response.status).toBe(200)
  return response.json.data
}

describe('权限与参数', () => {
  it('未登录 401；没有 analytics.read 403 且先于参数校验，不读任何业务数据', async () => {
    const { call, prisma } = await open(['orders.read'])
    expect((await call('POST', `${PATH}/query`, { auth: false, body: {} })).status).toBe(401)
    const denied = await call('POST', `${PATH}/query?${RANGE}`, { body: { dimension: '不存在' } })
    expect(denied.status).toBe(403)
    expect(prisma.fbaProduct.findMany).not.toHaveBeenCalled()
  })

  it('排序字段只能是白名单；维度、页大小、展开父体的维度不合法都是 422', async () => {
    const { call } = await open()
    for (const body of [{ sort: { field: 'acoas', direction: 'desc' } }, { dimension: 'xx' }, { pageSize: 201 }, { dimension: 'sku', parentAsin: 'B0PARENT01' }]) {
      expect((await call('POST', `${PATH}/query?${RANGE}`, { body })).status).toBe(422)
    }
  })

  it('按没有权限的列排序 403', async () => {
    const { call } = await open()
    expect((await call('POST', `${PATH}/query?${RANGE}`, { body: { sort: { field: 'grossProfit', direction: 'desc' } } })).status).toBe(403)
  })
})

describe('ASIN 维度', () => {
  it('销售额从高到低；本期、上期、涨跌；比率用合计重算；订单量与 B2B 只取数据中心来源', async () => {
    const data = await post('query', {}, [...BASE, 'ads.read'])
    expect(data.items.map((item: { id: string }) => item.id)).toEqual(['asin:B0AAAAAAA1', 'asin:B0AAAAAAA2', 'asin:B0AAAAAAA3'])
    const first = data.items[0]
    expect(first.metrics.sales).toEqual({ value: 100.01, previous: 50, change: 1 + 0.0002 })
    expect(first.metrics.units).toEqual({ value: 10, previous: 5, change: 1 })
    expect(first.metrics.acos.value).toBe(0.25)
    expect(first.metrics.tacos.value).toBeCloseTo(0.1999, 3)
    expect(first.metrics.conversion.value).toBe(0.05)
    expect(first.metrics.orders.value).toBe(8)
    expect(first.metrics.b2bSales.value).toBe(12.5)
    expect(data.items[1].metrics.adSpend).toEqual({ value: null, previous: null, change: null })
    expect(data.total).toBe(3)
    expect(data.compare).toMatchObject({ mode: 'previous', from: '2026-10-01', to: '2026-10-07' })
  })

  it('没有利润、广告、库存权限时：利润列不返回，restrictions 写明原因；有广告权限才有广告列', async () => {
    const data = await post('query', {})
    expect(data.items[0].metrics.grossProfit).toBeUndefined()
    expect(data.items[0].metrics.adSpend).toBeUndefined()
    const groups = data.restrictions.map((item: { group: string }) => item.group)
    expect(groups).toEqual(expect.arrayContaining(['profit', 'inventory']))
    expect(data.allowed).not.toContain('grossProfit')
    const withAds = await post('query', {}, [...BASE, 'ads.read'])
    expect(withAds.items[0].metrics.adSpend.value).toBe(20)
    expect(withAds.items[0].metrics.acos.value).toBe(0.25)
  })

  it('没有 ads.read 时广告列整组不返回', async () => {
    const data = await post('query', {})
    expect(data.items[0].metrics.adSpend).toBeUndefined()
    expect(data.allowed).not.toContain('adSpend')
  })

  it('没有来源的指标（ACoAS、CPC 等）值为 null 并写原因，不当 0', async () => {
    const data = await post('query', {}, [...BASE, 'ads.read'])
    expect(data.items[0].metrics.cpc.value).toBeNull()
    expect(data.gaps.cpc).toContain('没有接入')
  })

  it('筛选：关键词、品牌、展开父体', async () => {
    expect((await post('query', { q: 'a2' })).items.map((item: { id: string }) => item.id)).toEqual(['asin:B0AAAAAAA2'])
    expect((await post('query', { brand: '乙牌' })).items.map((item: { id: string }) => item.id)).toEqual(['asin:B0AAAAAAA3'])
    const children = await post('query', { parentAsin: 'B0PARENT01' })
    expect(children.items.map((item: { id: string }) => item.id)).toEqual(['asin:B0AAAAAAA1', 'asin:B0AAAAAAA2'])
  })

  it('只取可见列', async () => {
    const data = await post('query', { metrics: ['sales', 'units'] })
    expect(Object.keys(data.items[0].metrics).sort()).toEqual(['sales', 'units'])
  })

  it('分页：total 是全部行数，页内只给这一页', async () => {
    const data = await post('query', { page: 2, pageSize: 2 })
    expect(data.items).toHaveLength(1)
    expect(data.total).toBe(3)
  })
})

describe('其他维度', () => {
  it('父 ASIN：合并名下子体，可展开；没有父体的 ASIN 自己是父体', async () => {
    const data = await post('query', { dimension: 'parentAsin' })
    const parent = data.items.find((item: { id: string }) => item.id === 'parentAsin:B0PARENT01')
    expect(parent.metrics.sales.value).toBe(140.51)
    expect(parent.metrics.units.value).toBe(15)
    expect(parent.hasChildren).toBe(true)
    expect(parent.childCount).toBe(2)
    expect(data.items.find((item: { id: string }) => item.id === 'parentAsin:B0AAAAAAA3').hasChildren).toBe(false)
  })

  it('负责人、品牌：没有设置的归到“未设置”，负责人显示成员姓名', async () => {
    const owners = await post('query', { dimension: 'owner' })
    expect(owners.items.map((item: { title: string }) => item.title).sort()).toEqual(['未设置负责人', '王五'])
    const brands = await post('query', { dimension: 'brand' })
    expect(brands.items.find((item: { id: string }) => item.id === 'brand:甲牌').metrics.units.value).toBe(15)
  })

  it('店铺与品类', async () => {
    expect((await post('query', { dimension: 'store' })).items[0]).toMatchObject({ id: 'store:s1', title: '美国主店' })
    expect((await post('query', { dimension: 'category' })).items[0].id).toBe('category:家居')
  })

  it('SKU：ASIN 在店铺下只有一个 SKU 才归到该 SKU；多个 SKU 时销售流量留空并写原因', async () => {
    const data = await post('query', { dimension: 'sku' })
    const single = data.items.find((item: { id: string }) => item.id === 'sku:s1:SKU-A1')
    expect(single.metrics.sales.value).toBe(100.01)
    const shared = data.items.find((item: { id: string }) => item.id === 'sku:s1:SKU-A3A')
    expect(shared.metrics.sales.value).toBeNull()
    expect(shared.gaps.sales).toContain('多个 SKU')
  })
})

describe('利润列与汇总行', () => {
  const PROFIT = [...BASE, 'profit.read', 'field.profit']
  it('有利润权限：毛利、毛利率、净销售额；没有成本字段时没有 ROI；有成本字段才有', async () => {
    const data = await post('query', {}, PROFIT)
    const first = data.items[0].metrics
    expect(first.grossProfit.value).toBe(40)
    expect(first.margin.value).toBe(0.4)
    expect(first.netSales.value).toBe(90.01)
    expect(first.roi).toBeUndefined()
    const withCost = await post('query', {}, [...PROFIT, 'field.cost'])
    expect(withCost.items[0].metrics.roi.value).toBeCloseTo(40 / 35, 5)
  })

  it('汇总行等于明细之和（金额精确到分），比率用合计重算，不是平均', async () => {
    const list = await post('query', { pageSize: 200 }, [...PROFIT, 'ads.read'])
    const total = await post('summary', {}, [...PROFIT, 'ads.read'])
    const cents = (key: string) => Math.round(list.items.reduce((acc: number, item: { metrics: Record<string, { value: number | null }> }) => acc + (item.metrics[key]?.value ?? 0), 0) * 100) / 100
    for (const key of ['sales', 'units', 'adSpend', 'adSales', 'grossProfit', 'netSales']) expect(total.totals[key]).toBe(cents(key))
    expect(total.totals.sales).toBe(150.76)
    expect(total.totals.acos).toBeCloseTo(21.1 / 83, 5)
    expect(total.totals.conversion).toBeCloseTo(17 / 340, 5)
    expect(total.rowCount).toBe(3)
  })

  it('汇总行按筛选：只合计符合条件的行', async () => {
    const total = await post('summary', { brand: '甲牌' })
    expect(total.totals.sales).toBe(140.51)
  })
})

describe('迷你趋势与慢指标', () => {
  it('趋势：一行一个逐日序列，没记录的日子是 null；超过 100 行 422', async () => {
    const data = await post('trend', { ids: ['asin:B0AAAAAAA1'], metric: 'sales' })
    expect(data.days).toHaveLength(7)
    expect(data.rows['asin:B0AAAAAAA1'].trend).toEqual([null, 30.5, null, null, null, null, null])
    const { call } = await open()
    const ids = Array.from({ length: 101 }, (_, index) => `asin:B0AAAAA${index}`)
    expect((await call('POST', `${PATH}/trend?${RANGE}`, { body: { ids } })).status).toBe(422)
  })

  it('广告花费趋势需要广告读取权限', async () => {
    const { call } = await open()
    expect((await call('POST', `${PATH}/trend?${RANGE}`, { body: { ids: ['asin:B0AAAAAAA1'], metric: 'adSpend' } })).status).toBe(403)
  })

  it('慢指标：没有库存权限不返回库存；评分、退货率按行返回', async () => {
    const data = await post('async-columns', { ids: ['asin:B0AAAAAAA1'] })
    expect(data.rows['asin:B0AAAAAAA1']).toEqual({ returnRate: 0.1, rating: 4.5 })
    const withStock = await post('async-columns', { ids: ['asin:B0AAAAAAA1'] }, [...BASE, 'inventory.read'])
    expect(withStock.rows['asin:B0AAAAAAA1']).toMatchObject({ fbaAvailable: 70, inbound: 15, daysOfSupply: 49 })
  })

  it('退货率：从没同步过退货记录时不给值并写原因', async () => {
    const prisma = stub(BASE)
    prisma.fbaReturnCase.findFirst.mockResolvedValue(null as never)
    harness = await createTestApp(prisma)
    const response = await harness.call('POST', `${PATH}/async-columns?${RANGE}`, { body: { ids: ['asin:B0AAAAAAA1'], metrics: ['returnRate'] } })
    expect(response.json.data.gaps.returnRate).toContain('尚未接入')
    expect(response.json.data.rows).toEqual({})
  })
})
