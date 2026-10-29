import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 官方经济数据对账接口（P2b-11）：权限先于参数校验、字段权限（利润与成本）、参数校验、没有数据时的空状态、核对结果、模拟的建任务与轮询。
// 配对与差异口径的细节在 packages/api-contracts/src/economics.test.ts；真实库的查询在 apps/api/src/testing/economics.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const dec = (value: number) => ({ toString: () => String(value) })
const official = (over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  msku: 'SKU-A',
  asin: 'B0A',
  date: new Date('2026-10-05T00:00:00Z'),
  currency: 'USD',
  netUnits: 5,
  orderedSales: dec(100),
  refundedSales: dec(0),
  sales: dec(100),
  feesTotal: dec(30),
  adsSpend: dec(8),
  sellerCostPerUnit: null,
  netProceeds: dec(62),
  ...over,
})
const ours = (over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  sku: 'SKU-A',
  asin: 'B0A',
  profitDate: new Date('2026-10-05T00:00:00Z'),
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

function stub(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    entityEvent: { create: vi.fn().mockResolvedValue({}) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    economicsDaily: { findMany: vi.fn().mockResolvedValue([]) },
    economicsPreview: { groupBy: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    profitDaily: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { adsSpendAllocated: null, adsUnallocated: null }, _count: { adsSpendAllocated: 0, adsUnallocated: 0 } }),
    },
    ...over,
  }
  prisma.$transaction = vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])))
  return prisma
}
const FULL = ['finance.read', 'field.profit', 'field.cost']
const RANGE = 'from=2026-10-01&to=2026-10-10'

async function call(permissions: string[], path: string, over: Record<string, any> = {}) {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { res: await harness.call('GET', path), prisma }
}

describe('权限', () => {
  it.each(['compare', 'preview', 'simulations/x'])('%s：没有 finance.read 先拿 403，不会先看到参数校验细节，也不读数据', async path => {
    const { res, prisma } = await call(['orders.read'], `/finance/economics/${path}?verdict=BAD`)
    expect(res.status).toBe(403)
    expect(prisma.economicsDaily.findMany).not.toHaveBeenCalled()
    expect(prisma.economicsPreview.groupBy).not.toHaveBeenCalled()
  })

  it('双源核对同时含利润与成本：缺任何一个字段权限都是 403 并说明缺哪些；费用预览只需要 finance.read', async () => {
    // 旧权限 finance.read 展开后有利润字段权限但没有成本字段权限
    const noCost = await call(['finance.read'], `/finance/economics/compare?${RANGE}`)
    expect(noCost.res.status).toBe(403)
    expect(noCost.res.json.error.code).toBe('TENANT_ACCESS_DENIED')
    expect(noCost.res.json.error.message).toContain('field.cost')
    expect(noCost.prisma.economicsDaily.findMany).not.toHaveBeenCalled()
    await harness?.close()
    expect((await call(['finance.read', 'field.cost'], `/finance/economics/compare?${RANGE}`)).res.status).toBe(200)
    await harness?.close()
    expect((await call(['finance.read'], `/finance/economics/preview?${RANGE}`)).res.status).toBe(200)
  })

  it('模拟：没有 finance.read 是 403（先于参数校验）', async () => {
    harness = await createTestApp(stub(['orders.read']))
    expect((await harness.call('POST', '/finance/economics/simulate', { body: { bad: true } })).status).toBe(403)
  })
})

