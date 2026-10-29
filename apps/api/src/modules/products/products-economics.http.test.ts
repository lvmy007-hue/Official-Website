import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'

// ASIN 360 的“利润与成本”“退货”两个页签（P2b-17）：权限先于参数校验、字段权限、范围收窄、每件经济折算、没有数据与受限的显示。
// 取数的真实查询在 apps/api/src/testing/products-economics.db.test.ts；折算纯函数的细节在 product-economics-math.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const dec = (value: number) => ({ toString: () => String(value) })
const day = (date: string) => new Date(`${date}T00:00:00Z`)

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  asin: 'B0TEST0001',
  sellerSku: 'SKU-1',
  title: '示例商品',
  price: dec(19.9),
  currency: 'USD',
  sellerAccount: { displayName: '店铺一' },
  ...over,
})

// 10 件、销售额 200：退款 10、佣金 30、促销 10（比例项 25%），配送费 40、采购 50、头程 10 → 净利润 50
const SUM = {
  units: 10,
  costedUnits: 10,
  revenue: dec(200),
  refunds: dec(10),
  feeCommission: dec(30),
  feeFulfillment: dec(40),
  feeStorage: dec(0),
  feeAged: dec(0),
  feeInbound: dec(0),
  feeOther: dec(0),
  promotion: dec(10),
  adsSpendAllocated: null,
  adsUnallocated: null,
  productCost: dec(50),
  firstMileCost: dec(10),
  otherCost: null,
  reimbursement: dec(0),
  profit: dec(50),
  productCostOriginal: null,
  firstMileCostOriginal: null,
}

function stub(permissions: string[], over: Record<string, any> = {}) {
  return prismaFor(permissions, {
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    fbaProduct: { findFirst: vi.fn().mockResolvedValue(product()), findMany: vi.fn().mockResolvedValue([{ sellerSku: 'SKU-1' }, { sellerSku: 'SKU-2' }]) },
    profitDaily: {
      aggregate: vi.fn().mockResolvedValue({ _sum: SUM, _count: { _all: 3 } }),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi
        .fn()
        .mockImplementation((args: { where: { profit?: null } }) => Promise.resolve(args.where.profit === null ? [] : [{ profitDate: day('2026-10-05'), _sum: SUM, _count: { _all: 3 } }])),
      findMany: vi.fn().mockResolvedValue([]),
    },
    economicsDaily: { findMany: vi.fn().mockResolvedValue([]) },
    economicsPreview: { aggregate: vi.fn().mockResolvedValue({ _max: { queriedAt: null } }), findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    fbaReturnCase: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: null } }), groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) },
    asinDailySummary: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) },
    reimbursementOpportunity: { findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  })
}

const FULL = ['products.read', 'profit.read', 'field.profit', 'field.cost', 'finance.read', 'returns.read', 'reimbursements.read']
const RANGE = 'from=2026-10-01&to=2026-10-10'

async function call(permissions: string[], path: string, over: Record<string, any> = {}) {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { res: await harness.call('GET', path), prisma }
}

