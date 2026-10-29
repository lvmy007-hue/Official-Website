import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 销量统计接口（P6-25）：权限先于参数校验；每个日期一列、小计、粒度日周月（周起始日读业务口径）；维度；SKU 维度多 SKU ASIN 不拆分；
// 可用库存按业务口径、周转天数；没有记录的日期是 null 而不是 0；日期列超上限 422；读取行数达到上限提示截断。

const dec = (value: string) => ({ toString: () => value })
const day = (text: string) => new Date(`${text}T00:00:00Z`)
const RANGE = 'from=2026-10-08&to=2026-10-14'
const PATH = '/analytics/sales-stat'
const BASE = ['analytics.read']

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
const PRODUCTS = [product('p1', 'B0AAAAAAA1', 'SKU-A1'), product('p2', 'B0AAAAAAA3', 'SKU-A3A', { ownerUserId: null }), product('p3', 'B0AAAAAAA3', 'SKU-A3B', { ownerUserId: null })]
const cell = (asin: string, date: string, units: number | null, sales: string | null) => ({
  sellerAccountId: 's1',
  asin,
  summaryDate: day(date),
  _sum: { units, salesAmount: sales === null ? null : dec(sales) },
})
const DAILY = [cell('B0AAAAAAA1', '2026-10-09', 4, '40'), cell('B0AAAAAAA1', '2026-10-10', 6, '60.5'), cell('B0AAAAAAA1', '2026-10-13', 0, '0'), cell('B0AAAAAAA3', '2026-10-09', 2, '20')]
const STOCK = [{ sellerAccountId: 's1', sellerSku: 'SKU-A1', fulfillableQuantity: 70, reservedQuantity: 10, inboundWorkingQuantity: 5, inboundShippedQuantity: 0, inboundReceivingQuantity: 0 }]

