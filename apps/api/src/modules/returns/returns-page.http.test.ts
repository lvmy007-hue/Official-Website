import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { refundFees, timelineOf } from './returns-detail.service'

const RETURN_DATE = new Date('2026-10-18T10:00:00Z')
const returnRow = {
  id: 'r1',
  sellerAccountId: 's1',
  amazonOrderId: '111-2222222-3333333',
  returnDate: RETURN_DATE,
  asin: 'B0TESTASIN1',
  sellerSku: 'SKU-1',
  quantity: 1,
  reason: 'DEFECTIVE',
  disposition: 'SELLABLE',
  detailedDisposition: 'SELLABLE',
  fulfillmentCenterId: 'ONT8',
  licensePlateNumber: 'LPNAAAA111',
  reportStatus: 'Unit returned to inventory',
  reimbursementStatus: 'NOT_REVIEWED',
  reimbursementCaseId: null,
  // 即使数据库查询结果带了买家备注，列表也不能把它带出去
  customerComments: '包装破损 13800000000',
  customerCommentsCipher: 'iv.tag.cipher-comment',
  sellerAccount: { displayName: '美国主店' },
}
const COMMENT_UNTIL = new Date(Date.now() + 10 * 86_400_000)
const detailRow = { ...returnRow, fnsku: 'X00TEST1', syncedAt: new Date('2026-10-19T02:00:00Z'), customerCommentsExpiresAt: COMMENT_UNTIL, customerCommentsKinds: 'PHONE' }

function returnsPrisma(permissions: string[], over: Record<string, unknown> = {}) {
  const none = () => vi.fn().mockResolvedValue([])
  return {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    fbaReturnCase: {
      findMany: vi.fn().mockResolvedValueOnce([returnRow]).mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(detailRow),
      groupBy: none(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: null } }),
    },
    order: { findMany: none() },
    orderItem: { findMany: none() },
    orderCharge: { findMany: none() },
    orderCancellation: { findMany: none() },
    fbaFinancialTransaction: { findMany: none() },
    fbaFeeEvent: { findMany: none() },
    fbaProduct: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', title: '测试商品', imageUrl: null }), findMany: none() },
    asinDailySummary: { findMany: none(), groupBy: none() },
    sellerAccount: { findMany: none() },
    returnReasonMap: { findMany: none() },
    dataFreshness: { findMany: none() },
    ...over,
  }
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})

describe('退货列表', () => {
  it('未登录 401；缺少 returns.read 403（先于参数校验）', async () => {
    harness = await createTestApp(returnsPrisma(['returns.read']))
    const anonymous = await harness.call('GET', '/returns', { auth: false })
    expect(anonymous.status).toBe(401)
    await harness.close()
    harness = await createTestApp(returnsPrisma(['seller.read']))
    const res = await harness.call('GET', '/returns?pageSize=99999')
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('TENANT_ACCESS_DENIED')
  })

  it('默认最近 90 天；游标分页多取一行；行里没有买家备注；没有财务交易时退款是待财务交易', async () => {
    const prisma = returnsPrisma(['returns.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/returns?pageSize=20')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', range: { defaulted: true }, filterLimited: false })
    expect(data.pageInfo).toMatchObject({ hasMore: false, nextCursor: null, pageSize: 20 })
    expect(data.items[0]).toMatchObject({ id: 'r1', storeName: '美国主店', reasonLabel: '商品有缺陷', licensePlateNumber: 'LPNAAAA111' })
    expect(data.items[0].disposition).toMatchObject({ group: 'SELLABLE', label: '可售' })
    expect(data.items[0].refund).toMatchObject({ state: 'PENDING_DATA', amount: null })
    expect(data.items[0].receipt.state).toBe('PENDING_DATA')
    expect(data.items[0].reimbursement.state).toBe('NOT_REVIEWED')
    expect(JSON.stringify(res.json)).not.toMatch(/customerComments|13800000000|包装破损/)
    const call = prisma.fbaReturnCase.findMany.mock.calls[0][0]
    expect(call.take).toBe(21)
    expect(JSON.stringify(call.where)).toContain('tenant-1')
    expect(JSON.stringify(call.select)).not.toContain('customerComments')
    const { from, to } = data.range
    expect((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000).toBe(89)
  })

  it('没有退货：NO_DATA 并说明原因', async () => {
    harness = await createTestApp(returnsPrisma(['returns.read'], { fbaReturnCase: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), groupBy: vi.fn() } }))
    const { data } = (await harness.call('GET', '/returns')).json
    expect(data.state).toBe('NO_DATA')
    expect(data.items).toEqual([])
    expect(data.note).toContain('尚无退货记录')
  })

  it('筛选落到查询条件上：处置分组按原值、退款先找订单号', async () => {
    const prisma = returnsPrisma(['returns.read'])
    harness = await createTestApp(prisma)
    prisma.fbaFinancialTransaction.findMany.mockResolvedValueOnce([{ amazonOrderId: '111-2222222-3333333' }])
    const res = await harness.call('GET', '/returns?refunded=true&disposition=DAMAGED&asin=b0testasin1&q=111-222')
    expect(res.status).toBe(200)
    const where = JSON.stringify(prisma.fbaReturnCase.findMany.mock.calls[0][0].where)
    expect(where).toContain('111-2222222-3333333')
    expect(where).toContain('CUSTOMER_DAMAGED')
    expect(where).toContain('B0TESTASIN1')
    expect(where).toContain('111-222')
    expect(prisma.fbaFinancialTransaction.findMany.mock.calls[0][0].where.transactionType).toMatchObject({ contains: 'refund' })
  })

  it('参数不合法 422（排序字段、处置分组）；游标无法识别 400', async () => {
    harness = await createTestApp(returnsPrisma(['returns.read']))
    for (const query of ['sort=quantity:asc', 'disposition=UNKNOWN']) expect((await harness.call('GET', `/returns?${query}`)).status, query).toBe(422)
    expect((await harness.call('GET', '/returns?cursor=bad')).status).toBe(400)
  })
})

