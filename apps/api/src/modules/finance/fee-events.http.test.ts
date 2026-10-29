import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 费用事件接口（P2b-05）：权限先于参数校验、数据范围、列表与页签统计口径、证据、标记差异与对账备注（乐观锁、审计、变更记录）。

const none = () => vi.fn().mockResolvedValue([])
const amount = (value: string) => ({ toString: () => value })
const POSTED = new Date('2026-10-20T08:00:00Z')
const eventRecord = (over: Record<string, unknown> = {}) => ({
  id: 'fe1',
  sellerAccountId: 's1',
  feeCategory: 'FULFILLMENT',
  feeSubtype: 'FBAPerUnitFulfillmentFee',
  amount: amount('-3.22'),
  currency: 'USD',
  postedAt: POSTED,
  transactionStatus: 'RELEASED',
  amazonOrderId: '111-2222222-3333333',
  asin: 'B0TEST0001',
  sellerSku: 'SKU-1',
  settlementId: null,
  sourceRecordId: 'tx-1',
  sourceEventId: 'tx-1:0',
  reconciliationStatus: 'UNRECONCILED',
  reconciliationNote: null,
  reconciledAt: null,
  version: 1,
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const txRecord = (over: Record<string, unknown> = {}) => ({
  externalTransactionId: 'tx-1',
  sellerAccountId: 's1',
  transactionType: 'Shipment',
  transactionStatus: 'RELEASED',
  amount: amount('12.5'),
  currency: 'USD',
  postedAt: POSTED,
  description: '订单结算',
  relatedIdentifiers: [
    { name: 'ORDER_ID', value: '111-2222222-3333333' },
    { name: 'SHIPMENT_ID', value: 'FBA15ABCDE' },
  ],
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    membership: { ...sessionStub(permissions).membership, findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '王运营', email: 'w@x.com' } }]) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    fbaFeeEvent: {
      findMany: vi.fn().mockResolvedValue([eventRecord()]),
      findFirst: vi.fn().mockResolvedValue(eventRecord()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      groupBy: none(),
    },
    fbaFinancialTransaction: { findMany: vi.fn().mockResolvedValue([txRecord()]), findFirst: vi.fn().mockResolvedValue(txRecord()) },
    entityEvent: { create: vi.fn().mockResolvedValue({}), findMany: none() },
    order: { findFirst: vi.fn().mockResolvedValue({ id: 'o1' }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    dataFreshness: { findMany: none() },
    ...over,
  }
  const guards = createWriteGuardStubs()
  prisma.auditEvent = guards.auditEvent
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma as Record<string, ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>> & {
    fbaFeeEvent: Record<string, ReturnType<typeof vi.fn>>
    entityEvent: Record<string, ReturnType<typeof vi.fn>>
    auditEvent: Record<string, ReturnType<typeof vi.fn>>
  }
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

describe('权限与范围', () => {
  it('未登录 401；没有 finance.read 时读接口 403（先于参数校验）；没有 finance.reconcile 时写接口 403（先于请求体校验）', async () => {
    const { call } = await open(['finance.read'])
    expect((await call('GET', '/finance/events', { auth: false })).status).toBe(401)
    await harness?.close()
    const denied = await open(['seller.read'])
    for (const path of ['/finance/events?pageSize=99999', '/finance/events/summary?from=bad', '/finance/events/fe1']) expect((await denied.call('GET', path)).status, path).toBe(403)
    expect((await denied.call('PATCH', '/finance/events/fe1/reconciliation', { body: {} })).status).toBe(403)
    await harness?.close()
    const readOnly = await open(['finance.read'])
    expect((await readOnly.call('PATCH', '/finance/events/fe1/reconciliation', { body: { version: 1, status: 'DISCREPANCY', note: 'x' } })).status).toBe(403)
    expect(readOnly.prisma.fbaFeeEvent.updateMany).not.toHaveBeenCalled()
  })

  it('查询一律带企业条件；数据范围收窄到一个店铺时按店铺过滤，范围外的事件 404', async () => {
    const scoped = {
      membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) },
      fbaFeeEvent: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), groupBy: none() },
    }
    const { call, prisma } = await open(['finance.read', 'finance.reconcile'], scoped)
    await call('GET', '/finance/events')
    expect(JSON.stringify(prisma.fbaFeeEvent.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect((await call('GET', '/finance/events/other')).status).toBe(404)
    expect(JSON.stringify(prisma.fbaFeeEvent.findFirst.mock.calls[0][0].where)).toContain('s1')
    expect((await call('GET', '/finance/events/bad%20id')).status).toBe(404)
    expect((await call('PATCH', '/finance/events/other/reconciliation', { body: { version: 1, status: 'DISCREPANCY', note: 'x' } })).status).toBe(404)
  })
})

describe('列表', () => {
  it('字段、分类与来源中文名、货件标识；游标多取一行；默认最近 30 天；只看 9 类费用', async () => {
    const { call, prisma } = await open(['finance.read'])
    const res = await call('GET', '/finance/events?pageSize=20')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.state).toBe('OK')
    expect(data.items[0]).toMatchObject({
      id: 'fe1',
      storeName: '美国主店',
      category: 'FULFILLMENT',
      categoryLabel: '配送费',
      subtypeLabel: expect.any(String),
      amount: -3.22,
      currency: 'USD',
      transactionStatusLabel: '已释放',
      shipmentId: 'FBA15ABCDE',
      source: 'FINANCE_API',
      reconciliationStatus: 'UNRECONCILED',
      version: 1,
    })
    expect(data.range.defaulted).toBe(true)
    expect(data.range.fromAt < data.range.toAt).toBe(true)
    const args = prisma.fbaFeeEvent.findMany.mock.calls[0][0]
    expect(args.take).toBe(21)
    const where = JSON.stringify(args.where)
    expect(where).toContain('FULFILLMENT')
    expect(where).not.toContain('NON_FEE')
    expect(JSON.stringify(args.orderBy)).toContain('postedAt')
  })

  it('页签、交易状态、对账状态、关键词都进查询条件；来源为报告的行不查交易', async () => {
    const report = eventRecord({ id: 'fe2', feeCategory: 'STORAGE', feeSubtype: 'STORAGE_FEE', sourceRecordId: null, sourceEventId: 'storage:abc', transactionStatus: null })
    const { call, prisma } = await open(['finance.read'], { fbaFeeEvent: { findMany: vi.fn().mockResolvedValue([report]), findFirst: vi.fn(), groupBy: none() } })
    const res = await call('GET', '/finance/events?category=STORAGE&status=DEFERRED&reconciliation=DISCREPANCY&q=111-22&from=2026-10-01&to=2026-10-31')
    expect(res.status).toBe(200)
    const where = JSON.stringify(prisma.fbaFeeEvent.findMany.mock.calls[0][0].where)
    for (const part of ['STORAGE', 'DEFERRED', 'DISCREPANCY', '111-22']) expect(where).toContain(part)
    expect(res.json.data.range).toMatchObject({ from: '2026-10-01', to: '2026-10-31', defaulted: false })
    expect(res.json.data.items[0]).toMatchObject({ source: 'STORAGE_REPORT', transactionStatusLabel: null, shipmentId: null })
    expect(prisma.fbaFinancialTransaction.findMany).not.toHaveBeenCalled()
  })

  it('没有数据：状态 NO_DATA 并说明原因；有筛选时提示放宽条件', async () => {
    const empty = { fbaFeeEvent: { findMany: none(), findFirst: vi.fn(), groupBy: none() } }
    const { call } = await open(['finance.read'], empty)
    const plain = (await call('GET', '/finance/events')).json.data
    expect(plain.state).toBe('NO_DATA')
    expect(plain.note).toContain('同步')
    expect((await call('GET', '/finance/events?category=REFUND')).json.data.note).toContain('放宽')
  })

  it('参数不合法：未知类别、日期颠倒、坏游标都不是 200', async () => {
    const { call } = await open(['finance.read'])
    expect((await call('GET', '/finance/events?category=NOPE')).status).toBe(422)
    expect((await call('GET', '/finance/events?pageSize=0')).status).toBe(422)
    expect([400, 404, 422]).toContain((await call('GET', '/finance/events?cursor=garbage')).status)
  })
})

