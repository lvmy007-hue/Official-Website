import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 回款与现金流接口（P2b-08）：权限先于参数校验、数据范围、各区块（余额、递延与释放、打款预测、按周预测、到账核对）、
// 不可用来源显示原因而不是 0、到账登记（新建、改正、冲突、校验）。预测数值的口径在 api-contracts 的 cashflow.test.ts 里逐条验证。
// 日期都相对“今天”（企业时区设成 UTC），避免测试随日期漂移。

const dec = (value: string) => ({ toString: () => value })
const DAY = 86_400_000
const dayText = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)
const at = (offset: number) => new Date(`${dayText(offset)}T00:00:00Z`)

const settlementPoint = (offset: number, over: Record<string, unknown> = {}) => ({
  id: `st${offset}`,
  sellerAccountId: 's1',
  externalSettlementId: `EXT${offset}`,
  currency: 'USD',
  settlementEndDate: at(offset),
  depositDate: at(offset + 3),
  disbursementAmount: dec('500'),
  ...over,
})
// 三张结算单：周期结束日 今天-31、-17、-3（周期 14 天），打款日各晚 3 天——最近一张的打款日就是今天（已公布、未过）
const HISTORY = [settlementPoint(-3), settlementPoint(-17), settlementPoint(-31)]
const listRow = (offset: number, over: Record<string, unknown> = {}) => ({
  ...settlementPoint(offset),
  sellerAccount: { displayName: '美国主店' },
  disbursement: null,
  ...over,
})
const savedDisbursement = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  disbursedAt: at(-13),
  amount: dec('500'),
  currency: 'USD',
  bankLast4: '6789',
  note: '已核对',
  version: 1,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  updatedAt: new Date('2026-10-20T00:00:00Z'),
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const guards = createWriteGuardStubs()
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    accountBalanceSnapshot: {
      findMany: vi.fn().mockResolvedValue([
        { sellerAccountId: 's1', accountType: 'PAYABLE', currency: 'USD', amount: dec('120.5'), snapshotDate: at(-1) },
        { sellerAccountId: 's1', accountType: 'PAYABLE', currency: 'USD', amount: dec('99'), snapshotDate: at(-2) },
      ]),
    },
    fbaFinancialTransaction: {
      groupBy: vi.fn().mockImplementation(async (args: { by: string[] }) => {
        if (args.by.includes('maturityAt')) {
          return [
            { sellerAccountId: 's1', currency: 'USD', maturityAt: at(5), _sum: { amount: dec('80') }, _count: { _all: 2 } },
            { sellerAccountId: 's1', currency: 'USD', maturityAt: null, _sum: { amount: dec('20') }, _count: { _all: 1 } },
          ]
        }
        if (args.by.includes('sellerAccountId')) return [{ sellerAccountId: 's1', currency: 'USD', _sum: { amount: dec('2800') }, _count: { _all: 40 } }]
        return [{ currency: 'USD', _sum: { amount: dec('60') }, _count: { _all: 3 } }]
      }),
    },
    fbaSettlement: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { where: Record<string, unknown> }) =>
          'settlementEndDate' in args.where ? HISTORY : [listRow(-3), listRow(-17, { disbursement: savedDisbursement() }), listRow(-31)],
        ),
      findFirst: vi.fn().mockResolvedValue({ ...settlementPoint(-3), sellerAccount: { displayName: '美国主店' }, reconciliation: null }),
    },
    disbursement: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'd9', version: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: 'd1', version: 2 }),
    },
    purchasePayment: {
      findMany: vi.fn().mockResolvedValue([
        { amount: dec('300'), currency: 'USD', plannedAt: at(1) },
        { amount: dec('100'), currency: 'CNY', plannedAt: at(2) },
        { amount: dec('50'), currency: 'USD', plannedAt: null },
      ]),
    },
    firstMileShipment: { findMany: vi.fn().mockResolvedValue([{ estimatedCost: dec('200'), currency: 'USD', etaPort: at(9), etaDelivery: null, shipDate: null }]) },
    adsMetric: { aggregate: vi.fn().mockResolvedValue({ _sum: { cost: dec('140') }, _count: { _all: 14 } }) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  }
  Object.assign(prisma.membership as object, { findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '财务小王', email: 'w@example.com' } }]) })
  prisma.auditEvent = guards.auditEvent
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[], over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const reopen = async (permissions: string[], over: Record<string, unknown> = {}) => {
  await harness?.close()
  return open(permissions, over)
}
const ALL = ['finance.read', 'purchase.read', 'firstmile.read', 'ads.read']