describe('参数校验', () => {
  it.each([
    ['compare?verdict=BAD'],
    ['compare?recognition=x'],
    ['compare?pageSize=0'],
    ['compare?sort=bogus'],
    ['compare?from=2026-10-10&to=2026-10-01'],
    ['compare?from=2026-06-01&to=2026-10-10'], // 超过 90 天
    ['preview?changedOnly=yes'],
    ['preview?pageSize=1000'],
  ])('%s → 422', async path => {
    const { res } = await call(FULL, `/finance/economics/${path}`)
    expect(res.status).toBe(422)
  })

  it('坏游标返回 400，不是 422', async () => {
    process.env.JWT_SECRET ??= 'x'.repeat(40)
    const { res } = await call(FULL, `/finance/economics/compare?${RANGE}&cursor=forged.value`)
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('CURSOR_INVALID')
  })

  it.each([
    [{ sellerAccountId: 's1', sku: 'A', actionType: 'AWD' }], // 缺数量
    [{ sellerAccountId: 's1', sku: 'A', actionType: 'SIPP', quantity: 5 }], // SIPP 不要数量
    [{ sellerAccountId: 's1', sku: '', actionType: 'SIPP' }],
    [{ sellerAccountId: 's1', sku: 'A', actionType: 'FBA' }],
  ])('模拟请求体不合法 → 422', async body => {
    harness = await createTestApp(stub(FULL))
    expect((await harness.call('POST', '/finance/economics/simulate', { body })).status).toBe(422)
  })
})

describe('没有数据', () => {
  it('双源核对：空状态说明，不是 0，不报错；没选范围默认最近 30 天并写明', async () => {
    const { res } = await call(FULL, '/finance/economics/compare')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      state: 'NO_DATA',
      currency: 'USD',
      recognition: 'ORDERED',
      range: { days: 30, defaulted: true },
      items: [],
      officialCoverage: null,
      truncated: false,
      summary: { comparable: 0, netDiff: null, official: { sales: null }, ads: { state: 'NO_DATA', official: null } },
    })
    expect(res.json.data.note).toContain('尚无记录')
  })

  it('费用预览：没有任何行与有行但都已过期，分别给出不同说明', async () => {
    const empty = await call(FULL, '/finance/economics/preview')
    expect(empty.res.json.data).toMatchObject({ state: 'NO_DATA', queriedAt: null, horizon: null, items: [], summary: { totalImpact: null, rows: 0 } })
    expect(empty.res.json.data.note).toContain('尚无记录')
    await harness?.close()
    const stale = await call(FULL, '/finance/economics/preview', {
      economicsPreview: { groupBy: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue({ id: 'old' }), findMany: vi.fn() },
    })
    expect(stale.res.json.data.note).toContain('不再展示')
  })
})

describe('双源核对结果', () => {
  it('官方有广告扣款而我方没有分摊：归广告口径；带企业、范围、口径条件；店铺广告核对写“尚未接入”', async () => {
    const { res, prisma } = await call(FULL, `/finance/economics/compare?${RANGE}&recognition=SETTLED`, {
      economicsDaily: { findMany: vi.fn().mockResolvedValue([official(), official({ msku: 'SKU-B', asin: 'B0B' })]) },
      profitDaily: {
        findMany: vi.fn().mockResolvedValue([ours()]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { adsSpendAllocated: null, adsUnallocated: null }, _count: { adsSpendAllocated: 0, adsUnallocated: 0 } }),
      },
    })
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    expect(data.officialCoverage).toEqual({ from: '2026-10-05', to: '2026-10-05' })
    const a = data.items.find((item: { msku: string }) => item.msku === 'SKU-A')
    expect(a).toMatchObject({ storeName: '美国主店', verdict: 'ADS', parts: { ADS: -8 }, impact: { net: -8 } })
    const b = data.items.find((item: { msku: string }) => item.msku === 'SKU-B')
    expect(b).toMatchObject({ verdict: 'NOT_COMPARABLE', notComparable: 'OURS_NO_RECORD', impact: null })
    expect(data.summary).toMatchObject({ rows: 2, comparable: 1, notComparable: 1, netDiff: -8, ads: { state: 'NOT_CONNECTED', official: 16 } })
    const where = prisma.profitDaily.findMany.mock.calls[0]![0].where
    expect(where).toMatchObject({ tenantId: 'tenant-1', basis: 'SETTLED' })
    expect(prisma.economicsDaily.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1', aggregation: 'DAY' })
  })

  it('结论过滤与搜索：只看差异、按 SKU 搜索；摘要按过滤后的行汇总', async () => {
    const over = {
      economicsDaily: { findMany: vi.fn().mockResolvedValue([official(), official({ msku: 'SKU-B', adsSpend: dec(0), netProceeds: dec(70) })]) },
      profitDaily: {
        findMany: vi.fn().mockResolvedValue([ours(), ours({ sku: 'SKU-B' })]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { adsSpendAllocated: null, adsUnallocated: null }, _count: { adsSpendAllocated: 0, adsUnallocated: 0 } }),
      },
    }
    const diff = await call(FULL, `/finance/economics/compare?${RANGE}&verdict=DIFF`, over)
    expect(diff.res.json.data.items.map((item: { msku: string }) => item.msku)).toEqual(['SKU-A'])
    await harness?.close()
    const match = await call(FULL, `/finance/economics/compare?${RANGE}&verdict=MATCH&q=sku-b`, over)
    expect(match.res.json.data.items.map((item: { msku: string }) => item.msku)).toEqual(['SKU-B'])
    expect(match.res.json.data.summary).toMatchObject({ rows: 1, matched: 1 })
  })
})