describe('权限：先于参数校验，也先于读数据', () => {
  it.each([
    ['economics', ['products.read', 'field.profit']],
    ['economics/official', ['products.read', 'field.profit', 'field.cost']],
    ['economics/preview', ['products.read']],
    ['economics/costs', ['products.read', 'field.cost']],
    ['returns', ['products.read']],
  ])('%s 缺少对应读取权限：403，坏参数也不会先看到 422，也不读业务表', async (path, permissions) => {
    const { res, prisma } = await call(permissions, `/products/p1/${path}?from=bad&recognition=x`)
    expect(res.status).toBe(403)
    expect(prisma.profitDaily.aggregate).not.toHaveBeenCalled()
    expect(prisma.economicsDaily.findMany).not.toHaveBeenCalled()
    expect(prisma.fbaReturnCase.aggregate).not.toHaveBeenCalled()
  })

  it('没有 products.read：所有新路由 403', async () => {
    for (const path of ['economics', 'economics/official', 'economics/preview', 'economics/costs', 'returns']) {
      await harness?.close()
      expect((await call(['profit.read', 'field.profit', 'field.cost', 'finance.read', 'costs.read', 'returns.read'], `/products/p1/${path}`)).res.status, path).toBe(403)
    }
  })

  it('利润与成本需要利润字段权限；官方对照需要利润与成本两个字段权限；成本时间线需要成本字段权限', async () => {
    // profit.read 在新角色里不再带出利润字段权限
    const noField = await call(['products.read', 'profit.read'], '/products/p1/economics')
    expect(noField.res.status).toBe(403)
    expect(noField.res.json.error.message).toContain('field.profit')
    expect(noField.prisma.profitDaily.aggregate).not.toHaveBeenCalled()
    await harness?.close()
    const noCost = await call(['products.read', 'finance.read', 'field.profit'], '/products/p1/economics/official')
    expect(noCost.res.status).toBe(403)
    expect(noCost.res.json.error.message).toContain('field.cost')
    expect(noCost.prisma.economicsDaily.findMany).not.toHaveBeenCalled()
    await harness?.close()
    expect((await call(['products.read', 'costs.read'], '/products/p1/economics/costs')).res.status).toBe(403)
  })

  it('商品不在成员数据范围内或不存在：404，不泄露存在性', async () => {
    for (const path of ['economics', 'economics/official', 'economics/preview', 'returns']) {
      await harness?.close()
      const prisma = stub(FULL)
      prisma.fbaProduct.findFirst.mockResolvedValue(null)
      harness = await createTestApp(prisma)
      expect((await harness.call('GET', `/products/p1/${path}`)).status, path).toBe(404)
      expect(prisma.fbaProduct.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p1', tenantId: 'tenant-1', marketplaceId: 'ATVPDKIKX0DER' })
      expect(prisma.profitDaily.aggregate).not.toHaveBeenCalled()
    }
  })
})

describe('利润与成本：单位经济', () => {
  it('每件折算：平均售价、每件净利润、比例项占比；只读这个商品（店铺 × SKU）自己的行', async () => {
    const { res, prisma } = await call(FULL, `/products/p1/economics?${RANGE}`)
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', recognition: 'ORDERED', currency: 'USD', range: { from: '2026-10-01', to: '2026-10-10', days: 10, defaulted: false }, listPrice: 19.9, costCoverage: 1 })
    expect(data.unit).toMatchObject({ state: 'OK', units: 10, avgPrice: 20, netPerUnit: 5, proportionalShare: 0.25 })
    const line = (key: string) => data.unit.lines.find((item: { key: string }) => item.key === key)
    expect(line('REVENUE')).toMatchObject({ perUnit: 20, link: 'PRICE' })
    expect(line('COMMISSION')).toMatchObject({ perUnit: 3, link: 'PROPORTIONAL', contribution: -3 })
    expect(line('FULFILLMENT')).toMatchObject({ perUnit: 4, link: 'FIXED' })
    expect(line('PRODUCT_COST')).toMatchObject({ perUnit: 5, state: 'OK' })
    expect(line('DUTY')).toMatchObject({ perUnit: null, state: 'NO_DATA' })
    expect(line('NET_PROFIT')).toBeUndefined()
    expect(data.bridge.netProfit).toBe(50)
    expect(data.trend).toEqual([{ date: '2026-10-05', revenue: 200, profit: 50, coveredProfit: 50 }])
    expect(data.winPrice.state).toBe('NOT_CONNECTED')
    const where = prisma.profitDaily.aggregate.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 'tenant-1', basis: 'ORDERED', sellerAccountId: 's1', sku: 'SKU-1' })
  })

  it('收入确认口径可选；不合法的口径是 422（通过权限后才校验）', async () => {
    const shipped = await call(FULL, `/products/p1/economics?${RANGE}&recognition=SHIPPED`)
    expect(shipped.res.json.data.recognition).toBe('SHIPPED')
    expect(shipped.prisma.profitDaily.aggregate.mock.calls[0][0].where.basis).toBe('SHIPPED')
    await harness?.close()
    expect((await call(FULL, '/products/p1/economics?recognition=bogus')).res.status).toBe(422)
    await harness?.close()
    expect((await call(FULL, '/products/p1/economics?from=nope&to=2026-10-10')).res.status).toBe(422)
  })

  it('没选日期范围：默认最近 30 天并写明', async () => {
    const { res } = await call(FULL, '/products/p1/economics')
    expect(res.json.data.range).toMatchObject({ days: 30, defaulted: true })
  })

  it('有一行缺成本：净利润整体不给，每件净利润为空，价格模拟不可用，不拿部分数字冒充', async () => {
    const { res } = await call(FULL, `/products/p1/economics?${RANGE}`, { profitDaily: stubProfit({ missing: 2 }) })
    const { data } = res.json
    expect(data.bridge.netProfit).toBeNull()
    expect(data.unit).toMatchObject({ state: 'INCOMPLETE', netPerUnit: null, avgPrice: 20 })
    expect(data.unit.note).toContain('2 行')
  })

  it('没有成本字段权限：成本类项目写“无权限”，成本覆盖率不给；每件净利润仍可用（只依赖利润字段）', async () => {
    const { res } = await call(['products.read', 'profit.read', 'field.profit'], `/products/p1/economics?${RANGE}`)
    const { data } = res.json
    const cost = data.unit.lines.find((item: { key: string }) => item.key === 'PRODUCT_COST')
    expect(cost).toMatchObject({ perUnit: null, state: 'RESTRICTED' })
    expect(data.costCoverage).toBeNull()
    expect(data.unit).toMatchObject({ state: 'OK', netPerUnit: 5 })
    expect(data.unit.lines.filter((item: { state: string }) => item.state === 'RESTRICTED').map((item: { key: string }) => item.key)).toEqual(['PRODUCT_COST', 'FIRST_MILE', 'DUTY', 'OTHER_COST'])
  })

  it('范围内没有利润日表行：无数据说明，不是 0', async () => {
    const empty = { aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: { _all: 0 } }), count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn() }
    const { res } = await call(FULL, `/products/p1/economics?${RANGE}`, { profitDaily: empty })
    const { data } = res.json
    expect(data).toMatchObject({ state: 'NO_DATA', trend: [], costCoverage: null })
    expect(data.note).toContain('尚无利润数据')
    expect(data.unit).toMatchObject({ state: 'NO_UNITS', avgPrice: null, netPerUnit: null, lines: [] })
    expect(data.bridge.netProfit).toBeNull()
  })
})

