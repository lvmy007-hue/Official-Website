import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

const PURCHASE = new Date('2026-10-20T10:00:00Z')
const orderRow = {
  id: 'o1',
  sellerAccountId: 's1',
  amazonOrderId: '111-2222222-3333333',
  purchaseDate: PURCHASE,
  status: 'Shipped',
  fulfillmentStatus: 'Shipped',
  amount: '59.9',
  currency: 'USD',
  earliestDelivery: null,
  latestDelivery: null,
  isReplacement: false,
  replacedOrderId: null,
  replacementReason: null,
  // 即使数据库查询结果带了密文，列表也不能把它带出去
  piiCiphertext: 'iv.tag.cipher',
  sellerAccount: { displayName: '美国主店' },
  items: [{ quantityOrdered: 2 }, { quantityOrdered: 1 }],
  packages: [{ carrier: 'UPS', trackingNumber: '1Z1' }],
}
const header = {
  ...orderRow,
  marketplaceId: 'ATVPDKIKX0DER',
  fulfillment: 'AFN',
  latestShipDate: null,
  shippedAt: null,
  piiExpiresAt: new Date(Date.now() + 86_400_000),
  programs: [],
  salesChannel: 'Amazon.com',
}

// 新体系角色（version 2）不展开旧权限映射：旧角色的 orders.read 会连带 returns.read
function modernRole(permissions: string[]) {
  return { membership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions, version: 2 }, tenant: { lifecycleStatus: 'ACTIVE' } }) } }
}