describe('费用预览结果', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'r1',
    sellerAccountId: 's1',
    msku: 'SKU-A',
    asin: 'B0A',
    feeType: 'FBA_FULFILLMENT_FEES',
    rangeStart: new Date('2026-10-23T00:00:00Z'),
    rangeEnd: new Date('2027-01-14T00:00:00Z'),
    estimatedAmount: dec(300),
    quantity: dec(100),
    amountPerUnit: dec(3),
    amountPerUnitDelta: null,
    currency: 'USD',
    queriedAt: new Date('2026-10-23T08:00:00Z'),
    ...over,
  })

  it('每个店铺只看最近一次查询；有调整的排前面，按 −单件变化 × 数量算影响；没有预估数量不估算', async () => {
    const recent = new Date(Date.now() - 3600_000)
    const { res, prisma } = await call(FULL, '/finance/economics/preview', {
      economicsPreview: {
        groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { queriedAt: recent } }]),
        findFirst: vi.fn().mockResolvedValue({ id: 'r1' }),
        findMany: vi.fn().mockResolvedValue([
          row({ id: 'r1' }),
          row({
            id: 'r2',
            rangeStart: new Date('2027-01-15T00:00:00Z'),
            rangeEnd: new Date('2027-02-18T00:00:00Z'),
            estimatedAmount: dec(360),
            amountPerUnit: dec(3.6),
            amountPerUnitDelta: dec(0.6),
          }),
          row({ id: 'r3', feeType: 'REFERRAL_FEES', amountPerUnitDelta: dec(0.1), quantity: null, estimatedAmount: dec(50) }),
        ]),
      },
    })
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    expect(data.items.map((item: { key: string }) => item.key)).toEqual(['r2', 'r3', 'r1'])
    expect(data.items[0]).toMatchObject({ impact: -60, impactState: 'OK', storeName: '美国主店' })
    expect(data.items[1]).toMatchObject({ impact: null, impactState: 'UNKNOWN_QUANTITY' })
    expect(data.items[2]).toMatchObject({ impact: null, impactState: 'NO_CHANGE' })
    expect(data.summary).toMatchObject({ products: 1, rows: 3, changedRows: 2, unknownRows: 1, totalImpact: -60 })
    expect(data.summary.byFeeType[0]).toMatchObject({ feeType: 'FBA_FULFILLMENT_FEES', rows: 2, estimated: 660, impact: -60 })
    expect(data.horizon).toEqual({ from: '2026-10-23', to: '2027-02-18' })
    expect(prisma.economicsPreview.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1', OR: [{ sellerAccountId: 's1', queriedAt: recent }] })
  })
})