describe('页签统计', () => {
  it('9 类都有一行；没有记录的类别笔数 0；金额按币种分别合计；统计不受费用类型筛选影响', async () => {
    const grouped = [
      { feeCategory: 'FULFILLMENT', currency: 'USD', _count: { _all: 3 }, _sum: { amount: amount('-9.666') } },
      { feeCategory: 'FULFILLMENT', currency: 'GBP', _count: { _all: 1 }, _sum: { amount: amount('-2') } },
      { feeCategory: 'REFUND', currency: 'USD', _count: { _all: 2 }, _sum: { amount: amount('-30') } },
    ]
    const flagged = [{ feeCategory: 'REFUND', _count: { _all: 1 } }]
    const groupBy = vi.fn().mockResolvedValueOnce(grouped).mockResolvedValueOnce(flagged)
    const { call } = await open(['finance.read'], { fbaFeeEvent: { findMany: none(), findFirst: vi.fn(), groupBy } })
    const res = await call('GET', '/finance/events/summary?category=STORAGE')
    expect(res.status).toBe(200)
    const { categories } = res.json.data
    expect(categories).toHaveLength(9)
    expect(categories.find((item: { category: string }) => item.category === 'FULFILLMENT')).toMatchObject({
      count: 4,
      totals: [
        { currency: 'GBP', amount: -2 },
        { currency: 'USD', amount: -9.67 },
      ],
      discrepancyCount: 0,
    })
    expect(categories.find((item: { category: string }) => item.category === 'REFUND')).toMatchObject({ count: 2, discrepancyCount: 1 })
    expect(categories.find((item: { category: string }) => item.category === 'STORAGE')).toMatchObject({ count: 0, totals: [] })
    expect(JSON.stringify(groupBy.mock.calls[0][0].where)).not.toContain('"feeCategory":"STORAGE"')
  })
})

