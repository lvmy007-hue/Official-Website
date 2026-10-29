import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 结算交易接口（P2b-07）：权限先于参数校验、数据范围、列表（状态、汇总、空状态、游标）、汇总、交易明细（订单链接权限、费用事件对应）、
// 三方核对结果（没有结果、待核对不显示金额）、异常清单、打款记录。全部只读。数值结论在 worker 的 reconcile.test.ts 与真实数据库测试里验证。

const none = () => vi.fn().mockResolvedValue([])
const dec = (value: string) => ({ toString: () => value })
const DAY = new Date('2026-10-01T00:00:00Z')

const settlementRecord = (over: Record<string, unknown> = {}) => ({
  id: 'st1',
  sellerAccountId: 's1',
  externalSettlementId: '12345678901',
  settlementStartDate: new Date('2026-09-01T00:00:00Z'),
  settlementEndDate: new Date('2026-09-14T23:59:59Z'),
  depositDate: new Date('2026-09-16T00:00:00Z'),
  openingBalance: dec('-50'),
  summaryJson: { INCOME: 120, FEE: -15, REFUND: 0, REIMBURSEMENT: 0, ADJUSTMENT: 0, RESERVE: -50 },
  disbursementAmount: dec('55'),
  totalAmount: dec('55'),
  currency: 'USD',
  txnCount: 4,
  reconciliationStatus: 'DISCREPANCY',
  diffAmount: dec('-15'),
  sortAt: DAY,
  sellerAccount: { displayName: '美国主店' },
  reconciliation: { id: 'rc1', pendingReason: null },
  ...over,
})
const lineRecord = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  lineNo: 2,
  postedAt: new Date('2026-09-05T10:00:00Z'),
  transactionType: 'Order',
  amountType: 'ItemFees',
  amountDescription: 'Commission',
  category: 'FEE',
  amazonOrderId: '111-1',
  sku: 'SKU-1',
  quantity: 1,
  amount: dec('-15'),
  currency: 'USD',
  ...over,
})
const exceptionRecord = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  kind: 'AMOUNT_MISMATCH',
  category: 'UNEXPLAINED',
  refKey: 'order:111-1',
  amazonOrderId: '111-1',
  reportAmount: dec('85'),
  apiAmount: dec('100'),
  amount: dec('-15'),
  absAmount: dec('15'),
  currency: 'USD',
  note: null,
  status: 'OPEN',
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    fbaSettlement: {
      findMany: vi.fn().mockResolvedValue([settlementRecord()]),
      findFirst: vi.fn().mockResolvedValue(settlementRecord()),
      groupBy: vi.fn().mockResolvedValue([
        { reconciliationStatus: 'DISCREPANCY', _count: { _all: 1 } },
        { reconciliationStatus: 'MATCHED', _count: { _all: 2 } },
        { reconciliationStatus: 'PENDING', _count: { _all: 3 } },
      ]),
    },
    reconciliation: { findFirst: vi.fn().mockResolvedValue(null) },
    reconciliationException: {
      groupBy: vi.fn().mockResolvedValue([{ reconciliationId: 'rc1', category: 'UNEXPLAINED', _count: { _all: 1 }, _sum: { absAmount: dec('15') } }]),
      findMany: vi.fn().mockResolvedValue([exceptionRecord()]),
    },
    settlementLine: {
      findMany: vi.fn().mockResolvedValue([lineRecord()]),
      groupBy: vi.fn().mockResolvedValue([{ category: 'FEE', amountType: 'ItemFees', amountDescription: 'Commission', _count: { _all: 1 }, _sum: { amount: dec('-15') } }]),
    },
    disbursement: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findMany: vi.fn().mockResolvedValue([{ amazonOrderId: '111-1' }]) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([{ sellerSku: 'SKU-1', asin: 'B0TEST0001' }]) },
    fbaFeeEvent: { findMany: vi.fn().mockResolvedValue([{ id: 'fe1', amazonOrderId: '111-1', amount: dec('-15') }]) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    dataFreshness: { findMany: none() },
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
const open = async (permissions: string[], over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const reopen = async (permissions: string[], over: Record<string, unknown> = {}) => {
  await harness?.close()
  return open(permissions, over)
}

describe('权限与范围', () => {
  it('未登录 401；没有 finance.read 全部 403，且先于参数与路径校验', async () => {
    const { call } = await open(['finance.read'])
    for (const path of [
      '/settlements',
      '/settlements/st1/summary',
      '/settlements/st1/transactions',
      '/settlements/st1/reconciliation',
      '/settlements/st1/exceptions',
      '/settlements/st1/disbursements',
    ]) {
      expect((await call('GET', path, { auth: false })).status).toBe(401)
    }
    const denied = await reopen(['seller.read'])
    for (const path of [
      '/settlements?status=NOPE&pageSize=99999',
      '/settlements/bad%20id/summary',
      '/settlements/st1/transactions?category=NOPE',
      '/settlements/bad%20id/reconciliation',
      '/settlements/st1/exceptions?kind=NOPE',
      '/settlements/bad%20id/disbursements',
    ]) {
      expect((await denied.call('GET', path)).status).toBe(403)
    }
    expect(denied.prisma.fbaSettlement.findMany).not.toHaveBeenCalled()
  })

  it('查询一律带企业条件；范围收窄到一个店铺时按店铺过滤；范围外与不存在的结算单、非法编号都是 404', async () => {
    const scoped = { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } }
    const { call, prisma } = await open(['finance.read'], scoped)
    await call('GET', '/settlements')
    expect(JSON.stringify(prisma.fbaSettlement.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect(JSON.stringify(prisma.fbaSettlement.groupBy.mock.calls[0][0].where)).toContain('s1')
    prisma.fbaSettlement.findFirst.mockResolvedValue(null)
    for (const path of ['summary', 'transactions', 'reconciliation', 'exceptions', 'disbursements']) {
      expect((await call('GET', `/settlements/other/${path}`)).status).toBe(404)
    }
    expect(JSON.stringify(prisma.fbaSettlement.findFirst.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect((await call('GET', '/settlements/bad%20id/summary')).status).toBe(404)
    expect(prisma.settlementLine.findMany).not.toHaveBeenCalled()
  })
})

describe('列表', () => {
  it('字段与中文状态、未处理异常数、各状态张数、数据新鲜度；只读，没有写入口', async () => {
    const { call, prisma } = await open(['finance.read'])
    const res = await call('GET', '/settlements?pageSize=20')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', note: null, summary: { total: 6, matched: 2, discrepancy: 1, pending: 3 } })
    expect(data.items[0]).toMatchObject({
      id: 'st1',
      storeName: '美国主店',
      externalSettlementId: '12345678901',
      periodStart: '2026-09-01T00:00:00.000Z',
      depositDate: '2026-09-16T00:00:00.000Z',
      openingBalance: -50,
      totals: { INCOME: 120, FEE: -15, RESERVE: -50 },
      disbursementAmount: 55,
      currency: 'USD',
      txnCount: 4,
      status: 'DISCREPANCY',
      statusLabel: '有差异',
      pendingReason: null,
      diffAmount: -15,
      openExceptions: 1,
    })
    expect(data.freshness).toHaveProperty('lastSuccessAt')
    expect(prisma.fbaSettlement.findMany.mock.calls[0][0].take).toBe(21)
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) expect((await call(method, '/settlements', { body: {} })).status).toBe(404)
  })

  it('待核对：报告没到时没有各类合计、差额，原因是“没有报告”；报告到了接口没到是“没有交易”', async () => {
    const pendingNoReport = settlementRecord({
      reconciliationStatus: 'PENDING',
      txnCount: 0,
      summaryJson: null,
      diffAmount: dec('0'),
      openingBalance: null,
      disbursementAmount: null,
      totalAmount: null,
      reconciliation: null,
    })
    const pendingNoTx = settlementRecord({ id: 'st2', reconciliationStatus: 'PENDING', diffAmount: dec('120'), reconciliation: { id: 'rc2', pendingReason: 'NO_TRANSACTIONS' } })
    const { call } = await open(['finance.read'], {
      fbaSettlement: { findMany: vi.fn().mockResolvedValue([pendingNoReport, pendingNoTx]), groupBy: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    })
    const { data } = (await call('GET', '/settlements')).json
    expect(data.items[0]).toMatchObject({
      status: 'PENDING',
      statusLabel: '待核对',
      pendingReason: 'NO_REPORT',
      totals: null,
      diffAmount: null,
      openingBalance: null,
      disbursementAmount: null,
      txnCount: 0,
      openExceptions: 0,
    })
    expect(data.items[1]).toMatchObject({ pendingReason: 'NO_TRANSACTIONS', diffAmount: null })
    expect(data.summary).toEqual({ total: 0, matched: 0, discrepancy: 0, pending: 0 })
  })

  it('状态筛选进查询；游标绑定查询条件；没有结算单时区分“没有符合条件”和“还没有数据”', async () => {
    const { call, prisma } = await open(['finance.read'])
    await call('GET', '/settlements?status=MATCHED')
    expect(JSON.stringify(prisma.fbaSettlement.findMany.mock.calls[0][0].where)).toContain('MATCHED')
    prisma.fbaSettlement.findMany.mockResolvedValue([settlementRecord({ id: 'a' }), settlementRecord({ id: 'b' })])
    const first = (await call('GET', '/settlements?pageSize=1')).json.data
    expect(first.pageInfo).toMatchObject({ hasMore: true })
    expect(first.pageInfo.nextCursor).toEqual(expect.any(String))
    expect((await call('GET', `/settlements?pageSize=1&status=MATCHED&cursor=${first.pageInfo.nextCursor}`)).status).toBe(400)
    prisma.fbaSettlement.findMany.mockResolvedValue([])
    expect((await call('GET', '/settlements?status=MATCHED')).json.data).toMatchObject({ state: 'NO_DATA', note: expect.stringContaining('没有符合条件') })
    expect((await call('GET', '/settlements')).json.data).toMatchObject({ state: 'NO_DATA', note: expect.stringContaining('尚无结算单') })
  })
})

describe('汇总', () => {
  it('有报告：各类别合计与按科目的汇总；没有报告：说明原因，不查明细', async () => {
    const { call, prisma } = await open(['finance.read'])
    const { data } = (await call('GET', '/settlements/st1/summary')).json
    expect(data.hasReport).toBe(true)
    expect(data.settlement).toMatchObject({ id: 'st1', status: 'DISCREPANCY' })
    expect(data.categories).toEqual([
      { category: 'INCOME', label: '收入', amount: 120 },
      { category: 'FEE', label: '费用', amount: -15 },
      { category: 'REFUND', label: '退款', amount: 0 },
      { category: 'REIMBURSEMENT', label: '赔付', amount: 0 },
      { category: 'ADJUSTMENT', label: '调整及其他', amount: 0 },
      { category: 'RESERVE', label: '保留金', amount: -50 },
    ])
    expect(data.breakdown).toEqual([{ category: 'FEE', categoryLabel: '费用', amountType: 'ItemFees', amountDescription: 'Commission', count: 1, amount: -15 }])
    expect(data.breakdownTruncated).toBe(false)
    expect(prisma.settlementLine.groupBy.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', settlementId: 'st1' })

    prisma.fbaSettlement.findFirst.mockResolvedValue(settlementRecord({ txnCount: 0, reconciliationStatus: 'PENDING', summaryJson: null, reconciliation: null }))
    prisma.settlementLine.groupBy.mockClear()
    const empty = (await call('GET', '/settlements/12345678901/summary')).json.data
    expect(empty).toMatchObject({ hasReport: false, categories: [], breakdown: [], note: expect.stringContaining('尚未到达') })
    expect(prisma.settlementLine.groupBy).not.toHaveBeenCalled()
  })

  it('汇总科目超过上限只取上限并标记截断', async () => {
    const groups = Array.from({ length: 301 }, (_, index) => ({ category: 'FEE', amountType: 'T', amountDescription: `D${index}`, _count: { _all: 1 }, _sum: { amount: dec('-1') } }))
    const { call } = await open(['finance.read'], { settlementLine: { groupBy: vi.fn().mockResolvedValue(groups), findMany: none() } })
    const { data } = (await call('GET', '/settlements/st1/summary')).json
    expect(data.breakdown).toHaveLength(300)
    expect(data.breakdownTruncated).toBe(true)
  })
})

describe('交易明细', () => {
  it('字段、订单是否存在、ASIN、对应的费用事件；游标绑定这张结算单', async () => {
    const { call, prisma } = await open(['finance.read', 'orders.read'])
    const res = await call('GET', '/settlements/st1/transactions?pageSize=50&category=FEE')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', canViewOrders: true })
    expect(data.items[0]).toMatchObject({
      id: 'l1',
      lineNo: 2,
      category: 'FEE',
      categoryLabel: '费用',
      amazonOrderId: '111-1',
      sku: 'SKU-1',
      asin: 'B0TEST0001',
      amount: -15,
      orderFound: true,
      feeEventId: 'fe1',
    })
    expect(JSON.stringify(prisma.settlementLine.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*st1[\s\S]*FEE/)
    expect(prisma.fbaFeeEvent.findMany.mock.calls[0][0].where).toMatchObject({ settlementId: '12345678901', sellerAccountId: 's1' })
    prisma.settlementLine.findMany.mockResolvedValue([lineRecord({ lineNo: 1 }), lineRecord({ id: 'l2', lineNo: 2 })])
    const page = (await call('GET', '/settlements/st1/transactions?pageSize=1')).json.data
    expect(page.pageInfo.nextCursor).toEqual(expect.any(String))
    prisma.fbaSettlement.findFirst.mockResolvedValue(settlementRecord({ id: 'st2' }))
    expect((await call('GET', `/settlements/st2/transactions?pageSize=1&cursor=${page.pageInfo.nextCursor}`)).status).toBe(400)
  })

  it('没有订单读取权限：不查订单，订单一律不给链接；只有费用类明细才带费用事件', async () => {
    const { call, prisma } = await open(['finance.read'])
    prisma.settlementLine.findMany.mockResolvedValue([lineRecord(), lineRecord({ id: 'l2', category: 'INCOME', amountType: 'ItemPrice', amount: dec('100') })])
    const { data } = (await call('GET', '/settlements/st1/transactions')).json
    expect(data.canViewOrders).toBe(false)
    expect(data.items.map((item: { orderFound: boolean }) => item.orderFound)).toEqual([false, false])
    expect(data.items.map((item: { feeEventId: string | null }) => item.feeEventId)).toEqual(['fe1', null])
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })

  it('没有明细时给出原因；类别筛选非法是 422', async () => {
    const { call, prisma } = await open(['finance.read'])
    prisma.settlementLine.findMany.mockResolvedValue([])
    prisma.fbaSettlement.findFirst.mockResolvedValue(settlementRecord({ txnCount: 0 }))
    expect((await call('GET', '/settlements/st1/transactions')).json.data).toMatchObject({ state: 'NO_DATA', items: [], note: expect.stringContaining('尚未到达') })
    expect((await call('GET', '/settlements/st1/transactions?category=NOPE')).status).toBe(422)
  })
})

describe('三方核对结果', () => {
  const saved = (over: Record<string, unknown> = {}) => ({
    id: 'rc1',
    status: 'DISCREPANCY',
    pendingReason: null,
    computedAt: new Date('2026-10-23T01:00:00Z'),
    officialAmount: dec('105'),
    systemAmount: dec('120'),
    diffAmount: dec('-15'),
    detailJson: {
      report: { lineCount: 4, comparedTotal: 105, headerTotal: 55, selfDiff: 0, orderCount: 1 },
      api: { transactionCount: 2, total: 120, orderCount: 1, otherCurrencyCount: 0 },
      orders: { reportOrders: 1, found: 1, missing: 0 },
      checks: [
        { key: 'REPORT_SELF', label: '结算报告自检', state: 'PASS', detail: '汇总行打款总额 55，明细合计 55，相差 0' },
        { key: 'BOGUS', label: 'x', state: 'PASS', detail: 'y' },
      ],
      truncated: false,
    },
    ...over,
  })

  it('还没有核对结果：金额与检查都是空，不写 0', async () => {
    const { call } = await open(['finance.read'])
    const { data } = (await call('GET', '/settlements/st1/reconciliation')).json
    expect(data).toMatchObject({
      settlementId: 'st1',
      computedAt: null,
      officialAmount: null,
      systemAmount: null,
      diffAmount: null,
      report: null,
      api: null,
      orders: null,
      checks: [],
      exceptions: [],
      openExceptions: 0,
      tolerance: 0.05,
    })
  })

  it('有结果：官方金额、系统金额、差额，三项检查（只认认得的），异常按分类汇总', async () => {
    const { call, prisma } = await open(['finance.read'])
    prisma.reconciliation.findFirst.mockResolvedValue(saved())
    const { data } = (await call('GET', '/settlements/st1/reconciliation')).json
    expect(data).toMatchObject({
      status: 'DISCREPANCY',
      statusLabel: '有差异',
      officialAmount: 105,
      systemAmount: 120,
      diffAmount: -15,
      computedAt: '2026-10-23T01:00:00.000Z',
      openExceptions: 1,
      exceptionsTruncated: false,
    })
    expect(data.report).toEqual({ lineCount: 4, comparedTotal: 105, headerTotal: 55, selfDiff: 0, orderCount: 1 })
    expect(data.checks).toHaveLength(1)
    expect(data.exceptions).toEqual([{ category: 'UNEXPLAINED', label: '未解释', count: 1, amount: 15 }])
  })

  it('待核对：不显示两边金额（一边缺数据，不能当 0），给出原因说明', async () => {
    const { call, prisma } = await open(['finance.read'])
    prisma.fbaSettlement.findFirst.mockResolvedValue(settlementRecord({ reconciliationStatus: 'PENDING' }))
    prisma.reconciliation.findFirst.mockResolvedValue(saved({ status: 'PENDING', pendingReason: 'NO_TRANSACTIONS', systemAmount: dec('0'), diffAmount: dec('105') }))
    const { data } = (await call('GET', '/settlements/st1/reconciliation')).json
    expect(data).toMatchObject({
      status: 'PENDING',
      pendingReason: 'NO_TRANSACTIONS',
      pendingNote: expect.stringContaining('财务接口交易'),
      officialAmount: null,
      systemAmount: null,
      diffAmount: null,
    })
  })
})

describe('异常清单与打款记录', () => {
  it('异常：字段、中文分类与说明、订单链接按订单权限、筛选进查询', async () => {
    const { call, prisma } = await open(['finance.read', 'orders.read'])
    const { data } = (await call('GET', '/settlements/st1/exceptions?kind=AMOUNT_MISMATCH&category=UNEXPLAINED&status=OPEN')).json
    expect(data.items[0]).toMatchObject({
      id: 'e1',
      kindLabel: '金额不一致',
      categoryLabel: '未解释',
      categoryHint: expect.stringContaining('人工'),
      refKey: 'order:111-1',
      reportAmount: 85,
      apiAmount: 100,
      amount: -15,
      statusLabel: '待处理',
      orderFound: true,
    })
    expect(JSON.stringify(prisma.reconciliationException.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*st1[\s\S]*AMOUNT_MISMATCH[\s\S]*UNEXPLAINED[\s\S]*OPEN/)
    const noOrders = await reopen(['finance.read'])
    expect((await noOrders.call('GET', '/settlements/st1/exceptions')).json.data).toMatchObject({ canViewOrders: false, items: [{ orderFound: false }] })
    expect(noOrders.prisma.order.findMany).not.toHaveBeenCalled()
  })

  it('没有异常时说明；筛选非法是 422', async () => {
    const { call, prisma } = await open(['finance.read'])
    prisma.reconciliationException.findMany.mockResolvedValue([])
    expect((await call('GET', '/settlements/st1/exceptions')).json.data).toMatchObject({ state: 'NO_DATA', note: expect.stringContaining('没有核对异常') })
    expect((await call('GET', '/settlements/st1/exceptions?status=NOPE')).status).toBe(422)
  })

  it('打款记录：来自结算报告汇总行，登记过到账就多一行；没有金额时说明原因且不能登记', async () => {
    const { call, prisma } = await open(['finance.read'])
    const { data } = (await call('GET', '/settlements/st1/disbursements')).json
    expect(data.items).toEqual([{ source: 'REPORT', sourceLabel: '结算报告', date: '2026-09-16T00:00:00.000Z', amount: 55, currency: 'USD', note: expect.stringContaining('汇总行') }])
    expect(data.manual).toMatchObject({ available: true, note: expect.stringContaining('尚未登记') })
    prisma.disbursement.findFirst.mockResolvedValue({ disbursedAt: new Date('2026-09-17T00:00:00Z'), amount: dec('54.9'), currency: 'USD', bankLast4: '6789', note: '已核对流水' })
    const registered = (await call('GET', '/settlements/st1/disbursements')).json.data
    expect(registered.items[1]).toEqual({ source: 'MANUAL', sourceLabel: '手工登记到账', date: '2026-09-17T00:00:00.000Z', amount: 54.9, currency: 'USD', note: '收款账户末四位 6789；已核对流水' })
    expect(registered.manual.note).toContain('已登记')
    expect(JSON.stringify(prisma.disbursement.findFirst.mock.calls[0][0].where)).toContain('tenant-1')
    prisma.fbaSettlement.findFirst.mockResolvedValue(settlementRecord({ disbursementAmount: null, totalAmount: dec('-20') }))
    expect((await call('GET', '/settlements/st1/disbursements')).json.data.manual.available).toBe(false)
    expect((await call('GET', '/settlements/st1/disbursements')).json.data.items[0]).toMatchObject({ amount: null, note: expect.stringContaining('没有打款') })
    prisma.fbaSettlement.findFirst.mockResolvedValue(settlementRecord({ disbursementAmount: null, totalAmount: null, depositDate: null, txnCount: 0 }))
    expect((await call('GET', '/settlements/st1/disbursements')).json.data.items[0]).toMatchObject({ amount: null, date: null, note: expect.stringContaining('尚未到达') })
  })
})
