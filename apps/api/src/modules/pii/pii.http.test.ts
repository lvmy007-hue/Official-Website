import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecretBoxService } from '../../platform/security/secret-box.service'
import { createTestApp, sessionStub } from '../../testing/harness'

// 个人信息统一出口 POST /pii/reveal（P6-14）：权限先于校验、理由必填、字段按对象限定、解密后先写审计才返回、没有内容如实说明。
// 内存替身只验证接口的参数、权限与审计分支；真实库的跨企业隔离、迁移与存量加密在 pii.db.test.ts。

const PURCHASE = new Date('2026-10-20T10:00:00Z')
const FUTURE = new Date(Date.now() + 86_400_000)
const PAST = new Date(Date.now() - 1000)
const reason = '客户来电核对收货信息'

const orderHeader = {
  id: 'o1',
  sellerAccountId: 's1',
  amazonOrderId: '111-2222222-3333333',
  marketplaceId: 'ATVPDKIKX0DER',
  purchaseDate: PURCHASE,
  status: 'Shipped',
  fulfillment: 'AFN',
  fulfillmentStatus: 'Shipped',
  currency: 'USD',
  amount: '59.9',
  latestShipDate: null,
  earliestDelivery: null,
  latestDelivery: null,
  isReplacement: false,
  replacedOrderId: null,
  replacementReason: null,
  shippedAt: null,
  piiExpiresAt: FUTURE,
  programs: [],
  salesChannel: 'Amazon.com',
  sellerAccount: { displayName: '美国主店' },
}
const returnRow = { id: 'r1', sellerAccountId: 's1', amazonOrderId: '111-2222222-3333333', sellerAccount: { displayName: '美国主店' } }

function stubs(permissions: string[], over: Record<string, unknown> = {}) {
  return {
    ...sessionStub(permissions),
    order: { findFirst: vi.fn().mockResolvedValueOnce(orderHeader).mockResolvedValue({ piiCiphertext: 'iv.tag.cipher', piiExpiresAt: FUTURE }) },
    fbaReturnCase: { findFirst: vi.fn().mockResolvedValueOnce(returnRow).mockResolvedValue({ customerCommentsCipher: 'iv.tag.comment', customerCommentsExpiresAt: FUTURE }) },
    supportContact: { findFirst: vi.fn().mockResolvedValue({ id: 'c1', sellerAccountId: 's1', body: '请联系 13812345678 寄到 12 Main Street', supportCase: { caseId: '1234567' } }) },
    ...over,
  }
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})

const reveal = (body: unknown) => harness!.call('POST', '/pii/reveal', { body })
const audits = () => harness!.writeGuardStubs.auditEvent.create.mock.calls.map(call => call[0].data)