describe('证据', () => {
  it('来源交易、同一笔交易的其他明细、变更历史、订单链接', async () => {
    const siblings = [{ id: 'fe9', feeCategory: 'COMMISSION', feeSubtype: 'Commission', amount: amount('-1.5'), currency: 'USD' }]
    const history = [{ occurredAt: new Date('2026-10-21T01:00:00Z'), title: '对账状态：未对账 → 有差异', actorId: 'user-1' }]
    const { call, prisma } = await open(['finance.read', 'orders.read'], {
      fbaFeeEvent: { findMany: vi.fn().mockResolvedValueOnce(siblings), findFirst: vi.fn().mockResolvedValue(eventRecord()), groupBy: none() },
      entityEvent: { create: vi.fn(), findMany: vi.fn().mockResolvedValue(history) },
    })
    const res = await call('GET', '/finance/events/fe1')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.event.id).toBe('fe1')
    expect(data.transaction).toMatchObject({
      transactionId: 'tx-1',
      transactionType: 'Shipment',
      transactionStatusLabel: '已释放',
      relatedIdentifiers: [{ name: 'ORDER_ID' }, { name: 'SHIPMENT_ID', value: 'FBA15ABCDE' }],
    })
    expect(data.siblings).toEqual([{ id: 'fe9', categoryLabel: '佣金', subtypeLabel: expect.any(String), amount: -1.5, currency: 'USD' }])
    expect(data.siblingsTruncated).toBe(false)
    expect(data.history).toEqual([{ at: '2026-10-21T01:00:00.000Z', title: '对账状态：未对账 → 有差异', actorName: '王运营' }])
    expect(data.orderId).toBe('o1')
    expect(JSON.stringify(prisma.entityEvent.findMany.mock.calls[0][0].where)).toContain('FEE_EVENT')
  })

  it('没有 orders.read 时不给订单链接也不查订单；报告类事件没有来源交易', async () => {
    const report = eventRecord({ id: 'fe2', feeCategory: 'STORAGE', sourceRecordId: null, sourceEventId: 'storage:abc', transactionStatus: null })
    const { call, prisma } = await open(['finance.read'], { fbaFeeEvent: { findMany: none(), findFirst: vi.fn().mockResolvedValue(report), groupBy: none() } })
    const res = await call('GET', '/finance/events/fe2')
    expect(res.json.data).toMatchObject({ transaction: null, siblings: [], orderId: null })
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
    expect(prisma.fbaFinancialTransaction.findFirst).not.toHaveBeenCalled()
  })
})