function stubProfit(options: { missing: number }) {
  return {
    aggregate: vi.fn().mockResolvedValue({ _sum: { ...SUM, profit: dec(20) }, _count: { _all: 3 } }),
    count: vi.fn().mockResolvedValue(options.missing),
    groupBy: vi.fn().mockResolvedValue([]),
    findMany: vi.fn(),
  }
}

describe('利润与成本：官方对照', () => {
  const official = (over: Record<string, unknown> = {}) => ({
    sellerAccountId: 's1',
    msku: 'SKU-1',
    asin: 'B0TEST0001',
    date: day('2026-10-05'),
    currency: 'USD',
    netUnits: 5,
    orderedSales: dec(100),
    refundedSales: dec(0),
    sales: dec(100),
    feesTotal: dec(30),
    adsSpend: dec(0),
    sellerCostPerUnit: null,
    netProceeds: dec(70),
    ...over,
  })
  const ours = (over: Record<string, unknown> = {}) => ({
    sellerAccountId: 's1',
    sku: 'SKU-1',
    asin: 'B0TEST0001',
    profitDate: day('2026-10-05'),
    units: 5,
    revenue: dec(100),
    refunds: dec(0),
    feeCommission: dec(15),
    feeFulfillment: dec(15),
    feeStorage: dec(0),
    feeAged: dec(0),
    feeInbound: dec(0),
    feeOther: dec(0),
    adsSpendAllocated: null,
    productCost: null,
    firstMileCost: null,
    otherCost: null,
    profit: null,
    ...over,
  })

  it('只读这个商品自己的官方行与我方行，逐日对照', async () => {
    const profitDaily = {
      findMany: vi.fn().mockResolvedValue([ours()]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { adsSpendAllocated: null, adsUnallocated: null }, _count: { adsSpendAllocated: 0, adsUnallocated: 0 } }),
    }
    const { res, prisma } = await call(FULL, `/products/p1/economics/official?${RANGE}`, { economicsDaily: { findMany: vi.fn().mockResolvedValue([official()]) }, profitDaily })
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', recognition: 'ORDERED', currency: 'USD', officialCoverage: { from: '2026-10-05', to: '2026-10-05' }, truncated: false })
    expect(data.items).toHaveLength(1)
    expect(data.items[0]).toMatchObject({ msku: 'SKU-1', storeName: '店铺一', date: '2026-10-05', verdict: 'MATCH' })
    expect(data.summary).toMatchObject({ rows: 1, comparable: 1, matched: 1 })
    expect(data.summary).not.toHaveProperty('ads')
    expect(prisma.economicsDaily.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', msku: 'SKU-1', aggregation: 'DAY' })
    expect(prisma.profitDaily.findMany.mock.calls[0][0].where).toMatchObject({ sellerAccountId: 's1', sku: 'SKU-1', basis: 'ORDERED' })
  })

  it('官方没有这个商品的记录：无数据说明，不是 0', async () => {
    const { res } = await call(FULL, `/products/p1/economics/official?${RANGE}`, {
      profitDaily: { findMany: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: { adsSpendAllocated: 0, adsUnallocated: 0 } }) },
    })
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', items: [], officialCoverage: null })
    expect(res.json.data.note).toContain('没有官方单品经济记录')
  })

  it('范围超过 90 天：422', async () => {
    expect((await call(FULL, '/products/p1/economics/official?from=2026-06-01&to=2026-10-10')).res.status).toBe(422)
  })
})