function ordersPrisma(permissions: string[], over: Record<string, unknown> = {}) {
  const none = () => vi.fn().mockResolvedValue([])
  return {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    order: { findMany: vi.fn().mockResolvedValueOnce([orderRow]).mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(header), count: vi.fn().mockResolvedValue(1) },
    orderItem: { findMany: none() },
    orderCharge: { findMany: none() },
    orderCancellation: { findMany: none(), findFirst: vi.fn().mockResolvedValue(null) },
    orderPackage: { findMany: none() },
    orderStatusHistory: { findMany: none() },
    fbaFinancialTransaction: { findMany: none() },
    fbaFeeEvent: { findMany: none() },
    fbaReturnCase: { findMany: none() },
    fbaProduct: { findMany: none() },
    sellerAccount: { findMany: none() },
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

describe('订单列表', () => {
  it('未登录 401；缺少 orders.read 403（先于参数校验）', async () => {
    harness = await createTestApp(ordersPrisma(['orders.read']))
    const anonymous = await harness.call('GET', '/orders', { auth: false })
    expect(anonymous.status).toBe(401)
    expect(anonymous.json.error.code).toBe('AUTH_REQUIRED')
    await harness.close()
    harness = await createTestApp(ordersPrisma(['seller.read']))
    const res = await harness.call('GET', '/orders?pageSize=99999')
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('TENANT_ACCESS_DENIED')
  })

  it('默认最近 30 天（按企业时区），游标分页；行里没有买家信息与密文', async () => {
    const prisma = ordersPrisma(['orders.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/orders?pageSize=20')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', range: { defaulted: true }, filterLimited: false })
    expect(data.pageInfo).toMatchObject({ hasMore: false, nextCursor: null, pageSize: 20 })
    const row = data.items[0]
    expect(row).toMatchObject({ amazonOrderId: '111-2222222-3333333', storeName: '美国主店', units: 3, carrier: 'UPS', trackingNumber: '1Z1', statusLabel: '已发货' })
    expect(row.refund).toEqual({ state: 'PENDING_DATA', amount: null })
    expect(row).not.toHaveProperty('netIncome')
    expect(JSON.stringify(res.json)).not.toMatch(/piiCiphertext|iv\.tag\.cipher|buyer/i)
    const where = prisma.order.findMany.mock.calls[0][0]
    expect(where.take).toBe(21)
    expect(JSON.stringify(where.where)).toContain('tenant-1')
    expect(JSON.stringify(where.select)).not.toContain('piiCiphertext')
  })

  it('列表响应里永远没有净收益（净收益是异步列）；有 field.profit 也一样', async () => {
    harness = await createTestApp(ordersPrisma(['orders.read', 'field.profit']))
    const row = (await harness.call('GET', '/orders')).json.data.items[0]
    expect(row).not.toHaveProperty('netIncome')
  })

  it('净收益异步列 POST /orders/net-income：有 field.profit 才可用；没有财务交易时值为空而不是 0；查询带企业条件', async () => {
    const prisma = ordersPrisma(['orders.read', 'field.profit'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/orders/net-income', { body: { ids: ['o1', 'o1', 'o-other'] } })
    expect(res.status).toBe(200)
    expect(res.json.data.rows).toEqual({ o1: { net: { value: null, currency: 'USD' } } })
    const where = prisma.order.findMany.mock.calls[0][0].where
    expect(JSON.stringify(where)).toContain('tenant-1')
    expect(where.id.in).toEqual(['o1', 'o-other'])
    await harness.close()
    harness = await createTestApp(ordersPrisma(['orders.read']))
    const denied = await harness.call('POST', '/orders/net-income', { body: { ids: ['o1'] } })
    expect(denied.status).toBe(403)
    await harness.close()
    harness = await createTestApp(ordersPrisma(['orders.read', 'field.profit']))
    expect((await harness.call('POST', '/orders/net-income', { body: { ids: Array.from({ length: 101 }, (_, i) => `o${i}`) } })).status).toBe(422)
  })

  it('没有订单：NO_DATA 并说明原因', async () => {
    harness = await createTestApp(ordersPrisma(['orders.read'], { order: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), count: vi.fn() } }))
    const { data } = (await harness.call('GET', '/orders')).json
    expect(data.state).toBe('NO_DATA')
    expect(data.items).toEqual([])
    expect(data.note).toContain('尚无订单记录')
  })

  it('退款筛选：先找出有退款交易的订单号再过滤，并标记结果可能不完整的上限', async () => {
    const prisma = ordersPrisma(['orders.read'])
    harness = await createTestApp(prisma)
    prisma.fbaFinancialTransaction.findMany.mockResolvedValueOnce([{ amazonOrderId: '111-2222222-3333333' }])
    const res = await harness.call('GET', '/orders?refunded=true')
    expect(res.status).toBe(200)
    expect(JSON.stringify(prisma.order.findMany.mock.calls[0][0].where)).toContain('111-2222222-3333333')
    expect(prisma.fbaFinancialTransaction.findMany.mock.calls[0][0].where.transactionType).toMatchObject({ contains: 'refund' })
  })

  it('批量搜索 qs：订单号或追踪号精确匹配（in），不区分前后空白与重复；超过 500 个词、含超长词 422', async () => {
    const prisma = ordersPrisma(['orders.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', `/orders?qs=${encodeURIComponent('111-2222222-3333333\n\n1Z1,111-2222222-3333333')}`)
    expect(res.status).toBe(200)
    const where = JSON.stringify(prisma.order.findMany.mock.calls[0][0].where)
    expect(where).toContain('"amazonOrderId":{"in":["111-2222222-3333333","1Z1"]}')
    expect(where).toContain('"trackingNumber":{"in":["111-2222222-3333333","1Z1"]}')
    const tooMany = Array.from({ length: 501 }, (_, index) => `T${index}`).join(',')
    expect((await harness.call('GET', `/orders?qs=${tooMany}`)).status).toBe(422)
    expect((await harness.call('GET', `/orders?qs=${'x'.repeat(81)}`)).status).toBe(422)
  })

  it('参数不合法 422（排序字段、风险类型、结算状态）；游标无法识别 400', async () => {
    harness = await createTestApp(ordersPrisma(['orders.read']))
    for (const query of ['sort=amount', 'risk=NOPE', 'settlement=X']) expect((await harness.call('GET', `/orders?${query}`)).status, query).toBe(422)
    expect((await harness.call('GET', '/orders?cursor=bad')).status).toBe(400) // 游标无法识别（或不属于这组查询）
  })
})

describe('订单详情', () => {
  it('编号不存在或不在范围内：404', async () => {
    harness = await createTestApp(ordersPrisma(['orders.read'], { order: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), count: vi.fn() } }))
    for (const path of ['', '/items', '/charges', '/packages', '/timeline', '/risks']) expect((await harness.call('GET', `/orders/nope${path}`)).status, path).toBe(404)
    expect((await harness.call('GET', '/orders/bad%20id')).status).toBe(404)
  })

  it('查询条件带租户与数据范围；编号既可是系统编号也可是亚马逊订单号', async () => {
    const prisma = ordersPrisma(['orders.read'])
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/orders/111-2222222-3333333')).status).toBe(200)
    expect(prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', OR: [{ id: '111-2222222-3333333' }, { amazonOrderId: '111-2222222-3333333' }] })
    expect(JSON.stringify(prisma.order.findFirst.mock.calls[0][0].select)).not.toContain('piiCiphertext')
  })

  it('身份区：买家信息只给状态，不给内容；没有 field.buyer 时标为受限', async () => {
    harness = await createTestApp(ordersPrisma(['orders.read']))
    const { data } = (await harness.call('GET', '/orders/o1')).json
    expect(data.buyerInfo).toEqual({ access: 'RESTRICTED', state: 'NOT_SYNCED', expiresAt: null })
    expect(data.overview.basis.note).toContain('没有包裹记录')
    expect(JSON.stringify(data)).not.toMatch(/cipher|buyerName|buyerEmail/i)
  })

  it('退款与退货需要 returns.read；财务交易需要 finance.read', async () => {
    harness = await createTestApp(ordersPrisma(['orders.read'], modernRole(['orders.read'])))
    const returns = await harness.call('GET', '/orders/o1/returns')
    expect(returns.status).toBe(403)
    const transactions = await harness.call('GET', '/orders/o1/transactions')
    expect(transactions.status).toBe(403)
    expect((await harness.call('GET', '/orders/o1/charges')).status).toBe(200)
    await harness.close()
    harness = await createTestApp(ordersPrisma(['orders.read'], modernRole(['orders.read', 'returns.read', 'finance.read'])))
    expect((await harness.call('GET', '/orders/o1/returns')).status).toBe(200)
    expect((await harness.call('GET', '/orders/o1/transactions')).json.data).toMatchObject({ items: [], truncated: false, total: null })
  })
})