describe('情景模拟', () => {
  const body = { sellerAccountId: 's1', sku: 'SKU-A', actionType: 'AWD', quantity: 500, endInDays: 30 }
  const over = (extra: Record<string, any> = {}) => ({
    platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1' }) },
    syncJob: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({ id: 'job-1', priority: 1 }), findFirst: vi.fn() },
    economicsSimulationRun: { create: vi.fn().mockResolvedValue({ id: 'run-1' }), update: vi.fn().mockResolvedValue({}), findFirst: vi.fn() },
    ...extra,
  })

  it('没有授权连接 409；同时在途太多 409；成功建运行与同步任务并入队（SIPP 不带数量，可带单价）', async () => {
    harness = await createTestApp(stub(FULL, over({ platformConnection: { findFirst: vi.fn().mockResolvedValue(null) } })))
    expect((await harness.call('POST', '/finance/economics/simulate', { body })).status).toBe(409)
    await harness.close()
    harness = await createTestApp(stub(FULL, over({ syncJob: { count: vi.fn().mockResolvedValue(5), create: vi.fn() } })))
    expect((await harness.call('POST', '/finance/economics/simulate', { body })).status).toBe(409)
    await harness.close()

    const prisma = stub(FULL, over())
    harness = await createTestApp(prisma)
    const sipp = { sellerAccountId: 's1', sku: 'SKU-A', actionType: 'SIPP', itemPrice: 19.99 }
    const res = await harness.call('POST', '/finance/economics/simulate', { body: sipp })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ runId: 'run-1', status: 'PENDING', result: null, input: { actionType: 'SIPP', quantity: null, itemPrice: 19.99 } })
    expect(prisma.syncJob.create.mock.calls[0][0].data).toMatchObject({
      type: 'DATA_KIOSK_QUERY',
      context: { dataset: 'dk.economics-simulation', params: { runId: 'run-1', sku: 'SKU-A', actionType: 'SIPP', price: '19.99', sellerAccountId: 's1' } },
    })
    expect(prisma.syncJob.create.mock.calls[0][0].data.context.params).not.toHaveProperty('quantity')
    expect(prisma.economicsSimulationRun.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', actionType: 'SIPP', createdBy: 'user-1' })
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ syncJobId: 'job-1' }), 'job-1', expect.objectContaining({ type: 'DATA_KIOSK_QUERY' }))
  })

  it('轮询：按任务状态给出进行中、完成、失败；没有利润字段权限时净收入不给；不存在 404；只暴露合计', async () => {
    const run = (extra: Record<string, unknown> = {}) => ({
      id: 'run-1',
      sellerAccountId: 's1',
      actionType: 'AWD',
      syncJobId: 'job-1',
      startDate: new Date('2026-10-23T00:00:00Z'),
      endDate: new Date('2026-11-22T00:00:00Z'),
      inputJson: { sellerAccountId: 's1', sku: 'SKU-A', actionType: 'AWD', quantity: 500, itemPrice: null, startDate: '2026-10-23', endDate: '2026-11-22' },
      resultJson: { currency: 'USD', sales: 100, fees: 30, netProceeds: 70, units: 4, rows: 3, entries: { x: 1 } },
      ...extra,
    })
    for (const [status, expected] of [
      ['PENDING', 'PENDING'],
      ['RUNNING', 'PENDING'],
      ['SUCCEEDED', 'DONE'],
      ['FAILED', 'FAILED'],
    ] as const) {
      harness = await createTestApp(stub(FULL, over({ economicsSimulationRun: { findFirst: vi.fn().mockResolvedValue(run()) }, syncJob: { findFirst: vi.fn().mockResolvedValue({ status }) } })))
      const { data } = (await harness.call('GET', '/finance/economics/simulations/run-1')).json
      expect(data.status).toBe(expected)
      expect(data.result).toEqual(expected === 'DONE' ? { currency: 'USD', sales: 100, fees: 30, netProceeds: 70, units: 4, rows: 3 } : null)
      await harness.close()
    }
    harness = await createTestApp(stub(FULL, over({ economicsSimulationRun: { findFirst: vi.fn().mockResolvedValue(null) } })))
    expect((await harness.call('GET', '/finance/economics/simulations/none')).status).toBe(404)
  })
})