function stub(options: { permissions?: string[]; daily?: unknown[]; rules?: unknown } = {}) {
  const base = sessionStub(options.permissions ?? BASE)
  return {
    ...base,
    membership: { ...base.membership, findMany: vi.fn().mockResolvedValue([{ userId: 'u1', user: { displayName: '王五', email: 'w@x.com' } }]) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    metricVersion: { findMany: vi.fn().mockResolvedValue(options.rules ? [options.rules] : []) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue(PRODUCTS) },
    asinDailySummary: { groupBy: vi.fn().mockResolvedValue(options.daily ?? DAILY) },
    fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue(STOCK) },
  }
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (options: Parameters<typeof stub>[0] = {}) => {
  const prisma = stub(options)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const get = async (query = '', options: Parameters<typeof stub>[0] = {}) => {
  const { call } = await open(options)
  const response = await call('GET', `${PATH}?${RANGE}${query ? `&${query}` : ''}`)
  expect(response.status).toBe(200)
  return response.json.data
}

describe('权限与参数', () => {
  it('未登录 401；没有 analytics.read 403 且先于参数校验，不读任何业务数据', async () => {
    const { call, prisma } = await open({ permissions: ['orders.read'] })
    expect((await call('GET', PATH, { auth: false })).status).toBe(401)
    expect((await call('GET', `${PATH}?${RANGE}&dimension=不存在`)).status).toBe(403)
    expect(prisma.asinDailySummary.groupBy).not.toHaveBeenCalled()
    expect(prisma.fbaInventoryRecord.findMany).not.toHaveBeenCalled()
  })

  it('维度、粒度、排序非法返回 422', async () => {
    const { call } = await open()
    for (const query of ['dimension=brand', 'granularity=YEAR', 'metric=profit', 'sort=sessions:asc', 'pageSize=999']) {
      expect((await call('GET', `${PATH}?${RANGE}&${query}`)).status, query).toBe(422)
    }
  })

  it('按日粒度的日期列超过 120 个返回 422 并说明', async () => {
    const { call } = await open()
    const response = await call('GET', `${PATH}?from=2026-01-01&to=2026-10-14`)
    expect(response.status).toBe(422)
    expect(JSON.stringify(response.json)).toContain('日期列最多 120 个')
  })
})

describe('每个日期一列与小计', () => {
  it('ASIN 维度：七个日期列，没有记录的日期是 null，小计只加有值的格', async () => {
    const data = await get()
    expect(data.buckets).toEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'])
    const row = data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
    expect(row.values).toEqual([null, 4, 6, null, null, 0, null])
    expect(row.total).toBe(10)
    expect(row.units).toBe(10)
    expect(data.summary.values).toEqual([null, 6, 6, null, null, 0, null])
    expect(data.summary.total).toBe(12)
    expect(data.total).toBe(2)
  })

  it('切换到销售额：同一套行，值换成销售额，周转天数仍按销量', async () => {
    const data = await get('metric=sales')
    const row = data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
    expect(row.values).toEqual([null, 40, 60.5, null, null, 0, null])
    expect(row.total).toBe(100.5)
    expect(row.turnoverDays).toBe(49)
  })

  it('可用库存默认只算可售；周转天数 = 可用库存 ÷（范围销量 ÷ 范围天数）；没有库存记录是 null', async () => {
    const data = await get()
    const row = data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
    expect(row.availableStock).toBe(70)
    expect(row.turnoverDays).toBe(49)
    const other = data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA3')
    expect(other.availableStock).toBeNull()
    expect(other.turnoverDays).toBeNull()
    expect(data.inventoryBasis).toContain('可售')
  })

  it('可用库存口径改成“可售 + 预留”后列值跟着变', async () => {
    const rules = { kind: 'BUSINESS_RULES', versionNo: 2, effectiveFrom: day('2026-01-01'), config: { availableInventory: { components: ['FULFILLABLE', 'RESERVED'] } } }
    const data = await get('', { rules })
    const row = data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
    expect(row.availableStock).toBe(80)
    expect(data.inventoryBasis).toContain('预留')
  })
})

describe('粒度与周起始日', () => {
  it('按周：默认周一起始，桶以起始日命名，边缘的桶只含范围内的天', async () => {
    const data = await get('granularity=WEEK')
    expect(data.buckets).toEqual(['2026-10-05', '2026-10-12'])
    expect(data.weekStart).toBe('MON')
    const row = data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
    expect(row.values).toEqual([10, 0])
  })

  it('周起始日读业务口径：改成周日后桶起始日变化', async () => {
    const rules = { kind: 'BUSINESS_RULES', versionNo: 3, effectiveFrom: day('2026-01-01'), config: { weekStart: { day: 'SUN' } } }
    const data = await get('granularity=WEEK', { rules })
    expect(data.buckets).toEqual(['2026-10-04', '2026-10-11'])
    expect(data.weekStart).toBe('SUN')
    const row = data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
    expect(row.values).toEqual([10, 0])
  })

  it('按月：一个桶，起始日是当月 1 日', async () => {
    const data = await get('granularity=MONTH')
    expect(data.buckets).toEqual(['2026-10-01'])
    expect(data.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1').values).toEqual([10])
  })
})

describe('维度', () => {
  it('SKU 维度：只有单 SKU 的 ASIN 归到 SKU，多 SKU 的 ASIN 对应的 SKU 行没有数值并写明原因', async () => {
    const data = await get('dimension=sku&sort=title:asc')
    const bySku = Object.fromEntries(data.rows.map((item: { sku: string }) => [item.sku, item]))
    expect(bySku['SKU-A1'].total).toBe(10)
    expect(bySku['SKU-A3A'].total).toBeNull()
    expect(bySku['SKU-A3A'].gap).toContain('多个 SKU')
    expect(bySku['SKU-A3B'].values.every((value: number | null) => value === null)).toBe(true)
    expect(data.note).toContain('不含它们的销量')
    expect(data.summary.total).toBe(10)
  })

  it('父 ASIN、店铺、负责人维度合并多个 ASIN；负责人显示成员名，没设置的单独一行', async () => {
    const parent = await get('dimension=parentAsin')
    expect(parent.rows).toHaveLength(1)
    expect(parent.rows[0].total).toBe(12)
    const store = await get('dimension=store')
    expect(store.rows[0].title).toBe('美国主店')
    expect(store.rows[0].total).toBe(12)
    const owner = await get('dimension=owner&sort=title:asc')
    expect(owner.rows.map((item: { title: string }) => item.title).sort()).toEqual(['未设置负责人', '王五'])
  })

  it('搜索按 ASIN、SKU、标题过滤', async () => {
    const data = await get('q=a3a')
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0].asin).toBe('B0AAAAAAA3')
  })
})

describe('排序、分页与截断', () => {
  it('按小计升序，空值排最后；分页返回总行数', async () => {
    const asc = await get('sort=total:asc')
    expect(asc.rows.map((item: { total: number }) => item.total)).toEqual([2, 10])
    const stocked = await get('sort=availableStock:desc')
    expect(stocked.rows.map((item: { asin: string }) => item.asin)).toEqual(['B0AAAAAAA1', 'B0AAAAAAA3'])
    const paged = await get('pageSize=1&page=2&sort=total:desc')
    expect(paged.rows).toHaveLength(1)
    expect(paged.total).toBe(2)
    expect(paged.rows[0].asin).toBe('B0AAAAAAA3')
  })

  it('读取行数超过上限时 truncated 为 true 并带说明字段', async () => {
    const big = Array.from({ length: 20_000 }, (_, index) => cell(`B0${String(index).padStart(8, '0')}`, '2026-10-09', 1, '1'))
    const data = await get('', { daily: big })
    expect(data.truncated).toBe(true)
  })

  it('范围内没有任何销售记录：NO_DATA，不是 0', async () => {
    const data = await get('', { daily: [] })
    expect(data.state).toBe('NO_DATA')
    expect(data.rows).toEqual([])
  })

  it('每个查询都带企业条件', async () => {
    const { call, prisma } = await open()
    await call('GET', `${PATH}?${RANGE}`)
    expect(prisma.asinDailySummary.groupBy.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1', currency: 'USD' })
    expect(prisma.fbaInventoryRecord.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1' })
  })
})
