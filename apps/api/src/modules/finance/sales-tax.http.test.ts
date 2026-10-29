import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 销售税接口（P2b-12）：权限先于参数校验、数据范围、按州与辖区汇总、月度趋势与对账、每家店的取得情况、没有数据时的说明。
// 对账判定与月份切分的口径在 api-contracts 的 sales-tax.test.ts 里逐条验证，这里验证接口把它们串起来。

const dec = (value: string) => ({ toString: () => value })
const FROM = '2026-09-01'
const TO = '2026-10-15'
const QUERY = `from=${FROM}&to=${TO}`

type Args = { by: string[]; where: Record<string, unknown> }
const freshnessRow = (sellerAccountId: string, over: Record<string, unknown>) => ({
  sellerAccountId,
  sourceKey: 'rpt.sales-tax',
  lastAttemptAt: new Date(),
  lastSuccessAt: null,
  dataThrough: null,
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}, empty = false) {
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: {
      findMany: vi.fn().mockResolvedValue([
        { id: 's1', displayName: '美国主店' },
        { id: 's2', displayName: '美国二店' },
      ]),
    },
    salesTaxSummary: {
      groupBy: vi.fn().mockImplementation(async (args: Args) => {
        if (empty) return []
        if (args.by.length === 1 && args.by[0] === 'state') {
          return [
            { state: 'CA', _sum: { taxCollected: dec('60'), taxableSales: null, lineCount: 8 } },
            { state: 'WA', _sum: { taxCollected: dec('150'), taxableSales: dec('1000'), lineCount: 20 } },
          ]
        }
        if (args.by.includes('jurisdictionKey')) {
          return [
            { state: 'CA', jurisdictionKey: '', taxKind: 'SALES_TAX', _sum: { taxCollected: dec('60'), taxableSales: null, lineCount: 8 } },
            { state: 'WA', jurisdictionKey: '', taxKind: 'SALES_TAX', _sum: { taxCollected: dec('50'), taxableSales: dec('300'), lineCount: 6 } },
            { state: 'WA', jurisdictionKey: 'KING COUNTY', taxKind: 'SALES_TAX', _sum: { taxCollected: dec('100'), taxableSales: dec('700'), lineCount: 14 } },
          ]
        }
        // 按店铺的月度合计：九月两家店都有，十月只有主店
        const gte = (args.where.taxPeriod as { gte: Date }).gte.toISOString().slice(0, 7)
        return gte === '2026-09'
          ? [
              { sellerAccountId: 's1', _sum: { taxCollected: dec('120') } },
              { sellerAccountId: 's2', _sum: { taxCollected: dec('40') } },
            ]
          : [{ sellerAccountId: 's1', _sum: { taxCollected: dec('50') } }]
      }),
    },
    orderCharge: {
      groupBy: vi.fn().mockImplementation(async (args: { where: { purchaseDate: { gte: Date } } }) => {
        if (empty) return []
        return args.where.purchaseDate.gte.toISOString().slice(0, 7) === '2026-09'
          ? [{ sellerAccountId: 's1', _sum: { amount: dec('120.02') } }]
          : [
              { sellerAccountId: 's1', _sum: { amount: dec('80') } },
              { sellerAccountId: 's2', _sum: { amount: dec('5') } },
            ]
      }),
    },
    dataFreshness: {
      findMany: vi
        .fn()
        .mockResolvedValue(empty ? [] : [freshnessRow('s1', { lastSuccessAt: new Date('2026-10-22T01:00:00Z') }), freshnessRow('s2', { status: 'UNAUTHORIZED', lastErrorCode: 'TAX_ROLE_PENDING' })]),
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
const open = async (permissions: string[], over: Record<string, unknown> = {}, empty = false) => {
  const prisma = stub(permissions, over, empty)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const read = async (path = `/finance/sales-tax?${QUERY}`) => {
  const { call } = await open(['finance.tax.read'])
  return (await call('GET', path)).json.data
}

describe('权限与参数', () => {
  it('未登录 401；没有 finance.tax.read 403 且先于参数校验，一条数据都不查', async () => {
    const { call } = await open(['finance.tax.read'])
    expect((await call('GET', '/finance/sales-tax', { auth: false })).status).toBe(401)
    const denied = await open(['finance.read'])
    expect((await denied.call('GET', '/finance/sales-tax?from=not-a-date')).status).toBe(403)
    expect(denied.prisma.salesTaxSummary.groupBy).not.toHaveBeenCalled()
    expect(denied.prisma.orderCharge.groupBy).not.toHaveBeenCalled()
  })

  it('日期格式不对 422；范围收窄到一个店铺时报告与订单的每个查询都带店铺条件', async () => {
    const scoped = { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } }
    const { call, prisma } = await open(['finance.tax.read'], scoped)
    expect((await call('GET', '/finance/sales-tax?from=nope&to=2026-10-01')).status).toBe(422)
    expect((await call('GET', `/finance/sales-tax?${QUERY}`)).status).toBe(200)
    for (const mock of [prisma.salesTaxSummary.groupBy, prisma.orderCharge.groupBy]) {
      expect(mock.mock.calls.length).toBeGreaterThan(0)
      for (const [args] of mock.mock.calls) expect(JSON.stringify(args.where)).toMatch(/tenant-1[\s\S]*s1/)
    }
  })
})

describe('按州汇总', () => {
  it('州按税额从高到低，带占比、应税销售额与辖区明细；报告没给应税销售额的州是空（不是 0）', async () => {
    const data = await read()
    expect(data.state).toBe('OK')
    expect(data.states.map((row: { state: string }) => row.state)).toEqual(['WA', 'CA'])
    expect(data.states[0]).toMatchObject({ state: 'WA', taxCollected: 150, taxableSales: 1000, lineCount: 20, share: 0.7143 })
    expect(data.states[0].jurisdictions.map((item: { jurisdictionKey: string; taxCollected: number }) => [item.jurisdictionKey, item.taxCollected])).toEqual([
      ['KING COUNTY', 100],
      ['', 50],
    ])
    expect(data.states[0].jurisdictions[0]).toMatchObject({ taxKind: 'SALES_TAX', taxKindLabel: '销售税', taxableSales: 700, lineCount: 14 })
    expect(data.states[1]).toMatchObject({ state: 'CA', taxCollected: 60, taxableSales: null, share: 0.2857 })
    expect(data.totals).toEqual({ taxCollected: 210, taxableSales: 1000, ordersTax: 205.02 })
    expect(data.jurisdictionsTruncated).toBe(false)
    expect(data.currency).toBe('USD')
  })

  it('辖区明细读到上限被截断时标出（各州合计不受影响）', async () => {
    const many = Array.from({ length: 3001 }, (_, index) => ({ state: 'WA', jurisdictionKey: `J${index}`, taxKind: 'SALES_TAX', _sum: { taxCollected: dec('1'), taxableSales: null, lineCount: 1 } }))
    const base = stub(['finance.tax.read']).salesTaxSummary.groupBy
    const { call } = await open(['finance.tax.read'], {
      salesTaxSummary: { groupBy: vi.fn().mockImplementation(async (args: Args) => (args.by.includes('jurisdictionKey') ? many : base(args))) },
    })
    const data = (await call('GET', `/finance/sales-tax?${QUERY}`)).json.data
    expect(data.jurisdictionsTruncated).toBe(true)
    expect(data.states.find((row: { state: string }) => row.state === 'WA').jurisdictions).toHaveLength(3000)
    expect(data.states.find((row: { state: string }) => row.state === 'WA').taxCollected).toBe(150)
  })
})

describe('趋势与对账', () => {
  it('按月给出报告与订单合计，起止日是范围内的部分（首尾月不满月）', async () => {
    const data = await read()
    expect(data.range).toEqual({ from: FROM, to: TO, defaulted: false, clamped: false })
    expect(data.trend).toEqual([
      { month: '2026-09', from: '2026-09-01', to: '2026-09-30', reportTax: 160, ordersTax: 120.02 },
      { month: '2026-10', from: '2026-10-01', to: '2026-10-15', reportTax: 50, ordersTax: 85 },
    ])
  })

  it('每家店每月对账：容差内一致；差太多有差异；一边没有记录就写没有，不当 0 算差额', async () => {
    const data = await read()
    const rows = data.reconciliation.map((row: { storeName: string; month: string; reportTax: number | null; ordersTax: number | null; diff: number | null; state: string }) => [
      row.storeName,
      row.month,
      row.reportTax,
      row.ordersTax,
      row.diff,
      row.state,
    ])
    expect(rows).toEqual([
      ['美国主店', '2026-09', 120, 120.02, -0.02, 'MATCHED'],
      ['美国二店', '2026-09', 40, null, null, 'NO_ORDERS'],
      ['美国主店', '2026-10', 50, 80, -30, 'DIFFERENT'],
      ['美国二店', '2026-10', null, 5, null, 'NO_REPORT'],
    ])
    expect(data.reconciliation[0].stateLabel).toBe('一致')
  })

  it('范围太长时只保留最近 14 个月并标出 clamped；没选日期默认最近 90 天', async () => {
    const long = await read('/finance/sales-tax?from=2025-01-01&to=2026-10-15')
    expect(long.range).toMatchObject({ from: '2025-09-01', to: '2026-10-15', clamped: true })
    expect(long.trend).toHaveLength(14)
    const { call } = await open(['finance.tax.read'])
    const today = new Date().toISOString().slice(0, 10)
    const defaulted = (await call('GET', '/finance/sales-tax')).json.data.range
    expect(defaulted).toMatchObject({ to: today, defaulted: true, clamped: false })
    expect(Math.round((Date.parse(`${defaulted.to}T00:00:00Z`) - Date.parse(`${defaulted.from}T00:00:00Z`)) / 86_400_000)).toBe(89)
  })

  it('订单只按美元、税额类（TAX）汇总，按下单时间落在各月内（右端不含）', async () => {
    const { call, prisma } = await open(['finance.tax.read'])
    await call('GET', `/finance/sales-tax?${QUERY}`)
    const calls = prisma.orderCharge.groupBy.mock.calls.map(([args]) => args.where)
    expect(calls).toHaveLength(2)
    for (const where of calls) expect(where).toMatchObject({ chargeKind: 'TAX', currency: 'USD' })
    expect(calls[1].purchaseDate.gte.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(calls[1].purchaseDate.lt.toISOString()).toBe('2026-10-16T00:00:00.000Z')
  })
})

describe('取得情况与来源', () => {
  it('每家店各有状态：已取得；缺受限角色写“未授权：需申请受限角色”；没记录写“尚无记录”', async () => {
    const { call } = await open(['finance.tax.read'])
    const data = (await call('GET', `/finance/sales-tax?${QUERY}`)).json.data
    expect(data.stores[0]).toMatchObject({ storeName: '美国主店', state: 'AVAILABLE', stateLabel: '已取得', lastSuccessAt: '2026-10-22T01:00:00.000Z' })
    expect(data.stores[1]).toMatchObject({ storeName: '美国二店', state: 'ROLE_PENDING', stateLabel: '未授权' })
    expect(data.stores[1].note).toContain('未授权：需申请')
    const none = await open(['finance.tax.read'], { dataFreshness: { findMany: vi.fn().mockResolvedValue([]) } })
    const empty = (await none.call('GET', `/finance/sales-tax?${QUERY}`)).json.data.stores
    expect(empty.map((store: { state: string }) => store.state)).toEqual(['NO_RECORD', 'NO_RECORD'])
  })

  it('报告还没生成与同步失败分别说明；失败写中文原因而不是错误码', async () => {
    const rows = [freshnessRow('s1', { status: 'WAITING_DEPENDENCY', lastErrorCode: 'TAX_NOT_GENERATED' }), freshnessRow('s2', { status: 'FAILED', lastErrorCode: 'PARSE_HEADER' })]
    const { call } = await open(['finance.tax.read'], { dataFreshness: { findMany: vi.fn().mockResolvedValue(rows) } })
    const stores = (await call('GET', `/finance/sales-tax?${QUERY}`)).json.data.stores
    expect(stores[0]).toMatchObject({ state: 'NOT_GENERATED', stateLabel: '待生成' })
    expect(stores[0].note).toContain('需在卖家后台')
    expect(stores[1]).toMatchObject({ state: 'FAILED', stateLabel: '同步失败' })
    expect(stores[1].note).toContain('格式发生变化')
    expect(stores[1].note).not.toContain('PARSE_HEADER')
  })

  it('三个来源：报告、订单接口有数据显示合计；发货报告写“尚未接入”，没有合计', async () => {
    const data = await read()
    expect(data.sources.map((item: { source: string; state: string; total: number | null }) => [item.source, item.state, item.total])).toEqual([
      ['TAX_LIBRARY', 'OK', 210],
      ['ORDER_API', 'OK', 205.02],
      ['SHIPMENT_REPORT', 'NOT_CONNECTED', null],
    ])
    expect(data.sources[2].note).toContain('尚未接入')
    expect(data.basis).toContain('不含收货州')
    expect(data.freshness).toMatchObject({ lastSuccessAt: expect.any(String) })
  })
})

describe('没有数据', () => {
  it('报告与订单税额都没有：NO_DATA 与原因，合计是空而不是 0，各来源写没有数据', async () => {
    const { call } = await open(['finance.tax.read'], {}, true)
    const data = (await call('GET', `/finance/sales-tax?${QUERY}`)).json.data
    expect(data.state).toBe('NO_DATA')
    expect(data.note).toContain('税务文档库')
    expect(data.totals).toEqual({ taxCollected: null, taxableSales: null, ordersTax: null })
    expect(data.states).toEqual([])
    expect(data.reconciliation).toEqual([])
    expect(data.trend.every((point: { reportTax: number | null; ordersTax: number | null }) => point.reportTax === null && point.ordersTax === null)).toBe(true)
    expect(data.sources.slice(0, 2).map((item: { state: string; total: number | null }) => [item.state, item.total])).toEqual([
      ['NO_DATA', null],
      ['NO_DATA', null],
    ])
  })
})