describe('标记差异与对账备注', () => {
  const patch = (call: (method: 'PATCH', path: string, options: { body: unknown }) => Promise<{ status: number; json: any }>, body: unknown) =>
    call('PATCH', '/finance/events/fe1/reconciliation', { body })

  it('标记有差异：带版本号更新、写变更记录与审计', async () => {
    const after = eventRecord({ reconciliationStatus: 'DISCREPANCY', version: 2 })
    const { call, prisma } = await open(['finance.read', 'finance.reconcile'], {
      fbaFeeEvent: { findMany: none(), findFirst: vi.fn().mockResolvedValueOnce(eventRecord()).mockResolvedValueOnce(after), updateMany: vi.fn().mockResolvedValue({ count: 1 }), groupBy: none() },
    })
    const res = await patch(call, { version: 1, status: 'DISCREPANCY', note: '与结算单金额不符' })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ id: 'fe1', version: 2, reconciliationStatus: 'DISCREPANCY' })
    const update = prisma.fbaFeeEvent.updateMany.mock.calls[0][0]
    expect(update.where).toMatchObject({ id: 'fe1', tenantId: 'tenant-1', version: 1 })
    expect(update.where.postedAt).toEqual(POSTED)
    expect(update.data).toMatchObject({ reconciliationStatus: 'DISCREPANCY', reconciliationNote: '与结算单金额不符', reconciledBy: 'user-1', version: { increment: 1 } })
    const event = prisma.entityEvent.create.mock.calls[0][0].data
    expect(event).toMatchObject({ entityType: 'FEE_EVENT', entityId: 'fe1', kind: 'fee.reconciliation' })
    expect(event.title).toContain('未对账 → 有差异')
    const audit = prisma.auditEvent.create.mock.calls[0][0].data
    expect(audit).toMatchObject({ action: 'FEE_EVENT_RECONCILED', resourceType: 'FbaFeeEvent', resourceId: 'fe1' })
  })

  it('请求体不合法一律 422：没有版本号、有差异不写备注、手工设“已对账”、什么都没改、多余字段', async () => {
    const { call, prisma } = await open(['finance.read', 'finance.reconcile'])
    for (const body of [{ status: 'DISCREPANCY', note: 'x' }, { version: 1, status: 'DISCREPANCY' }, { version: 1, status: 'RECONCILED' }, { version: 1 }, { version: 1, note: 'x', amount: 1 }]) {
      expect((await patch(call, body)).status, JSON.stringify(body)).toBe(422)
    }
    expect(prisma.fbaFeeEvent.updateMany).not.toHaveBeenCalled()
  })

  it('状态与备注都没变化：409 类提示，不写任何东西', async () => {
    const { call, prisma } = await open(['finance.read', 'finance.reconcile'])
    const res = await patch(call, { version: 1, status: 'UNRECONCILED' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(prisma.fbaFeeEvent.updateMany).not.toHaveBeenCalled()
    expect(prisma.entityEvent.create).not.toHaveBeenCalled()
  })

  it('版本已被别人推进：409 并带当前版本号，不写变更记录', async () => {
    const { call, prisma } = await open(['finance.read', 'finance.reconcile'], {
      fbaFeeEvent: {
        findMany: none(),
        findFirst: vi.fn().mockResolvedValueOnce(eventRecord()).mockResolvedValueOnce({ version: 5 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        groupBy: none(),
      },
    })
    const res = await patch(call, { version: 1, status: 'DISCREPANCY', note: 'x' })
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.json)).toContain('5')
    expect(prisma.entityEvent.create).not.toHaveBeenCalled()
  })

  it('只改备注：不改状态，变更记录写“更新对账备注”', async () => {
    const { call, prisma } = await open(['finance.read', 'finance.reconcile'], {
      fbaFeeEvent: { findMany: none(), findFirst: vi.fn().mockResolvedValue(eventRecord({ version: 2 })), updateMany: vi.fn().mockResolvedValue({ count: 1 }), groupBy: none() },
    })
    const res = await patch(call, { version: 1, note: '等结算单' })
    expect(res.status).toBe(200)
    expect(prisma.fbaFeeEvent.updateMany.mock.calls[0][0].data).toMatchObject({ reconciliationStatus: 'UNRECONCILED', reconciliationNote: '等结算单' })
    expect(prisma.entityEvent.create.mock.calls[0][0].data.title).toContain('更新对账备注')
  })
})