describe('权限与请求校验', () => {
  it('没有 field.buyer：403（先于参数校验），不解密、不查对象；被拒绝的请求留一条拒绝审计', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii')
    const prisma = stubs(['orders.read'])
    harness = await createTestApp(prisma)
    const res = await reveal({ objectType: 'ORDER', objectId: 'o1', fields: ['buyerName'], reason })
    expect(res.status).toBe(403)
    expect((await reveal({})).status).toBe(403)
    expect(open).not.toHaveBeenCalled()
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
    expect(audits().find(item => item.action === 'PII_REVEALED')).toMatchObject({ result: 'DENIED', resourceType: 'PiiObject' })
  })

  it('未登录 401', async () => {
    harness = await createTestApp(stubs(['field.buyer']))
    expect((await harness.call('POST', '/pii/reveal', { auth: false, body: {} })).status).toBe(401)
  })

  it('请求不合格：422，不解密、不查对象', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii')
    const prisma = stubs(['orders.read', 'returns.read', 'field.buyer'])
    harness = await createTestApp(prisma)
    const base = { objectType: 'ORDER', objectId: 'o1', fields: ['buyerName'], reason }
    const bad: unknown[] = [
      {},
      { ...base, reason: '' },
      { ...base, reason: ' ' },
      { ...base, reason: '好' },
      { ...base, reason: 'x'.repeat(501) },
      { ...base, fields: [] },
      { ...base, fields: ['buyerName', 'buyerName'] },
      { ...base, fields: ['customerComments'] }, // 字段不属于订单
      { ...base, fields: ['piiCiphertext'] },
      { ...base, objectType: 'RETURN' }, // buyerName 不属于退货
      { ...base, objectType: 'NOPE' },
      { ...base, objectId: 'bad id!' },
      { ...base, extra: 1 },
    ]
    for (const body of bad) expect((await reveal(body)).status, JSON.stringify(body)).toBe(422)
    expect(open).not.toHaveBeenCalled()
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
  })

  it('有 field.buyer 但没有对象所属功能的读权限：403，不解密', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii')
    const modern = (permissions: string[]) => ({
      membership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions, version: 2 }, tenant: { lifecycleStatus: 'ACTIVE' } }) },
    })
    harness = await createTestApp(stubs(['field.buyer'], modern(['field.buyer'])))
    for (const [objectType, field] of [
      ['ORDER', 'buyerName'],
      ['RETURN', 'customerComments'],
      ['SUPPORT_CONTACT', 'body'],
    ]) {
      expect((await reveal({ objectType, objectId: 'x1', fields: [field], reason })).status, objectType).toBe(403)
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('对象不存在或不在数据范围内：404（三类对象一致）', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii')
    harness = await createTestApp(
      stubs(['orders.read', 'returns.read', 'support.read', 'field.buyer'], {
        order: { findFirst: vi.fn().mockResolvedValue(null) },
        fbaReturnCase: { findFirst: vi.fn().mockResolvedValue(null) },
        supportContact: { findFirst: vi.fn().mockResolvedValue(null) },
      }),
    )
    for (const [objectType, field] of [
      ['ORDER', 'buyerName'],
      ['RETURN', 'customerComments'],
      ['SUPPORT_CONTACT', 'body'],
    ]) {
      const res = await reveal({ objectType, objectId: 'nope', fields: [field], reason })
      expect(res.status, objectType).toBe(404)
      expect(JSON.stringify(res.json)).not.toMatch(/nope.*存在|租户/)
    }
    expect(open).not.toHaveBeenCalled()
  })
})

describe('订单买家信息', () => {
  const order = { objectType: 'ORDER', objectId: 'o1', fields: ['buyerName', 'buyerEmail', 'buyerPhone', 'city'], reason }

  it('成功：解密后先写审计（理由、订单号、字段名，不含明文）再返回；只返回请求的字段；明文不进幂等记录', async () => {
    const open = vi
      .spyOn(SecretBoxService.prototype, 'openBuyerPii')
      .mockResolvedValue(JSON.stringify({ buyerName: 'Alice Buyer', buyerEmail: 'alice@example.com', city: 'Seattle', addressLine1: '1 Pike St', country: 'US' }))
    harness = await createTestApp(stubs(['orders.read', 'field.buyer']))
    const res = await reveal(order)
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      objectType: 'ORDER',
      objectId: 'o1',
      state: 'OK',
      values: { buyerName: 'Alice Buyer', buyerEmail: 'alice@example.com', buyerPhone: null, city: 'Seattle' },
      note: null,
    })
    expect(Object.keys(res.json.data.values).sort()).toEqual(['buyerEmail', 'buyerName', 'buyerPhone', 'city'])
    expect(open).toHaveBeenCalledWith('iv.tag.cipher')
    const viewed = audits().find(item => item.action === 'PII_REVEALED')
    expect(viewed).toMatchObject({ resourceType: 'Order', resourceId: 'o1', reason, result: 'SUCCEEDED' })
    expect(viewed?.detail).toMatchObject({ amazonOrderId: '111-2222222-3333333', storeId: 's1', outcome: 'OK', fields: ['buyerName', 'buyerEmail', 'city'] })
    expect(JSON.stringify(audits())).not.toMatch(/Alice|alice@example|Seattle|Pike/)
    expect(JSON.stringify(harness.writeGuardStubs.idempotencyRecord.update.mock.calls)).not.toMatch(/Alice|alice@example|Seattle/)
    // 展示截止时间在保留期之内，且约为 60 秒后
    const until = new Date(res.json.data.expiresAt).getTime()
    expect(until).toBeGreaterThan(Date.now())
    expect(until).toBeLessThanOrEqual(Date.now() + 61_000)
  })

  it('审计写不进去：不返回明文', async () => {
    vi.spyOn(SecretBoxService.prototype, 'openBuyerPii').mockResolvedValue(JSON.stringify({ buyerName: 'Alice Buyer' }))
    harness = await createTestApp(stubs(['orders.read', 'field.buyer']))
    harness.writeGuardStubs.auditEvent.create.mockRejectedValue(new Error('db down'))
    const res = await reveal(order)
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(res.json)).not.toContain('Alice')
  })

  it('已过保留期或从未同步：如实说明，不解密，也留审计', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii')
    const stored = (value: unknown) => ({ order: { findFirst: vi.fn().mockResolvedValueOnce(orderHeader).mockResolvedValue(value) } })
    harness = await createTestApp(stubs(['orders.read', 'field.buyer'], stored({ piiCiphertext: 'iv.tag.cipher', piiExpiresAt: PAST })))
    expect((await reveal(order)).json.data).toMatchObject({ state: 'EXPIRED', values: {}, expiresAt: null })
    await harness.close()
    harness = await createTestApp(stubs(['orders.read', 'field.buyer'], stored({ piiCiphertext: null, piiExpiresAt: null })))
    expect((await reveal(order)).json.data).toMatchObject({ state: 'NOT_SYNCED', values: {}, retainedUntil: null })
    expect(audits().find(item => item.action === 'PII_REVEALED')?.detail).toMatchObject({ outcome: 'NOT_SYNCED' })
    expect(open).not.toHaveBeenCalled()
  })

  it('请求的字段订单里都没有内容：说明为没有内容，不返回空壳', async () => {
    vi.spyOn(SecretBoxService.prototype, 'openBuyerPii').mockResolvedValue(JSON.stringify({ country: 'US' }))
    harness = await createTestApp(stubs(['orders.read', 'field.buyer']))
    expect((await reveal({ ...order, fields: ['buyerPhone'] })).json.data).toMatchObject({ state: 'NOT_SYNCED', values: {} })
  })
})