describe('权限与范围', () => {
  it('未登录 401；没有 finance.read 403 且先于参数校验；没有 finance.reconcile 不能登记', async () => {
    const { call } = await open(['finance.read'])
    expect((await call('GET', '/finance/cashflow', { auth: false })).status).toBe(401)
    expect((await call('POST', '/finance/disbursements/confirm', { auth: false, body: {} })).status).toBe(401)
    const denied = await reopen(['seller.read'])
    expect((await denied.call('GET', '/finance/cashflow?currency=usd&weeks=99')).status).toBe(403)
    expect(denied.prisma.fbaSettlement.findMany).not.toHaveBeenCalled()
    const readOnly = await reopen(['finance.read'])
    expect((await readOnly.call('POST', '/finance/disbursements/confirm', { body: { amount: -1 } })).status).toBe(403)
    expect(readOnly.prisma.disbursement.create).not.toHaveBeenCalled()
  })

  it('参数不合法 422；范围收窄到一个店铺时所有查询都带店铺条件，采购与头程因没有店铺归属显示“不适用”且不查', async () => {
    const scoped = { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } }
    const { call, prisma } = await open(ALL, scoped)
    expect((await call('GET', '/finance/cashflow?currency=usd')).status).toBe(422)
    expect((await call('GET', '/finance/cashflow?weeks=14')).status).toBe(422)
    const res = await call('GET', '/finance/cashflow')
    expect(res.status).toBe(200)
    for (const mock of [prisma.accountBalanceSnapshot.findMany, prisma.fbaFinancialTransaction.groupBy]) {
      for (const [args] of mock.mock.calls) expect(JSON.stringify(args.where)).toMatch(/tenant-1[\s\S]*s1/)
    }
    for (const [args] of prisma.fbaSettlement.findMany.mock.calls) expect(JSON.stringify(args.where)).toMatch(/tenant-1[\s\S]*s1/)
    const sources = res.json.data.forecast.sources
    expect(sources.find((item: { label: string }) => item.label === '采购付款')).toMatchObject({ state: 'OUT_OF_SCOPE', total: null })
    expect(sources.find((item: { label: string }) => item.label === '头程付款')).toMatchObject({ state: 'OUT_OF_SCOPE' })
    expect(prisma.purchasePayment.findMany).not.toHaveBeenCalled()
    expect(prisma.firstMileShipment.findMany).not.toHaveBeenCalled()
    expect(JSON.stringify(prisma.adsMetric.aggregate.mock.calls[0][0].where)).toContain('s1')
  })
})