describe('利润与成本：费用预览', () => {
  it('只取这个 SKU 在最近一次查询里的行；有费用调整的带影响', async () => {
    const queriedAt = new Date()
    const row = (over: Record<string, unknown>) => ({
      id: 'e1',
      sellerAccountId: 's1',
      msku: 'SKU-1',
      asin: 'B0TEST0001',
      feeType: 'FBA_FULFILLMENT',
      rangeStart: day('2026-10-24'),
      rangeEnd: day('2027-01-01'),
      estimatedAmount: dec(120),
      quantity: dec(30),
      amountPerUnit: dec(4),
      amountPerUnitDelta: dec(0.2),
      currency: 'USD',
      ...over,
    })
    const { res, prisma } = await call(FULL, '/products/p1/economics/preview', {
      economicsPreview: {
        aggregate: vi.fn().mockResolvedValue({ _max: { queriedAt } }),
        findFirst: vi.fn().mockResolvedValue({ id: 'e1' }),
        findMany: vi.fn().mockResolvedValue([row({}), row({ id: 'e2', feeType: 'STORAGE', amountPerUnitDelta: null, quantity: null })]),
      },
    })
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).not.toHaveProperty('pageInfo')
    expect(data.state).toBe('OK')
    expect(data.items[0]).toMatchObject({ feeType: 'FBA_FULFILLMENT', impact: -6, impactState: 'OK' })
    expect(data.summary).toMatchObject({ products: 1, rows: 2, totalImpact: -6 })
    expect(prisma.economicsPreview.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', msku: 'SKU-1', queriedAt })
  })

  it('没有任何预览：说明如何产生，不显示成 0；最近一次查询没有这个 SKU：说明查询日期', async () => {
    const none = await call(FULL, '/products/p1/economics/preview')
    expect(none.res.json.data).toMatchObject({ state: 'NO_DATA', queriedAt: null, items: [] })
    expect(none.res.json.data.note).toContain('尚无记录')
    await harness?.close()
    const missing = await call(FULL, '/products/p1/economics/preview', {
      economicsPreview: {
        aggregate: vi.fn().mockResolvedValue({ _max: { queriedAt: new Date('2026-10-22T03:00:00Z') } }),
        findFirst: vi.fn().mockResolvedValue({ id: 'x' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    })
    expect(missing.res.json.data.state).toBe('NO_DATA')
    expect(missing.res.json.data.note).toContain('2026-10-22')
  })
})

describe('退货页签', () => {
  const returnRow = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    returnDate: new Date('2026-10-08T08:00:00Z'),
    amazonOrderId: '111-0000000-0000001',
    sellerSku: 'SKU-1',
    quantity: 2,
    reason: 'DEFECTIVE',
    disposition: null,
    detailedDisposition: 'CARRIER_DAMAGED',
    ...over,
  })
  const returnsOver = (over: Record<string, any> = {}) => ({
    fbaReturnCase: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 5 } }),
      groupBy: vi.fn().mockImplementation((args: { by: string[] }) =>
        Promise.resolve(
          args.by[0] === 'reason'
            ? [
                { reason: 'DEFECTIVE', _sum: { quantity: 3 } },
                { reason: null, _sum: { quantity: 2 } },
              ]
            : [
                { disposition: null, detailedDisposition: 'SELLABLE', _sum: { quantity: 2 } },
                { disposition: null, detailedDisposition: 'CARRIER_DAMAGED', _sum: { quantity: 3 } },
              ],
        ),
      ),
      findMany: vi.fn().mockImplementation((args: { select: { id?: boolean } }) => Promise.resolve(args.select.id ? [returnRow()] : [{ returnDate: new Date('2026-10-08T08:00:00Z'), quantity: 5 }])),
    },
    asinDailySummary: { groupBy: vi.fn().mockResolvedValue([{ summaryDate: day('2026-10-08'), _sum: { units: 50 } }]), findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  })

  it('总退货与退货率、原因与处置分布、最近退货；只按这个店铺 × ASIN 取', async () => {
    const { res, prisma } = await call(FULL, `/products/p1/returns?${RANGE}`, returnsOver())
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', bucket: 'WEEK', totals: { returnedUnits: 5, soldUnits: 50, rate: 0.1 }, truncated: false })
    expect(data.reasons).toEqual([
      { reason: 'DEFECTIVE', label: '商品有缺陷', units: 3, share: 0.6 },
      { reason: 'UNSPECIFIED', label: '未提供原因', units: 2, share: 0.4 },
    ])
    expect(data.dispositions).toEqual([
      { group: 'CARRIER_DAMAGED', label: '承运人损坏', units: 3, share: 0.6 },
      { group: 'SELLABLE', label: '可售', units: 2, share: 0.4 },
    ])
    expect(data.recent[0]).toMatchObject({ id: 'r1', quantity: 2, reasonLabel: '商品有缺陷', disposition: { group: 'CARRIER_DAMAGED' } })
    expect(data.trend.some((point: { returnedUnits: number; rate: number | null }) => point.returnedUnits === 5 && point.rate === 0.1)).toBe(true)
    expect(data.categoryThemes.state).toBe('NOT_CONNECTED')
    expect(prisma.fbaReturnCase.aggregate.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', asin: 'B0TEST0001' })
    expect(prisma.asinDailySummary.groupBy.mock.calls[0][0].where).toMatchObject({ sellerAccountId: 's1', asin: 'B0TEST0001' })
  })

  it('没有销售汇总：退货率写“没有”（空），不是 0%', async () => {
    const { res } = await call(FULL, `/products/p1/returns?${RANGE}`, returnsOver({ asinDailySummary: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) } }))
    expect(res.json.data.totals).toEqual({ returnedUnits: 5, soldUnits: null, rate: null })
    expect(res.json.data.trend.every((point: { rate: number | null }) => point.rate === null)).toBe(true)
  })

  it('没有退货记录：无数据说明；不选日期默认最近 90 天', async () => {
    const { res } = await call(FULL, '/products/p1/returns')
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', trend: [], reasons: [], dispositions: [], recent: [], range: { defaulted: true } })
    expect(res.json.data.note).toContain('尚无退货记录')
    const { from, to } = res.json.data.range
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(89)
  })

  it('日期不合法：422（通过权限后才校验）', async () => {
    expect((await call(FULL, '/products/p1/returns?from=nope&to=2026-10-10')).res.status).toBe(422)
  })

  it('关联赔付：同 ASIN 各 SKU 的退货类机会与案件；没有赔付读取权限只是受限，不影响退货数据', async () => {
    const opportunity = {
      id: 'o1',
      ruleCode: 'RETURN_DISPOSITION',
      status: 'CASE_CREATED',
      estimatedAmount: dec(24.5),
      currency: 'USD',
      deadlineAt: day('2027-03-01'),
      qty: 2,
      cases: [{ id: 'c1', caseNo: 'RC-20261001-0001', status: 'SUBMITTED', receivedAmount: dec(0) }],
    }
    const withRight = await call(FULL, `/products/p1/returns?${RANGE}`, returnsOver({ reimbursementOpportunity: { findMany: vi.fn().mockResolvedValue([opportunity]) } }))
    const { reimbursements } = withRight.res.json.data
    expect(reimbursements.state).toBe('OK')
    expect(reimbursements.items[0]).toMatchObject({ ruleLabel: expect.stringContaining('处置'), caseId: 'c1', caseNo: 'RC-20261001-0001', estimatedAmount: 24.5, deadlineAt: '2027-03-01' })
    const where = withRight.prisma.reimbursementOpportunity.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', sku: { in: ['SKU-1', 'SKU-2'] }, ruleCode: { in: ['REFUND_NO_RETURN', 'RETURN_DISPOSITION'] } })
    await harness?.close()
    const restricted = await call(['products.read', 'returns.read'], `/products/p1/returns?${RANGE}`, returnsOver())
    expect(restricted.res.json.data.reimbursements).toMatchObject({ state: 'RESTRICTED', items: [] })
    expect(restricted.res.json.data.totals.returnedUnits).toBe(5)
    expect(restricted.prisma.reimbursementOpportunity.findMany).not.toHaveBeenCalled()
    await harness?.close()
    const none = await call(FULL, `/products/p1/returns?${RANGE}`, returnsOver())
    expect(none.res.json.data.reimbursements).toMatchObject({ state: 'NO_DATA', items: [] })
  })
})