describe('退货买家备注与支持案件正文', () => {
  it('退货备注：与订单同一解密入口；整段文本作为 customerComments 返回；审计只记字段名', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii').mockResolvedValue('包装破损，电话 13800000000')
    harness = await createTestApp(stubs(['returns.read', 'field.buyer']))
    const res = await reveal({ objectType: 'RETURN', objectId: 'r1', fields: ['customerComments'], reason })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'OK', values: { customerComments: '包装破损，电话 13800000000' } })
    expect(open).toHaveBeenCalledWith('iv.tag.comment')
    const viewed = audits().find(item => item.action === 'PII_REVEALED')
    expect(viewed).toMatchObject({ resourceType: 'FbaReturnCase', resourceId: 'r1', result: 'SUCCEEDED' })
    expect(viewed?.detail).toMatchObject({ fields: ['customerComments'], amazonOrderId: '111-2222222-3333333' })
    expect(JSON.stringify(audits())).not.toMatch(/13800000000|包装破损/)
  })

  it('退货备注已过保留期（后台任务还没清除）或没有备注：不解密', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii')
    const stored = (value: unknown) => ({ fbaReturnCase: { findFirst: vi.fn().mockResolvedValueOnce(returnRow).mockResolvedValue(value) } })
    const body = { objectType: 'RETURN', objectId: 'r1', fields: ['customerComments'], reason }
    harness = await createTestApp(stubs(['returns.read', 'field.buyer'], stored({ customerCommentsCipher: 'iv.tag.comment', customerCommentsExpiresAt: PAST })))
    expect((await reveal(body)).json.data).toMatchObject({ state: 'EXPIRED', values: {} })
    await harness.close()
    harness = await createTestApp(stubs(['returns.read', 'field.buyer'], stored({ customerCommentsCipher: null, customerCommentsExpiresAt: null })))
    expect((await reveal(body)).json.data).toMatchObject({ state: 'NOT_SYNCED', values: {} })
    expect(open).not.toHaveBeenCalled()
  })

  it('支持案件正文：不解密（正文按原文保存），完整正文只经这里返回并留审计', async () => {
    const open = vi.spyOn(SecretBoxService.prototype, 'openBuyerPii')
    harness = await createTestApp(stubs(['support.read', 'field.buyer']))
    const res = await reveal({ objectType: 'SUPPORT_CONTACT', objectId: 'c1', fields: ['body'], reason })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'OK', values: { body: '请联系 13812345678 寄到 12 Main Street' }, retainedUntil: null })
    expect(open).not.toHaveBeenCalled()
    const viewed = audits().find(item => item.action === 'PII_REVEALED')
    expect(viewed).toMatchObject({ resourceType: 'SupportContact', resourceId: 'c1' })
    expect(viewed?.detail).toMatchObject({ caseId: '1234567', fields: ['body'] })
    expect(JSON.stringify(audits())).not.toMatch(/13812345678|Main Street/)
  })
})