describe('读取', () => {
  it('余额只有递延余额（每个账户类型取最近一次），可用余额写明没有官方接口', async () => {
    const { call } = await open(ALL)
    const { balances, asOf, currencies } = (await call('GET', '/finance/cashflow')).json.data
    expect(asOf).toBe(dayText(0))
    expect(currencies).toEqual(['USD'])
    expect(balances.items).toEqual([{ sellerAccountId: 's1', storeName: '美国主店', accountType: 'PAYABLE', label: '递延余额（PAYABLE）', currency: 'USD', amount: 120.5, asOf: dayText(-1) }])
    expect(balances.totals).toEqual([{ currency: 'USD', amount: 120.5 }])
    expect(balances.unavailable[0].note).toContain('没有通用的账户余额接口')
  })

  it('递延与释放：按币种合计、有释放日的笔数、按周分桶（没给释放日的单列）、已释放金额', async () => {
    const { call } = await open(ALL)
    const { deferral } = (await call('GET', '/finance/cashflow?weeks=4')).json.data
    expect(deferral.totals).toEqual([{ currency: 'USD', amount: 100, count: 3, withMaturity: 2 }])
    expect(deferral.schedule.weeks[0]).toMatchObject({ amount: 80, count: 2 })
    expect(deferral.schedule.unknown).toEqual({ amount: 20, count: 1 })
    expect(deferral.schedule.overdue).toEqual({ amount: 0, count: 0 })
    expect(deferral.released).toEqual([{ currency: 'USD', amount: 60, count: 3 }])
    expect(deferral.note).toContain('不用下单日推算')
  })

  it('打款预测：周期 14 天、到账延迟 3 天；已公布的是今天的那张；下一次预计打款并入递延释放；预测不含打款类交易', async () => {
    const { call, prisma } = await open(ALL)
    const { payout } = (await call('GET', '/finance/cashflow?weeks=4')).json.data
    const store = payout.stores[0]
    expect(store).toMatchObject({ cycleDays: 14, lagDays: 3, samples: 3, lastPeriodEnd: dayText(-3), reason: null })
    expect(store.published).toEqual([{ settlementId: 'st-3', externalSettlementId: 'EXT-3', depositDate: dayText(0), amount: 500, currency: 'USD' }])
    // 周期结束日 +11 天不早于释放日 +5 天，所以 80 的递延释放并入第一次预计打款：100 × 14 + 80
    expect(store.predicted[0]).toMatchObject({ periodEnd: dayText(11), depositDate: dayText(14), runRateAmount: 1400, deferredAmount: 80, estimated: 1480 })
    expect(payout.next).toEqual({ date: dayText(0), amount: 500, kind: 'PUBLISHED', storeName: '美国主店' })
    expect(payout.dailyRate).toBe(100)
    expect(payout.basis).toContain('模型估算')
    const rateCall = prisma.fbaFinancialTransaction.groupBy.mock.calls.map(([args]) => args).find(args => !args.by.includes('maturityAt') && args.by.includes('sellerAccountId'))
    expect(JSON.stringify(rateCall.where.NOT)).toMatch(/transfer[\s\S]*disbursement[\s\S]*payout/)
    expect(rateCall.where.transactionStatus).toEqual({ in: ['RELEASED', 'DEFERRED_RELEASED'] })
  })

  it('按周预测：已公布与预计打款入账，采购（只计同币种、有日期的）、头程、广告出账；币种不同与没日期的单列', async () => {
    const { call } = await open(ALL)
    const { forecast } = (await call('GET', '/finance/cashflow?weeks=4')).json.data
    expect(forecast.weeks).toHaveLength(4)
    expect(forecast.weeks[0]).toMatchObject({ publishedInflow: 500, estimatedInflow: 0, purchaseOutflow: 300, firstMileOutflow: 0, adsOutflow: 70, net: 130, cumulative: 130, missing: [] })
    expect(forecast.weeks[1]).toMatchObject({ firstMileOutflow: 200, adsOutflow: 70, net: -270 })
    expect(forecast.weeks[2]).toMatchObject({ estimatedInflow: 1480, net: 1410, cumulative: 1270 })
    expect(forecast.excluded).toEqual([{ label: '采购付款', count: 1, currencies: ['CNY'] }])
    expect(forecast.undated).toEqual([{ label: '采购付款', count: 1 }])
    expect(forecast.sources.map((item: { label: string; state: string }) => [item.label, item.state])).toEqual([
      ['已公布的打款', 'OK'],
      ['预计打款', 'OK'],
      ['采购付款', 'OK'],
      ['头程付款', 'OK'],
      ['广告扣款', 'OK'],
    ])
    expect(forecast.assumptions.join('')).toContain('不换算汇率')
  })

  it('没有采购、头程、广告权限，或广告没有花费记录：对应来源写明原因，该列为空而不是 0，净额不含它', async () => {
    const { call, prisma } = await open(['finance.read'], { adsMetric: { aggregate: vi.fn().mockResolvedValue({ _sum: { cost: null }, _count: { _all: 0 } }) } })
    const { forecast } = (await call('GET', '/finance/cashflow?weeks=4')).json.data
    const state = (label: string) => forecast.sources.find((item: { label: string }) => item.label === label)
    expect(state('采购付款')).toMatchObject({ state: 'RESTRICTED', total: null })
    expect(state('头程付款')).toMatchObject({ state: 'RESTRICTED' })
    expect(state('广告扣款')).toMatchObject({ state: 'RESTRICTED', note: expect.stringContaining('广告查看') })
    expect(forecast.weeks[0]).toMatchObject({ purchaseOutflow: null, firstMileOutflow: null, adsOutflow: null, net: 500, missing: ['采购付款', '头程付款', '广告扣款'] })
    expect(prisma.purchasePayment.findMany).not.toHaveBeenCalled()
    expect(prisma.adsMetric.aggregate).not.toHaveBeenCalled()
    const withAds = await reopen(['finance.read', 'ads.read'], { adsMetric: { aggregate: vi.fn().mockResolvedValue({ _sum: { cost: null }, _count: { _all: 0 } }) } })
    const res = (await withAds.call('GET', '/finance/cashflow')).json.data.forecast
    expect(res.sources.find((item: { label: string }) => item.label === '广告扣款')).toMatchObject({ state: 'NOT_CONNECTED', note: expect.stringContaining('尚无记录') })
    expect(res.weeks[0].adsOutflow).toBeNull()
  })

  it('结算单历史不足两张：不预测打款，写明原因；已公布的打款仍然入账', async () => {
    const one = {
      fbaSettlement: { findMany: vi.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => ('settlementEndDate' in args.where ? [HISTORY[0]] : [])), findFirst: vi.fn() },
    }
    const { call } = await open(ALL, one)
    const data = (await call('GET', '/finance/cashflow?weeks=4')).json.data
    expect(data.payout.stores[0]).toMatchObject({ cycleDays: null, predicted: [], reason: expect.stringContaining('至少需要 2 张') })
    expect(data.forecast.sources[1]).toMatchObject({ label: '预计打款', state: 'NOT_CONNECTED' })
    expect(data.forecast.weeks[0]).toMatchObject({ publishedInflow: 500, estimatedInflow: null })
    expect(data.forecast.weeks[0].missing).toContain('预计打款')
  })

  it('到账核对：已登记一致的、未登记等待与已打款日未到各有状态；登记人显示名字；有登记权限才给 canConfirm', async () => {
    const { call } = await open(ALL)
    const data = (await call('GET', '/finance/cashflow')).json.data
    expect(data.canConfirm).toBe(false)
    const rows = data.disbursements.items
    expect(rows.map((row: { settlementId: string; state: string }) => [row.settlementId, row.state])).toEqual([
      ['st-3', 'AWAITING'],
      ['st-17', 'MATCHED'],
      ['st-31', 'UNREGISTERED'],
    ])
    expect(rows[1]).toMatchObject({ expectedAmount: 500, diff: 0, registered: { amount: 500, bankLast4: '6789', createdBy: '财务小王', version: 1, disbursedAt: dayText(-13) } })
    expect(rows[0].registered).toBeNull()
    expect(data.disbursements.summary).toEqual({ total: 3, matched: 1, mismatched: 0, awaiting: 1, unregistered: 1 })
    expect(data.disbursements.truncated).toBe(false)
    const can = await reopen([...ALL, 'finance.reconcile'])
    expect((await can.call('GET', '/finance/cashflow')).json.data.canConfirm).toBe(true)
  })

  it('币种不同的登记不比较金额；金额差额按“登记 − 报告”；没有任何数据时给空状态说明', async () => {
    const rows = [listRow(-3, { disbursement: savedDisbursement({ currency: 'CNY', amount: dec('3600') }) }), listRow(-17, { disbursement: savedDisbursement({ amount: dec('480') }) })]
    const { call } = await open(ALL, {
      fbaSettlement: { findMany: vi.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => ('settlementEndDate' in args.where ? HISTORY : rows)), findFirst: vi.fn() },
    })
    const items = (await call('GET', '/finance/cashflow')).json.data.disbursements.items
    expect(items[0]).toMatchObject({ state: 'CURRENCY_DIFFERENT', diff: null })
    expect(items[1]).toMatchObject({ state: 'SHORT', diff: -20 })
    const empty = await reopen(ALL, {
      accountBalanceSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
      fbaFinancialTransaction: { groupBy: vi.fn().mockResolvedValue([]) },
      fbaSettlement: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    })
    const none = (await empty.call('GET', '/finance/cashflow')).json.data
    expect(none).toMatchObject({ state: 'NO_DATA', note: expect.stringContaining('尚无回款与现金流数据') })
    expect(none.payout.next).toBeNull()
    expect(none.forecast.weeks[0].estimatedInflow).toBeNull()
  })
})