describe('退货详情', () => {
  it('不存在或不在范围内：404；查询条件带租户', async () => {
    const prisma = returnsPrisma(['returns.read'], { fbaReturnCase: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), groupBy: vi.fn() } })
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/returns/nope')).status).toBe(404)
    expect((await harness.call('GET', '/returns/bad%20id')).status).toBe(404)
    expect(prisma.fbaReturnCase.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'nope', tenantId: 'tenant-1' })
  })

  it('买家备注只给状态与类别（不给内容）；处置、赔付状态与时间线；没有订单时订单号为空', async () => {
    const prisma = returnsPrisma(['returns.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/returns/r1')
    expect(res.status).toBe(200)
    const { data } = res.json
    // 买家备注只说“有、含电话、保留到何时”，没有内容也没有密文；明文要经 POST /pii/reveal
    expect(data.buyerComments).toEqual({ state: 'AVAILABLE', kinds: ['PHONE'], retainedUntil: COMMENT_UNTIL.toISOString() })
    expect(JSON.stringify(res.json)).not.toMatch(/13800000000|包装破损|cipher-comment/)
    expect(JSON.stringify(prisma.fbaReturnCase.findFirst.mock.calls[0][0].select)).not.toMatch(/customerComments(?!Expires|Kinds)/)
    expect(data.record).toMatchObject({ fnsku: 'X00TEST1', reportStatus: 'Unit returned to inventory' })
    expect(data.order).toMatchObject({ id: null, amazonOrderId: '111-2222222-3333333', statusLabel: null })
    expect(data.product.productId).toBe('p1')
    expect(data.refund).toMatchObject({ state: 'PENDING_DATA', fees: [], feeTotal: null })
    expect(data.timeline.map((item: { kind: string }) => item.kind)).toEqual(['RETURN_RECEIVED', 'IMPORTED'])
  })

  it('静态路径不被 :id 吞掉：analysis 与 awaiting 有各自的处理', async () => {
    harness = await createTestApp(returnsPrisma(['returns.read']))
    const analysis = await harness.call('GET', '/returns/analysis')
    expect(analysis.status).toBe(200)
    expect(analysis.json.data).toHaveProperty('reviewCross')
    const awaiting = await harness.call('GET', '/returns/awaiting')
    expect(awaiting.status).toBe(200)
    expect(awaiting.json.data).toHaveProperty('thresholdDays')
  })
})

describe('退货分析与待核实清单', () => {
  it('没有退货：NO_DATA，不编退货率；评论交叉写明尚未接入', async () => {
    harness = await createTestApp(
      returnsPrisma(['returns.read'], {
        fbaReturnCase: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), groupBy: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: null } }) },
      }),
    )
    const { data } = (await harness.call('GET', '/returns/analysis')).json
    expect(data.state).toBe('NO_DATA')
    expect(data.totals.rate).toBeNull()
    expect(data.reviewCross.state).toBe('NOT_CONNECTED')
  })

  it('缺少 returns.read：两个视图都 403', async () => {
    harness = await createTestApp(returnsPrisma(['seller.read']))
    expect((await harness.call('GET', '/returns/analysis')).status).toBe(403)
    expect((await harness.call('GET', '/returns/awaiting')).status).toBe(403)
  })
})

describe('费用与时间线（纯函数）', () => {
  const at = new Date('2026-10-19T00:00:00Z')
  it('费用：退款交易下的费用类明细与名称带 return 的费用，按明细编号去重；没有则为空', () => {
    expect(refundFees([], [], 'USD')).toEqual({ lines: [], total: null })
    const lines = [
      { sourceEventId: 'e1', path: 'Order.ReturnProcessingFee', amount: -3.2, postedAt: at },
      { sourceEventId: 'e1', path: 'Order.ReturnProcessingFee', amount: -3.2, postedAt: at },
      { sourceEventId: 'e2', path: 'Order.Principal', amount: 10, postedAt: at },
    ]
    const result = refundFees(lines, [{ externalTransactionId: 'tx1' }], 'USD')
    expect(result.lines).toHaveLength(1)
    expect(result.total).toBe(-3.2)
  })

  it('时间线：按时间升序，缺订单时没有下单节点', () => {
    const items = timelineOf({ purchaseDate: null, refunds: [{ at, amount: -25, currency: 'USD' }], returnDate: RETURN_DATE, quantity: 2, importedAt: new Date('2026-10-20T00:00:00Z') })
    expect(items.map(item => item.kind)).toEqual(['RETURN_RECEIVED', 'REFUND', 'IMPORTED'])
    expect(items[1].title).toContain('25.00')
    expect(items[0].title).toContain('2 件')
    const withOrder = timelineOf({ purchaseDate: new Date('2026-10-10T00:00:00Z'), refunds: [], returnDate: RETURN_DATE, quantity: 1, importedAt: at })
    expect(withOrder[0].kind).toBe('ORDER')
  })
})