describe('到账登记', () => {
  const body = { settlementId: 'st-3', disbursedAt: dayText(0), amount: 500, currency: 'USD', bankLast4: '6789', note: '已核对流水' }
  const post = (call: Awaited<ReturnType<typeof open>>['call'], over: Record<string, unknown> = {}) => call('POST', '/finance/disbursements/confirm', { body: { ...body, ...over } })

  it('第一次登记：201，写登记与审计；金额与报告一致就是“已到账且一致”', async () => {
    const { call, prisma } = await open(['finance.read', 'finance.reconcile'])
    const res = await post(call)
    expect(res.status).toBe(201)
    expect(res.json.data).toEqual({ id: 'd9', version: 1, created: true, state: 'MATCHED', diff: 0 })
    const data = prisma.disbursement.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      settlementId: 'st-3',
      amount: 500,
      currency: 'USD',
      bankLast4: '6789',
      note: '已核对流水',
      createdBy: 'user-1',
      updatedBy: 'user-1',
    })
    expect(data.disbursedAt.toISOString().slice(0, 10)).toBe(dayText(0))
    expect(prisma.auditEvent.create.mock.calls.some(item => JSON.stringify(item[0]).includes('DISBURSEMENT_CONFIRMED'))).toBe(true)
    expect(JSON.stringify(prisma.fbaSettlement.findFirst.mock.calls[0][0].where)).toContain('tenant-1')
  })

  it('金额差额与币种：少到、多到、币种不同分别给状态', async () => {
    const { call } = await open(['finance.reconcile'])
    expect((await post(call, { amount: 480 })).json.data).toMatchObject({ state: 'SHORT', diff: -20 })
    expect((await post(call, { amount: 520.5 })).json.data).toMatchObject({ state: 'OVER', diff: 20.5 })
    expect((await post(call, { currency: 'CNY', amount: 3600 })).json.data).toMatchObject({ state: 'CURRENCY_DIFFERENT', diff: null })
  })

  it('已有登记：不带版本号 409；带版本号走乐观锁更新并写审计；版本过期 409；别人同时首次登记也是 409', async () => {
    const existing = { id: 'd1', version: 2, disbursedAt: at(-1), amount: dec('480'), currency: 'USD', bankLast4: null, note: null }
    const { call, prisma } = await open(['finance.reconcile'], {
      disbursement: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'd1', version: 3 }),
      },
    })
    const conflict = await post(call)
    expect(conflict.status).toBe(409)
    expect(JSON.stringify(conflict.json)).toContain('已经登记过到账')
    expect(prisma.disbursement.create).not.toHaveBeenCalled()
    const updated = await post(call, { version: 2 })
    expect(updated.status).toBe(201)
    expect(updated.json.data).toEqual({ id: 'd1', version: 3, created: false, state: 'MATCHED', diff: 0 })
    expect(prisma.disbursement.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'd1', tenantId: 'tenant-1', version: 2 },
      data: { amount: 500, updatedBy: 'user-1', version: { increment: 1 } },
    })
    expect(JSON.stringify(prisma.auditEvent.create.mock.calls.at(-1)?.[0])).toContain('"before"')
    prisma.disbursement.updateMany.mockResolvedValue({ count: 0 })
    prisma.disbursement.findFirst.mockResolvedValue({ version: 5 })
    expect((await post(call, { version: 2 })).status).toBe(409)
    const race = await reopen(['finance.reconcile'], {
      disbursement: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' })), updateMany: vi.fn(), findFirst: vi.fn() },
    })
    expect((await post(race.call)).status).toBe(409)
  })

  it('校验：参数不合法 422；未来的到账日期 422；范围外或不存在的结算单 404；报告没有打款金额 409', async () => {
    const { call, prisma } = await open(['finance.reconcile'])
    for (const bad of [{ amount: 0 }, { bankLast4: 'abcd' }, { disbursedAt: '2026-13-01' }, { currency: 'usd' }, { settlementId: 'a b' }, { extra: 1 }])
      expect((await post(call, bad)).status, JSON.stringify(bad)).toBe(422)
    expect((await post(call, { disbursedAt: dayText(3) })).status).toBe(422)
    prisma.fbaSettlement.findFirst.mockResolvedValue(null)
    expect((await post(call)).status).toBe(404)
    expect((await post(call, { settlementId: 'bad id' })).status).toBe(422)
    prisma.fbaSettlement.findFirst.mockResolvedValue({ ...settlementPoint(-3), disbursementAmount: null, sellerAccount: { displayName: 'x' }, reconciliation: null })
    const none = await post(call)
    expect(none.status).toBe(409)
    expect(JSON.stringify(none.json)).toContain('没有打款金额')
    expect(prisma.disbursement.create).not.toHaveBeenCalled()
  })

  it('范围收窄后，别的店铺的结算单查不到（404），不登记', async () => {
    const scoped = {
      membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's2' }]) },
      fbaSettlement: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
      sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's2' }]) },
    }
    const { call, prisma } = await open(['finance.reconcile'], scoped)
    expect((await post(call)).status).toBe(404)
    expect(JSON.stringify(prisma.fbaSettlement.findFirst.mock.calls[0][0].where)).toContain('s2')
    expect(prisma.disbursement.create).not.toHaveBeenCalled()
  })
})
